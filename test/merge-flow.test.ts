import { describe, test, expect, beforeEach } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { executeTeamShutdown } from "../src/tools/team-shutdown"
import { executeTeamMerge } from "../src/tools/team-merge"
import { executeTeamCleanup } from "../src/tools/team-cleanup"
import { executeTeamSpawn } from "../src/tools/team-spawn"
import { executeTeamCreate } from "../src/tools/team-create"
import { getTeamResourceParts, preserveBranch, preservedBranchName } from "../src/tools/merge-helper"
import type { MergeBranchFn, DeleteBranchFn, PreserveBranchFn, OverlapCheckFn } from "../src/tools/merge-helper"
import { spawnFailures } from "../src/tools/team-spawn"

type Deps = ReturnType<typeof setupDeps>

const noopPreserve: PreserveBranchFn = async () => true
const noopMerge: MergeBranchFn = async () => ({ ok: true })
const noopDelete: DeleteBranchFn = async () => true
const noopOverlap: OverlapCheckFn = async () => []
const failMerge: MergeBranchFn = async () => ({ ok: false, error: "CONFLICT in file.ts" })

async function git(cwd: string, args: string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(stderr.trim() || `git ${args.join(" ")} failed`)
  return stdout.trim()
}

async function commitFile(repo: string, name: string, content: string): Promise<void> {
  await writeFile(path.join(repo, name), content)
  await git(repo, ["add", name])
  await git(repo, ["-c", "user.name=Ensemble Test", "-c", "user.email=ensemble@example.com", "commit", "-m", content])
}

function teamId(deps: Deps, name: string): string {
  return (deps.db.query("SELECT id FROM team WHERE name = ?").get(name) as { id: string }).id
}

function preservedFor(deps: Deps, teamName: string, memberName: string): string {
  const resource = getTeamResourceParts(deps.db, teamId(deps, teamName))
  return preservedBranchName(resource.projectName, resource.teamName, resource.teamId, memberName)
}

// ─── Branch preservation on shutdown ───

describe("branch preservation", () => {
  let deps: Deps
  const lead = "lead-sess"

  beforeEach(() => {
    deps = setupDeps()
    spawnFailures.clear()
  })

  test("shutdown preserves worktree branch before aborting session", async () => {
    await executeTeamCreate(deps, { name: "preserve-test" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)

    // Verify alice has a worktree branch
    const before = deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'")
      .get() as { worktree_branch: string | null }
    expect(before.worktree_branch).toBeTruthy()
    const originalBranch = before.worktree_branch!

    // Track what preserve was called with
    let preserveCalled = false
    let preserveSource = ""
    let preserveTarget = ""
    const trackPreserve: PreserveBranchFn = async (src, target) => {
      preserveCalled = true
      preserveSource = src
      preserveTarget = target
      return true
    }

    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, trackPreserve)

    // Preserve was called with the original branch
    expect(preserveCalled).toBe(true)
    expect(preserveSource).toBe(originalBranch)
    const preserved = preservedFor(deps, "preserve-test", "alice")
    expect(preserveTarget).toBe(preserved)

    // DB was updated to the preserved branch name
    const after = deps.db.query("SELECT worktree_branch, status FROM team_member WHERE name = 'alice'")
      .get() as { worktree_branch: string | null; status: string }
    expect(after.worktree_branch).toBe(preserved)
    expect(after.status).toBe("shutdown")
  })

  test("shutdown does not abort or change the member when preserve fails", async () => {
    await executeTeamCreate(deps, { name: "fail-preserve" }, lead)
    await executeTeamSpawn(deps, { name: "bob", agent: "build", prompt: "task" }, lead)

    const failPreserve: PreserveBranchFn = async () => false

    const before = deps.db.query("SELECT status, worktree_branch FROM team_member WHERE name = 'bob'")
      .get() as { status: string; worktree_branch: string }

    await expect(executeTeamShutdown(deps, { member: "bob" }, lead, undefined, failPreserve))
      .rejects.toThrow("preserve")

    expect(deps.client.calls.filter(call => call.method === "session.abort")).toHaveLength(0)
    const after = deps.db.query("SELECT status, worktree_branch FROM team_member WHERE name = 'bob'")
      .get() as { status: string; worktree_branch: string }
    expect(after).toEqual(before)
  })

  test("shutdown refreshes from the live source branch after an abort failure", async () => {
    await executeTeamCreate(deps, { name: "abort-retry" }, lead)
    await executeTeamSpawn(deps, { name: "erin", agent: "build", prompt: "task" }, lead)
    const before = deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'erin'")
      .get() as { worktree_branch: string }
    const preserveSources: string[] = []
    const trackPreserve: PreserveBranchFn = async source => {
      preserveSources.push(source)
      return true
    }
    let abortAttempts = 0
    deps.client.session.abort = async () => {
      abortAttempts++
      if (abortAttempts === 1) throw new Error("transport unavailable")
      return {}
    }

    await expect(executeTeamShutdown(deps, { member: "erin", force: true }, lead, undefined, trackPreserve))
      .rejects.toThrow("failed to abort")
    expect((deps.db.query("SELECT status, worktree_branch FROM team_member WHERE name = 'erin'").get() as {
      status: string
      worktree_branch: string
    })).toEqual({ status: "shutdown_requested", worktree_branch: preservedFor(deps, "abort-retry", "erin") })

    await executeTeamShutdown(
      deps,
      { member: "erin", force: true },
      lead,
      undefined,
      trackPreserve,
      undefined,
      async () => before.worktree_branch,
    )

    expect(preserveSources).toEqual([before.worktree_branch, before.worktree_branch])
    const after = deps.db.query("SELECT status, worktree_branch FROM team_member WHERE name = 'erin'")
      .get() as { status: string; worktree_branch: string }
    expect(after.status).toBe("shutdown")
    expect(after.worktree_branch).toBe(preservedFor(deps, "abort-retry", "erin"))
  })

  test("shutdown refreshes a legacy preserved record from its live worktree branch", async () => {
    await executeTeamCreate(deps, { name: "legacy-retry" }, lead)
    await executeTeamSpawn(deps, { name: "faye", agent: "build", prompt: "task" }, lead)
    const liveBranch = (deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'faye'")
      .get() as { worktree_branch: string }).worktree_branch
    const stalePreserved = preservedFor(deps, "legacy-retry", "faye")
    deps.db.run(
      "UPDATE team_member SET status = 'shutdown_requested', worktree_branch = ? WHERE name = 'faye'",
      [stalePreserved],
    )
    const preserveSources: string[] = []

    await executeTeamShutdown(
      deps,
      { member: "faye", force: true },
      lead,
      undefined,
      async source => {
        preserveSources.push(source)
        return true
      },
      undefined,
      async () => liveBranch,
    )

    expect(preserveSources).toEqual([liveBranch])
    expect((deps.db.query("SELECT status, worktree_branch FROM team_member WHERE name = 'faye'").get() as {
      status: string
      worktree_branch: string
    })).toEqual({ status: "shutdown", worktree_branch: stalePreserved })
  })

  test("shutdown without worktree branch skips preservation", async () => {
    await executeTeamCreate(deps, { name: "no-wt" }, lead)
    await executeTeamSpawn(deps, { name: "carol", agent: "explore", prompt: "task", worktree: false }, lead)

    let preserveCalled = false
    const trackPreserve: PreserveBranchFn = async () => {
      preserveCalled = true
      return true
    }

    await executeTeamShutdown(deps, { member: "carol" }, lead, undefined, trackPreserve)

    // Preserve was NOT called — no branch to preserve
    expect(preserveCalled).toBe(false)
  })

  test("preserve happens BEFORE session.abort", async () => {
    await executeTeamCreate(deps, { name: "order-test" }, lead)
    await executeTeamSpawn(deps, { name: "dave", agent: "build", prompt: "task" }, lead)

    const callOrder: string[] = []
    const trackPreserve: PreserveBranchFn = async () => {
      callOrder.push("preserve")
      return true
    }

    // Override session.abort to track call order
    const origAbort = deps.client.session.abort
    deps.client.session.abort = async (args) => {
      callOrder.push("abort")
      return origAbort(args)
    }

    await executeTeamShutdown(deps, { member: "dave" }, lead, undefined, trackPreserve)

    // Preserve MUST happen before abort
    expect(callOrder).toEqual(["preserve", "abort"])
  })

  test("force shutdown also preserves branch", async () => {
    await executeTeamCreate(deps, { name: "force-test" }, lead)
    await executeTeamSpawn(deps, { name: "eve", agent: "build", prompt: "task" }, lead)

    let preserveCalled = false
    const trackPreserve: PreserveBranchFn = async () => {
      preserveCalled = true
      return true
    }

    await executeTeamShutdown(deps, { member: "eve", force: true }, lead, undefined, trackPreserve)
    expect(preserveCalled).toBe(true)
  })

  test("force shutdown refreshes the original branch after graceful shutdown", async () => {
    await executeTeamCreate(deps, { name: "refresh-test" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    deps.client.session.status = async () => ({ data: { [(deps.db.query("SELECT session_id FROM team_member WHERE name = 'alice'").get() as { session_id: string }).session_id]: { type: "busy" } } })

    const original = (deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'").get() as { worktree_branch: string }).worktree_branch
    const preserved = preservedFor(deps, "refresh-test", "alice")
    const snapshots: Array<{ source: string; target: string }> = []
    const trackPreserve: PreserveBranchFn = async (source, target) => {
      snapshots.push({ source, target })
      return true
    }

    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, trackPreserve)
    expect((deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'").get() as { worktree_branch: string }).worktree_branch).toBe(original)

    await executeTeamShutdown(deps, { member: "alice", force: true }, lead, undefined, trackPreserve)
    expect(snapshots).toEqual([
      { source: original, target: preserved },
      { source: original, target: preserved },
    ])
    expect((deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'").get() as { worktree_branch: string }).worktree_branch).toBe(preserved)
  })

  test("preservedBranchName generates correct format", () => {
    expect(preservedBranchName("silver-river", "my-team", "team_abc123", "alice")).toBe("ensemble/preserved/silver-river/my-team#abc123/alice")
    expect(preservedBranchName("copper-orbit", "refactor", "t1", "bob")).toBe("ensemble/preserved/copper-orbit/refactor#t1/bob")
  })
})

describe("preserveBranch", () => {
  test("refreshes an existing preserved ref to include a later commit", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "ensemble-preserve-"))
    try {
      await git(repo, ["init", "-b", "main"])
      await commitFile(repo, "work.txt", "base")
      await git(repo, ["branch", "agent-work"])
      expect(await preserveBranch("agent-work", "ensemble/preserved/project/team/member", repo)).toBe(true)

      await git(repo, ["checkout", "agent-work"])
      await commitFile(repo, "work.txt", "later")
      expect(await preserveBranch("agent-work", "ensemble/preserved/project/team/member", repo)).toBe(true)

      expect(await git(repo, ["rev-parse", "agent-work"])).toBe(await git(repo, ["rev-parse", "ensemble/preserved/project/team/member"]))
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("does not overwrite a divergent ref in the preserved namespace", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "ensemble-preserve-diverged-"))
    try {
      await git(repo, ["init", "-b", "main"])
      await commitFile(repo, "base.txt", "base")
      await git(repo, ["checkout", "-b", "agent-work"])
      await commitFile(repo, "agent.txt", "agent")
      await git(repo, ["checkout", "main"])
      await git(repo, ["checkout", "-b", "ensemble/preserved/project/team/member"])
      await commitFile(repo, "other.txt", "other")
      const before = await git(repo, ["rev-parse", "ensemble/preserved/project/team/member"])

      expect(await preserveBranch("agent-work", "ensemble/preserved/project/team/member", repo)).toBe(false)
      expect(await git(repo, ["rev-parse", "ensemble/preserved/project/team/member"])).toBe(before)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

// ─── team_merge tool ───

describe("team_merge", () => {
  let deps: Deps
  const lead = "lead-sess"

  beforeEach(() => {
    deps = setupDeps()
    spawnFailures.clear()
  })

  test("merges a shutdown member's preserved branch", async () => {
    await executeTeamCreate(deps, { name: "merge-team" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    const result = await executeTeamMerge(deps, { member: "alice" }, lead, noopMerge, noopDelete, noopOverlap)
    expect(result).toContain("Merged alice's changes")
    expect(result).toContain("unstaged")
    expect(result).toContain("git diff")
  })

  test("clears worktree_branch in DB after successful merge", async () => {
    await executeTeamCreate(deps, { name: "clear-branch" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    await executeTeamMerge(deps, { member: "alice" }, lead, noopMerge, noopDelete, noopOverlap)

    const after = deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'")
      .get() as { worktree_branch: string | null }
    expect(after.worktree_branch).toBeNull()
  })

  test("deletes the preserved branch after merge", async () => {
    await executeTeamCreate(deps, { name: "del-branch" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    let deletedBranch = ""
    const trackDelete: DeleteBranchFn = async (branch) => {
      deletedBranch = branch
      return true
    }

    await executeTeamMerge(deps, { member: "alice" }, lead, noopMerge, trackDelete, noopOverlap)
    expect(deletedBranch).toBe(preservedFor(deps, "del-branch", "alice"))
  })

  test("does not reapply a successful merge when branch deletion fails", async () => {
    await executeTeamCreate(deps, { name: "delete-retry" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)
    let mergeCalls = 0
    const mergeOnce: MergeBranchFn = async () => {
      mergeCalls++
      return { ok: true }
    }

    const first = await executeTeamMerge(deps, { member: "alice" }, lead, mergeOnce, async () => false, noopOverlap)
    const second = await executeTeamMerge(deps, { member: "alice" }, lead, mergeOnce, noopDelete, noopOverlap)

    expect(first).toContain("will not be merged twice")
    expect(second).toContain("already merged")
    expect(mergeCalls).toBe(1)
  })

  test("does not reapply an external merge when merge.completed event insertion fails", async () => {
    await executeTeamCreate(deps, { name: "event-fault" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)
    deps.db.exec("CREATE TRIGGER reject_merge_completed BEFORE INSERT ON team_event WHEN NEW.kind = 'merge.completed' BEGIN SELECT RAISE(ABORT, 'merge completion event rejected'); END")
    let mergeCalls = 0
    const mergeOnce: MergeBranchFn = async () => {
      mergeCalls++
      return { ok: true }
    }

    await expect(executeTeamMerge(deps, { member: "alice" }, lead, mergeOnce, noopDelete, noopOverlap))
      .rejects.toThrow("merge completion event rejected")
    expect(deps.db.query("SELECT merge_state FROM team_member WHERE name = 'alice'").get()).toEqual({ merge_state: "merging" })

    const retry = await executeTeamMerge(deps, { member: "alice" }, lead, mergeOnce, noopDelete, noopOverlap)
    expect(retry).toContain("already started")
    expect(mergeCalls).toBe(1)

    const cleanup = await executeTeamCleanup(deps, { force: false }, lead, undefined, mergeOnce, noopDelete, true, noopOverlap)
    expect(cleanup).toContain("Inspect git diff")
    expect(deps.db.query("SELECT status FROM team WHERE name = 'event-fault'").get()).toEqual({ status: "active" })
    expect(mergeCalls).toBe(1)
  })

  test("rejects merge for active (non-shutdown) member", async () => {
    await executeTeamCreate(deps, { name: "active-merge" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)

    await expect(executeTeamMerge(deps, { member: "alice" }, lead, noopMerge, noopDelete, noopOverlap))
      .rejects.toThrow("still active")
  })

  test("treats merge for member with no branch as an idempotent no-op", async () => {
    await executeTeamCreate(deps, { name: "no-branch" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "explore", prompt: "task", worktree: false }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    const result = await executeTeamMerge(deps, { member: "alice" }, lead, noopMerge, noopDelete, noopOverlap)
    expect(result).toContain("No branch to merge")
  })

  test("treats merge for already-merged member as an idempotent no-op", async () => {
    await executeTeamCreate(deps, { name: "double-merge" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    // First merge succeeds
    await executeTeamMerge(deps, { member: "alice" }, lead, noopMerge, noopDelete, noopOverlap)

    const result = await executeTeamMerge(deps, { member: "alice" }, lead, noopMerge, noopDelete, noopOverlap)
    expect(result).toContain("No branch to merge")
  })

  test("returns conflict message on merge failure", async () => {
    await executeTeamCreate(deps, { name: "conflict-merge" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    const result = await executeTeamMerge(deps, { member: "alice" }, lead, failMerge, noopDelete, noopOverlap)
    expect(result).toContain("Merge conflict")
    expect(result).toContain("CONFLICT")

    // Branch is NOT cleared on conflict — user can retry
    const after = deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'")
      .get() as { worktree_branch: string | null }
    expect(after.worktree_branch).not.toBeNull()
  })

  test("rejects merge from non-lead", async () => {
    await executeTeamCreate(deps, { name: "non-lead" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)

    const aliceSess = (deps.db.query("SELECT session_id FROM team_member WHERE name = 'alice'")
      .get() as { session_id: string }).session_id

    await expect(executeTeamMerge(deps, { member: "alice" }, aliceSess, noopMerge, noopDelete, noopOverlap))
      .rejects.toThrow()
  })

  test("blocks merge when lead has overlapping local changes", async () => {
    await executeTeamCreate(deps, { name: "overlap-test" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    const overlapFiles: OverlapCheckFn = async () => ["config.py", "conftest.py"]
    let mergeCalled = false
    const trackMerge: MergeBranchFn = async () => { mergeCalled = true; return { ok: true } }

    const result = await executeTeamMerge(deps, { member: "alice" }, lead, trackMerge, noopDelete, overlapFiles)
    expect(result).toContain("config.py")
    expect(result).toContain("conftest.py")
    expect(result).toContain("local changes")
    expect(mergeCalled).toBe(false)

    // Branch is preserved for retry — NOT cleared
    const after = deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'")
      .get() as { worktree_branch: string | null }
    expect(after.worktree_branch).not.toBeNull()
  })

  test("proceeds with merge when no overlapping files", async () => {
    await executeTeamCreate(deps, { name: "no-overlap" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    let mergeCalled = false
    const trackMerge: MergeBranchFn = async () => { mergeCalled = true; return { ok: true } }

    const result = await executeTeamMerge(deps, { member: "alice" }, lead, trackMerge, noopDelete, noopOverlap)
    expect(mergeCalled).toBe(true)
    expect(result).toContain("Merged alice's changes")
  })

  test("merge output is clear and actionable", async () => {
    await executeTeamCreate(deps, { name: "msg-test" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    const result = await executeTeamMerge(deps, { member: "alice" }, lead, noopMerge, noopDelete, noopOverlap)
    expect(result).toContain("Merged alice's changes into your working directory (unstaged)")
    expect(result).toContain("git diff")
  })

  test("blocks merge when overlap check fails", async () => {
    await executeTeamCreate(deps, { name: "overlap-err" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    const failingOverlap: OverlapCheckFn = async () => { throw new Error("git diff failed") }
    let mergeCalled = false
    const trackMerge: MergeBranchFn = async () => { mergeCalled = true; return { ok: true } }

    const result = await executeTeamMerge(deps, { member: "alice" }, lead, trackMerge, noopDelete, failingOverlap)
    expect(mergeCalled).toBe(false)
    expect(result).toContain("Cannot verify merge safety")
    expect(deps.db.query("SELECT merge_state FROM team_member WHERE name = 'alice'").get())
      .toEqual({ merge_state: "none" })
  })
})

// ─── Cleanup merge verification ───

describe("cleanup requires explicit merge verification", () => {
  let deps: Deps
  const lead = "lead-sess"

  beforeEach(() => {
    deps = setupDeps()
    spawnFailures.clear()
  })

  test("cleanup retains an unmerged writer branch and all member resources", async () => {
    await executeTeamCreate(deps, { name: "explicit-merge" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)
    deps.db.run("UPDATE team_member SET workspace_id = 'ws-alice' WHERE name = 'alice'")
    let mergeCalls = 0
    let deleteCalls = 0
    let overlapCalls = 0

    const result = await executeTeamCleanup(
      deps,
      { force: false },
      lead,
      undefined,
      async () => {
        mergeCalls++
        return { ok: true }
      },
      async () => {
        deleteCalls++
        return true
      },
      true,
      async () => {
        overlapCalls++
        return ["overlap.ts"]
      },
    )

    expect(result).toContain("not cleaned up")
    expect(result).toContain("team_merge")
    expect(result).toContain("alice")
    expect(result).toContain(preservedFor(deps, "explicit-merge", "alice"))
    expect(mergeCalls).toBe(0)
    expect(deleteCalls).toBe(0)
    expect(overlapCalls).toBe(0)
    expect(deps.client.calls.filter(call => call.method === "worktree.remove")).toHaveLength(0)
    expect(deps.client.calls.filter(call => call.method === "workspace.remove")).toHaveLength(0)
    expect(deps.db.query("SELECT status FROM team WHERE name = 'explicit-merge'").get()).toEqual({ status: "active" })
    expect(deps.db.query("SELECT worktree_branch, workspace_id FROM team_member WHERE name = 'alice'").get()).toEqual({
      worktree_branch: preservedFor(deps, "explicit-merge", "alice"),
      workspace_id: "ws-alice",
    })
  })

  test("repeated cleanup remains non-mutating until the writer is explicitly merged", async () => {
    await executeTeamCreate(deps, { name: "cleanup-retry" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)
    const before = deps.db.query("SELECT worktree_branch, merge_state FROM team_member WHERE name = 'alice'").get()

    const first = await executeTeamCleanup(deps, { force: false }, lead, undefined, noopMerge, noopDelete, true, noopOverlap)
    const second = await executeTeamCleanup(deps, { force: false }, lead, undefined, noopMerge, noopDelete, false, noopOverlap)

    expect(second).toBe(first)
    expect(deps.db.query("SELECT worktree_branch, merge_state FROM team_member WHERE name = 'alice'").get()).toEqual(before)
    expect(deps.db.query("SELECT status FROM team WHERE name = 'cleanup-retry'").get()).toEqual({ status: "active" })
  })

  test("cleanup distinguishes interrupted integration from a branch awaiting team_merge", async () => {
    await executeTeamCreate(deps, { name: "merge-interrupted" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamSpawn(deps, { name: "bob", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)
    await executeTeamShutdown(deps, { member: "bob" }, lead, undefined, noopPreserve)
    deps.db.run("UPDATE team_member SET merge_state = 'merging' WHERE name = 'bob'")

    const result = await executeTeamCleanup(deps, { force: false }, lead, undefined, noopMerge, noopDelete, true, noopOverlap)

    expect(result).toContain("team_merge")
    expect(result).toContain("alice")
    expect(result).toContain("Inspect git diff")
    expect(result).toContain("bob")
    expect(result).toContain("verify")
    expect(deps.db.query("SELECT status FROM team WHERE name = 'merge-interrupted'").get()).toEqual({ status: "active" })
  })

  test("force cleanup settles the member after preserve and abort but retains unmerged resources", async () => {
    await executeTeamCreate(deps, { name: "force-explicit-merge" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    deps.db.run("UPDATE team_member SET workspace_id = 'ws-alice' WHERE name = 'alice'")
    const originalBranch = (deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'").get() as {
      worktree_branch: string
    }).worktree_branch
    const calls: string[] = []
    deps.client.session.abort = async () => {
      calls.push("abort")
      return {}
    }

    const result = await executeTeamCleanup(
      deps,
      { force: true },
      lead,
      undefined,
      noopMerge,
      noopDelete,
      true,
      noopOverlap,
      undefined,
      undefined,
      undefined,
      async (source, target) => {
        calls.push(`preserve:${source}:${target}`)
        return true
      },
    )

    const preserved = preservedFor(deps, "force-explicit-merge", "alice")
    expect(calls).toEqual([`preserve:${originalBranch}:${preserved}`, "abort"])
    expect(result).toContain("not cleaned up")
    expect(result).toContain("team_merge")
    expect(deps.db.query("SELECT status, execution_status, worktree_branch, workspace_id FROM team_member WHERE name = 'alice'").get()).toEqual({
      status: "shutdown",
      execution_status: "idle",
      worktree_branch: preserved,
      workspace_id: "ws-alice",
    })
    expect(deps.client.calls.filter(call => call.method === "worktree.remove")).toHaveLength(0)
    expect(deps.client.calls.filter(call => call.method === "workspace.remove")).toHaveLength(0)
    expect(deps.db.query("SELECT status FROM team WHERE name = 'force-explicit-merge'").get()).toEqual({ status: "active" })
  })

  test("cleanup succeeds after every writer has been explicitly merged", async () => {
    await executeTeamCreate(deps, { name: "already-merged" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)
    await executeTeamMerge(deps, { member: "alice" }, lead, noopMerge, noopDelete, noopOverlap)
    let mergeCalled = false
    const trackMerge: MergeBranchFn = async () => {
      mergeCalled = true
      return { ok: true }
    }

    const result = await executeTeamCleanup(deps, { force: false }, lead, undefined, trackMerge, noopDelete, true, noopOverlap)
    expect(result).toContain("cleaned up")
    expect(mergeCalled).toBe(false)
  })

  test("cleanup does not reapply an explicit merge when branch deletion previously failed", async () => {
    await executeTeamCreate(deps, { name: "delete-failed" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)
    await executeTeamMerge(deps, { member: "alice" }, lead, noopMerge, async () => false, noopOverlap)
    let mergeCalls = 0

    const result = await executeTeamCleanup(
      deps,
      { force: false },
      lead,
      undefined,
      async () => {
        mergeCalls++
        return { ok: true }
      },
      noopDelete,
      true,
      noopOverlap,
    )

    expect(result).toContain("cleaned up")
    expect(mergeCalls).toBe(0)
  })

  test("mergeOnCleanup=false cannot bypass explicit merge verification", async () => {
    await executeTeamCreate(deps, { name: "no-safety" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)

    let mergeCalled = false
    const trackMerge: MergeBranchFn = async () => {
      mergeCalled = true
      return { ok: true }
    }

    const result = await executeTeamCleanup(deps, { force: false }, lead, undefined, trackMerge, noopDelete, false, noopOverlap)
    expect(result).toContain("team_merge")
    expect(mergeCalled).toBe(false)
    expect(deps.db.query("SELECT status FROM team WHERE name = 'no-safety'").get()).toEqual({ status: "active" })
  })

  test("cleanup does not remove explicitly merged resources while another writer remains unmerged", async () => {
    await executeTeamCreate(deps, { name: "mixed-merge" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "task" }, lead)
    await executeTeamSpawn(deps, { name: "bob", agent: "build", prompt: "task" }, lead)
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)
    await executeTeamShutdown(deps, { member: "bob" }, lead, undefined, noopPreserve)

    await executeTeamMerge(deps, { member: "alice" }, lead, noopMerge, async () => false, noopOverlap)

    const result = await executeTeamCleanup(deps, { force: false }, lead, undefined, noopMerge, noopDelete, true, noopOverlap)
    expect(result).toContain("bob")
    expect(deps.db.query("SELECT worktree_branch, merge_state FROM team_member WHERE name = 'alice'").get()).toEqual({
      worktree_branch: preservedFor(deps, "mixed-merge", "alice"),
      merge_state: "merged",
    })
    expect(deps.client.calls.filter(call => call.method === "worktree.remove")).toHaveLength(0)
    expect(deps.db.query("SELECT status FROM team WHERE name = 'mixed-merge'").get()).toEqual({ status: "active" })
  })
})

// ─── Full lifecycle: spawn → shutdown → merge → cleanup ───

describe("full merge lifecycle", () => {
  let deps: Deps
  const lead = "lead-sess"

  beforeEach(() => {
    deps = setupDeps()
    spawnFailures.clear()
  })

  test("spawn → shutdown (preserves) → merge → cleanup (nothing left)", async () => {
    // 1. Create team and spawn
    await executeTeamCreate(deps, { name: "lifecycle" }, lead)
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "implement auth" }, lead)
    await executeTeamSpawn(deps, { name: "bob", agent: "build", prompt: "write tests" }, lead)

    // 2. Shutdown both — branches preserved
    await executeTeamShutdown(deps, { member: "alice" }, lead, undefined, noopPreserve)
    await executeTeamShutdown(deps, { member: "bob" }, lead, undefined, noopPreserve)

    // Verify branches are preserved
    const aliceBranch = (deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'")
      .get() as { worktree_branch: string }).worktree_branch
    const bobBranch = (deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'bob'")
      .get() as { worktree_branch: string }).worktree_branch
    expect(aliceBranch).toBe(preservedFor(deps, "lifecycle", "alice"))
    expect(bobBranch).toBe(preservedFor(deps, "lifecycle", "bob"))

    // 3. Merge both explicitly
    await executeTeamMerge(deps, { member: "alice" }, lead, noopMerge, noopDelete, noopOverlap)
    await executeTeamMerge(deps, { member: "bob" }, lead, noopMerge, noopDelete, noopOverlap)

    // Verify branches are cleared
    const aliceAfter = (deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'")
      .get() as { worktree_branch: string | null }).worktree_branch
    const bobAfter = (deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'bob'")
      .get() as { worktree_branch: string | null }).worktree_branch
    expect(aliceAfter).toBeNull()
    expect(bobAfter).toBeNull()

    // 4. Cleanup — nothing to merge
    let mergeCalled = false
    const trackMerge: MergeBranchFn = async () => {
      mergeCalled = true
      return { ok: true }
    }

    const result = await executeTeamCleanup(deps, { force: false }, lead, undefined, trackMerge, noopDelete, true, noopOverlap)
    expect(result).toContain("cleaned up")
    expect(result).not.toContain("Safety-net")
    expect(mergeCalled).toBe(false)

    // Team is archived
    const team = deps.db.query("SELECT status FROM team WHERE name = 'lifecycle'")
      .get() as { status: string }
    expect(team.status).toBe("archived")
  })
})
