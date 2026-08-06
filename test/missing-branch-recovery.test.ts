import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { executeTeamCleanup } from "../src/tools/team-cleanup"
import { deleteBranch, verifyFailedWriterEvidence, verifySourceAlreadyIntegrated } from "../src/tools/merge-helper"
import { executeTeamMerge } from "../src/tools/team-merge"
import { insertMember, insertTeam, setupDeps } from "./helpers"

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

async function commitFile(repo: string, name: string, content: string): Promise<string> {
  await writeFile(path.join(repo, name), content)
  await git(repo, ["add", name])
  await git(repo, ["-c", "user.name=Ensemble Test", "-c", "user.email=ensemble@example.com", "commit", "-m", content])
  return git(repo, ["rev-parse", "HEAD"])
}

async function createRepository(): Promise<{ repo: string; identity: string; baseline: string }> {
  const repo = await mkdtemp(path.join(tmpdir(), "ensemble-missing-branch-"))
  await git(repo, ["init", "-b", "main"])
  const baseline = await commitFile(repo, "base.txt", "base")
  return { repo, identity: await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), baseline }
}

function evidenceInput(repository: { repo: string; identity: string; baseline: string }) {
  return {
    repositoryRoot: repository.repo,
    gitIdentity: repository.identity,
    baselineOid: repository.baseline,
    sourceBranch: "writer-source",
    preservedBranch: "ensemble/preserved/project/team/writer",
    worktreeDir: null,
  }
}

describe("failed writer Git evidence", () => {
  test("settles surviving source or preserved refs only when they remain at baseline", async () => {
    for (const branch of ["writer-source", "ensemble/preserved/project/team/writer"]) {
      const repository = await createRepository()
      try {
        await git(repository.repo, ["branch", branch, repository.baseline])
        const input = evidenceInput(repository)
        if (branch === "writer-source") input.preservedBranch = "missing-preserved"
        else input.sourceBranch = "missing-source"
        expect(await verifyFailedWriterEvidence(input)).toEqual({ kind: "empty", sourceBranch: branch, sourceOid: repository.baseline })
      } finally {
        await rm(repository.repo, { recursive: true, force: true })
      }
    }
  })

  test("settles a missing ref from a clean same-repository worktree at baseline", async () => {
    const repository = await createRepository()
    try {
      await git(repository.repo, ["checkout", "-b", "writer-source", repository.baseline])
      expect(await verifyFailedWriterEvidence({
        ...evidenceInput(repository),
        preservedBranch: "missing-preserved",
        worktreeDir: repository.repo,
      })).toEqual({ kind: "empty", sourceBranch: "writer-source", sourceOid: repository.baseline })
    } finally {
      await rm(repository.repo, { recursive: true, force: true })
    }
  })

  test("selects the most advanced comparable surviving ref for merge", async () => {
    const repository = await createRepository()
    try {
      await git(repository.repo, ["branch", "writer-source", repository.baseline])
      await git(repository.repo, ["checkout", "-b", "ensemble/preserved/project/team/writer", "writer-source"])
      await commitFile(repository.repo, "writer.txt", "writer")
      await git(repository.repo, ["checkout", "main"])
      expect(await verifyFailedWriterEvidence(evidenceInput(repository))).toEqual({
        kind: "merge",
        sourceBranch: "ensemble/preserved/project/team/writer",
        sourceOid: await git(repository.repo, ["rev-parse", "ensemble/preserved/project/team/writer"]),
      })
    } finally {
      await rm(repository.repo, { recursive: true, force: true })
    }
  })

  test("accepts a clean advanced source worktree and rejects a different symbolic branch", async () => {
    const repository = await createRepository()
    try {
      await git(repository.repo, ["checkout", "-b", "writer-source", repository.baseline])
      await commitFile(repository.repo, "writer.txt", "writer")
      expect(await verifyFailedWriterEvidence({
        ...evidenceInput(repository),
        preservedBranch: "missing-preserved",
        worktreeDir: repository.repo,
      })).toEqual({
        kind: "merge",
        sourceBranch: "writer-source",
        sourceOid: await git(repository.repo, ["rev-parse", "writer-source"]),
      })

      await git(repository.repo, ["checkout", "-b", "other-branch", repository.baseline])
      expect(await verifyFailedWriterEvidence({
        ...evidenceInput(repository),
        preservedBranch: "missing-preserved",
        worktreeDir: repository.repo,
      })).toEqual({
        kind: "unverifiable",
        reason: "the live writer worktree is not attached to its immutable source branch",
      })
    } finally {
      await rm(repository.repo, { recursive: true, force: true })
    }
  })

  test("fails closed without a surviving ref or worktree and for a legacy null baseline", async () => {
    const repository = await createRepository()
    try {
      const missing = await verifyFailedWriterEvidence(evidenceInput(repository))
      expect(missing).toEqual({ kind: "unverifiable", reason: "no recorded branch ref or live baseline worktree survives" })
      expect(await verifyFailedWriterEvidence({ ...evidenceInput(repository), baselineOid: null })).toEqual(missing)
    } finally {
      await rm(repository.repo, { recursive: true, force: true })
    }
  })

  test("fails closed for dirty or untracked live worktree evidence", async () => {
    for (const [name, arrange] of [
      ["dirty", async (repo: string) => writeFile(path.join(repo, "base.txt"), "dirty")],
      ["untracked", async (repo: string) => writeFile(path.join(repo, "untracked.txt"), "untracked")],
    ] as const) {
      const repository = await createRepository()
      try {
        await arrange(repository.repo)
        const result = await verifyFailedWriterEvidence({
          ...evidenceInput(repository),
          preservedBranch: "missing-preserved",
          sourceBranch: "missing-source",
          worktreeDir: repository.repo,
        })
        expect(result, name).toEqual({ kind: "unverifiable", reason: "the live writer worktree has dirty or untracked changes" })
      } finally {
        await rm(repository.repo, { recursive: true, force: true })
      }
    }
  })

  test("fails closed for identity mismatch, non-descendance, and divergent tips", async () => {
    const repository = await createRepository()
    try {
      expect(await verifyFailedWriterEvidence({ ...evidenceInput(repository), gitIdentity: `${repository.repo}/other.git` }))
        .toEqual({ kind: "unverifiable", reason: "the Team repository Git identity no longer matches its persisted identity" })

      await git(repository.repo, ["checkout", "--orphan", "writer-source"])
      await git(repository.repo, ["rm", "-rf", "."])
      await commitFile(repository.repo, "orphan.txt", "orphan")
      await git(repository.repo, ["checkout", "main"])
      expect(await verifyFailedWriterEvidence({ ...evidenceInput(repository), preservedBranch: "missing-preserved" }))
        .toEqual({ kind: "unverifiable", reason: "candidate branch writer-source does not descend from the persisted baseline" })

      await git(repository.repo, ["branch", "-D", "writer-source"])
      await git(repository.repo, ["checkout", "-b", "writer-source", repository.baseline])
      await commitFile(repository.repo, "source.txt", "source")
      await git(repository.repo, ["checkout", "-b", "ensemble/preserved/project/team/writer", repository.baseline])
      await commitFile(repository.repo, "preserved.txt", "preserved")
      await git(repository.repo, ["checkout", "main"])
      expect(await verifyFailedWriterEvidence(evidenceInput(repository)))
        .toEqual({ kind: "unverifiable", reason: "recorded candidate branch tips have diverged" })
    } finally {
      await rm(repository.repo, { recursive: true, force: true })
    }
  })
})

describe("already-integrated Git evidence", () => {
  test("proves ancestry without touching the repository index", async () => {
    const repository = await createRepository()
    try {
      await git(repository.repo, ["checkout", "-b", "writer", repository.baseline])
      const sourceOid = await commitFile(repository.repo, "writer.txt", "writer")
      await git(repository.repo, ["checkout", "main"])
      await git(repository.repo, ["merge", "--ff-only", "writer"])
      const beforeIndex = await git(repository.repo, ["write-tree"])

      expect(await verifySourceAlreadyIntegrated(
        repository.repo,
        repository.identity,
        sourceOid,
        repository.baseline,
      )).toEqual({ kind: "integrated" })
      expect(await git(repository.repo, ["write-tree"])).toBe(beforeIndex)
    } finally {
      await rm(repository.repo, { recursive: true, force: true })
    }
  })

  test("proves an equivalent cherry-picked net change with an isolated index", async () => {
    const repository = await createRepository()
    try {
      await git(repository.repo, ["checkout", "-b", "writer", repository.baseline])
      const sourceOid = await commitFile(repository.repo, "writer.txt", "writer")
      await git(repository.repo, ["checkout", "main"])
      await commitFile(repository.repo, "lead.txt", "lead")
      await git(repository.repo, ["cherry-pick", sourceOid])
      const beforeIndex = await git(repository.repo, ["write-tree"])

      expect(await verifySourceAlreadyIntegrated(
        repository.repo,
        repository.identity,
        sourceOid,
        repository.baseline,
      )).toEqual({ kind: "integrated" })
      expect(await git(repository.repo, ["write-tree"])).toBe(beforeIndex)
      expect(await git(repository.repo, ["status", "--porcelain"])).toBe("")
    } finally {
      await rm(repository.repo, { recursive: true, force: true })
    }
  })

  test("proves a multi-commit source already present as one squash commit", async () => {
    const repository = await createRepository()
    try {
      await git(repository.repo, ["checkout", "-b", "writer", repository.baseline])
      await commitFile(repository.repo, "first.txt", "first")
      const sourceOid = await commitFile(repository.repo, "second.txt", "second")
      await git(repository.repo, ["checkout", "main"])
      await git(repository.repo, ["merge", "--squash", "writer"])
      await git(repository.repo, ["-c", "user.name=Ensemble Test", "-c", "user.email=ensemble@example.com", "commit", "-m", "squashed writer"])

      expect(await verifySourceAlreadyIntegrated(
        repository.repo,
        repository.identity,
        sourceOid,
        repository.baseline,
      )).toEqual({ kind: "integrated" })
    } finally {
      await rm(repository.repo, { recursive: true, force: true })
    }
  })

  test("proves writer content remains integrated after later HEAD commits", async () => {
    const repository = await createRepository()
    try {
      await git(repository.repo, ["checkout", "-b", "writer", repository.baseline])
      const sourceOid = await commitFile(repository.repo, "writer.txt", "writer")
      await git(repository.repo, ["checkout", "main"])
      await git(repository.repo, ["merge", "--squash", "writer"])
      await git(repository.repo, ["-c", "user.name=Ensemble Test", "-c", "user.email=ensemble@example.com", "commit", "-m", "squashed writer"])
      await commitFile(repository.repo, "later.txt", "later")

      expect(await verifySourceAlreadyIntegrated(repository.repo, repository.identity, sourceOid, repository.baseline))
        .toEqual({ kind: "integrated" })
    } finally {
      await rm(repository.repo, { recursive: true, force: true })
    }
  })

  test("proves a pure deletion already integrated after later HEAD commits", async () => {
    const repository = await createRepository()
    try {
      await git(repository.repo, ["checkout", "-b", "writer", repository.baseline])
      await git(repository.repo, ["rm", "base.txt"])
      await git(repository.repo, ["-c", "user.name=Ensemble Test", "-c", "user.email=ensemble@example.com", "commit", "-m", "delete"])
      const sourceOid = await git(repository.repo, ["rev-parse", "HEAD"])
      await git(repository.repo, ["checkout", "main"])
      await git(repository.repo, ["merge", "--squash", "writer"])
      await git(repository.repo, ["-c", "user.name=Ensemble Test", "-c", "user.email=ensemble@example.com", "commit", "-m", "squashed deletion"])
      await commitFile(repository.repo, "later.txt", "later")

      expect(await verifySourceAlreadyIntegrated(repository.repo, repository.identity, sourceOid, repository.baseline))
        .toEqual({ kind: "integrated" })
    } finally {
      await rm(repository.repo, { recursive: true, force: true })
    }
  })

  test("classifies a resolvable three-way content conflict separately", async () => {
    const repository = await createRepository()
    try {
      await git(repository.repo, ["checkout", "-b", "writer", repository.baseline])
      const sourceOid = await commitFile(repository.repo, "base.txt", "writer")
      await git(repository.repo, ["checkout", "main"])
      await commitFile(repository.repo, "base.txt", "lead")

      expect(await verifySourceAlreadyIntegrated(repository.repo, repository.identity, sourceOid, repository.baseline))
        .toEqual({ kind: "conflict" })
    } finally {
      await rm(repository.repo, { recursive: true, force: true })
    }
  })

  test("uses a merge base for legacy null baseline but never calls a changed tree integrated", async () => {
    const repository = await createRepository()
    try {
      await git(repository.repo, ["checkout", "-b", "writer", repository.baseline])
      const sourceOid = await commitFile(repository.repo, "writer.txt", "writer")
      await git(repository.repo, ["checkout", "main"])

      expect(await verifySourceAlreadyIntegrated(repository.repo, repository.identity, sourceOid, null))
        .toEqual({ kind: "not-integrated" })
    } finally {
      await rm(repository.repo, { recursive: true, force: true })
    }
  })

  test("ignores worktree dirt while failing closed for conflicts, identity mismatch, and unrelated history", async () => {
    const repository = await createRepository()
    try {
      await git(repository.repo, ["checkout", "-b", "writer", repository.baseline])
      const sourceOid = await commitFile(repository.repo, "base.txt", "writer")
      await git(repository.repo, ["checkout", "main"])

      await writeFile(path.join(repository.repo, "dirty.txt"), "dirty")
      expect((await verifySourceAlreadyIntegrated(repository.repo, repository.identity, sourceOid, repository.baseline)).kind)
        .toBe("not-integrated")
      await rm(path.join(repository.repo, "dirty.txt"))

      await commitFile(repository.repo, "base.txt", "lead")
      expect((await verifySourceAlreadyIntegrated(repository.repo, repository.identity, sourceOid, repository.baseline)).kind)
        .toBe("conflict")
      expect((await verifySourceAlreadyIntegrated(repository.repo, `${repository.repo}/other.git`, sourceOid, repository.baseline)).kind)
        .toBe("unverifiable")

      await git(repository.repo, ["checkout", "--orphan", "unrelated"])
      await git(repository.repo, ["rm", "-rf", "."])
      const unrelated = await commitFile(repository.repo, "unrelated.txt", "unrelated")
      expect((await verifySourceAlreadyIntegrated(repository.repo, repository.identity, sourceOid, null)).kind)
        .toBe("unverifiable")
      expect(unrelated).not.toBe(sourceOid)
    } finally {
      await rm(repository.repo, { recursive: true, force: true })
    }
  })
})

describe("conditional branch deletion", () => {
  test("deletes only the exact pinned tip and preserves a ref that moved", async () => {
    const repository = await createRepository()
    try {
      await git(repository.repo, ["branch", "writer", repository.baseline])
      expect(await deleteBranch("writer", repository.repo, repository.baseline)).toBe(true)
      expect(await git(repository.repo, ["branch", "writer", repository.baseline])).toBe("")
      await git(repository.repo, ["checkout", "writer"])
      const movedOid = await commitFile(repository.repo, "moved.txt", "moved")
      await git(repository.repo, ["checkout", "main"])

      expect(await deleteBranch("writer", repository.repo, repository.baseline)).toBe(false)
      expect(await git(repository.repo, ["rev-parse", "writer"])).toBe(movedOid)
    } finally {
      await rm(repository.repo, { recursive: true, force: true })
    }
  })
})

describe("failed writer explicit merge settlement", () => {
  test("atomically records verified-empty state and allows cleanup only afterward", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "missing-branch", "lead")
    insertMember(deps.db, "t1", "writer", "writer-session", "error", "failed")
    deps.db.run(
      `UPDATE team_member SET worktree_source_branch = 'immutable-writer',
       worktree_baseline_oid = 'baseline', worktree_branch = NULL WHERE team_id = 't1' AND name = 'writer'`,
    )

    const blocked = await executeTeamCleanup(deps, { force: false }, "lead")
    expect(blocked).toContain("team_merge")

    let mergeCalls = 0
    const settled = await executeTeamMerge(
      deps,
      { member: "writer" },
      "lead",
      async () => {
        mergeCalls++
        return { ok: true }
      },
      async () => true,
      async () => [],
      async () => ({ kind: "empty", sourceBranch: "immutable-writer", sourceOid: "baseline" }),
    )
    expect(settled).toContain("empty at its persisted baseline")
    expect(mergeCalls).toBe(0)
    expect(deps.db.query(
      "SELECT merge_state, merged_source_branch, merged_source_oid FROM team_member WHERE team_id = 't1' AND name = 'writer'",
    ).get()).toEqual({ merge_state: "merged", merged_source_branch: "immutable-writer", merged_source_oid: "baseline" })
    expect(deps.db.query("SELECT kind FROM team_event WHERE team_id = 't1' AND kind LIKE 'merge.%' ORDER BY time_created, id").all())
      .toEqual([{ kind: "merge.started" }, { kind: "merge.completed" }])

    const cleaned = await executeTeamCleanup(deps, { force: false }, "lead")
    expect(cleaned).toContain("cleaned up")
  })

  test("merges the verified advanced candidate rather than settling it empty", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "advanced-branch", "lead")
    insertMember(deps.db, "t1", "writer", "writer-session", "error", "failed")
    deps.db.run(
      `UPDATE team_member SET worktree_source_branch = 'immutable-writer',
       worktree_baseline_oid = 'baseline', worktree_branch = 'preserved-writer'
       WHERE team_id = 't1' AND name = 'writer'`,
    )
    const mergedBranches: string[] = []

    const result = await executeTeamMerge(
      deps,
      { member: "writer" },
      "lead",
      async branch => {
        mergedBranches.push(branch)
        return { ok: true }
      },
      async () => true,
      async () => [],
      async () => ({ kind: "merge", sourceBranch: "immutable-writer", sourceOid: "advanced-oid" }),
    )

    expect(result).toContain("Merged writer's changes")
    expect(mergedBranches).toEqual(["advanced-oid"])
    expect(deps.db.query(
      "SELECT merge_state, merged_source_branch, merged_source_oid, worktree_branch FROM team_member WHERE team_id = 't1' AND name = 'writer'",
    ).get()).toEqual({ merge_state: "merged", merged_source_branch: "immutable-writer", merged_source_oid: "advanced-oid", worktree_branch: null })
  })

  test("keeps the diagnostic label while overlap and merge use only the pinned OID", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "pinned-oid", "lead")
    insertMember(deps.db, "t1", "writer", "writer-session", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_branch = 'movable-writer' WHERE team_id = 't1' AND name = 'writer'")
    const gitOperands: string[] = []

    await executeTeamMerge(
      deps,
      { member: "writer" },
      "lead",
      async source => {
        gitOperands.push(`merge:${source}`)
        return { ok: true }
      },
      async () => true,
      async source => {
        gitOperands.push(`overlap:${source}`)
        return []
      },
      verifyFailedWriterEvidence,
      async (_root, label) => ({ sourceBranch: label, sourceOid: "immutable-source-oid" }),
      async () => ({ kind: "not-integrated" }),
    )

    expect(gitOperands).toEqual(["overlap:immutable-source-oid", "merge:immutable-source-oid"])
    expect(deps.db.query("SELECT merged_source_branch FROM team_member WHERE team_id = 't1' AND name = 'writer'").get())
      .toEqual({ merged_source_branch: "movable-writer" })
  })

  test("settles a pinned source already integrated without invoking overlap or merge", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "already-integrated", "lead")
    insertMember(deps.db, "t1", "writer", "writer-session", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_branch = 'writer-label' WHERE team_id = 't1' AND name = 'writer'")
    let gitMutationCalls = 0

    const result = await executeTeamMerge(
      deps,
      { member: "writer" },
      "lead",
      async () => {
        gitMutationCalls++
        return { ok: true }
      },
      async () => true,
      async () => {
        gitMutationCalls++
        return []
      },
      verifyFailedWriterEvidence,
      async (_root, label) => ({ sourceBranch: label, sourceOid: "integrated-oid" }),
      async () => ({ kind: "integrated" }),
    )

    expect(result).toContain("already integrated")
    expect(gitMutationCalls).toBe(0)
    expect(deps.db.query("SELECT merge_state, merged_source_branch FROM team_member WHERE team_id = 't1' AND name = 'writer'").get())
      .toEqual({ merge_state: "merged", merged_source_branch: "writer-label" })
  })

  test("passes the pinned OID to conditional branch deletion", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "conditional-delete", "lead")
    insertMember(deps.db, "t1", "writer", "writer-session", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_branch = 'writer-label' WHERE team_id = 't1' AND name = 'writer'")
    const deletions: Array<{ branch: string; expectedOid?: string }> = []

    await executeTeamMerge(
      deps,
      { member: "writer" },
      "lead",
      async () => ({ ok: true }),
      async (branch, _cwd, expectedOid) => {
        deletions.push({ branch, expectedOid })
        return false
      },
      async () => [],
      verifyFailedWriterEvidence,
      async (_root, label) => ({ sourceBranch: label, sourceOid: "immutable-source-oid" }),
      async () => ({ kind: "not-integrated" }),
    )

    expect(deletions).toEqual([{ branch: "writer-label", expectedOid: "immutable-source-oid" }])
  })

  test("messages never make missing branch evidence sufficient", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "no-message-inference", "lead")
    insertMember(deps.db, "t1", "writer", "writer-session", "error", "failed")
    deps.db.run(
      `UPDATE team_member SET worktree_source_branch = 'immutable-writer',
       worktree_baseline_oid = 'baseline', worktree_branch = NULL WHERE team_id = 't1' AND name = 'writer'`,
    )
    deps.db.run(
      `INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, read, time_created)
       VALUES ('m1', 't1', 'writer', 'lead', 'I made no changes', 1, 0, ?)`,
      [Date.now()],
    )

    const result = await executeTeamMerge(
      deps,
      { member: "writer" },
      "lead",
      async () => ({ ok: true }),
      async () => true,
      async () => [],
      async () => ({ kind: "unverifiable", reason: "no recorded branch ref or live baseline worktree survives" }),
    )
    expect(result).toContain("Cannot verify merge safety")
    expect(deps.db.query("SELECT merge_state, merged_source_branch FROM team_member WHERE team_id = 't1' AND name = 'writer'").get())
      .toEqual({ merge_state: "none", merged_source_branch: null })
    expect(deps.db.query("SELECT COUNT(*) AS count FROM team_event WHERE team_id = 't1' AND kind LIKE 'merge.%'").get())
      .toEqual({ count: 0 })
  })

  test("cleanup rejects a forged missing-ref merged state without its source and lifecycle event", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "forged-settlement", "lead")
    insertMember(deps.db, "t1", "writer", "writer-session", "error", "failed")
    deps.db.run(
      `UPDATE team_member SET worktree_source_branch = 'immutable-writer',
       worktree_baseline_oid = 'baseline', worktree_branch = NULL, merge_state = 'merged'
       WHERE team_id = 't1' AND name = 'writer'`,
    )

    const result = await executeTeamCleanup(deps, { force: false }, "lead")
    expect(result).toContain("Missing-ref merge settlement is incomplete")
    expect(deps.db.query("SELECT status FROM team WHERE id = 't1'").get()).toEqual({ status: "active" })
  })
})
