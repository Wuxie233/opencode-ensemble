import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setupDeps, insertTeam, insertMember } from "./helpers"
import { Watchdog } from "../src/watchdog"
import { ProgressTracker } from "../src/progress"
import { ActivityBuffer } from "../src/activity"

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exit !== 0) throw new Error(stderr.trim() || `git ${args.join(" ")} exited with code ${exit}`)
  return stdout
}

describe("Watchdog", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
  })

  test("times out a member that has been busy longer than TTL", async () => {
    // Insert member with time_updated far in the past
    const pastTime = Date.now() - 60_000 // 60s ago
    deps.db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', ?, ?)",
      ["t1", "alice", "sess-a", pastTime, pastTime]
    )
    deps.registry.register("t1", "alice", "sess-a")
    deps.db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, phase, time_created, time_updated) VALUES (?, ?, ?, 'pending', 'high', ?, ?, ?)",
      ["task-ready", "t1", "resume ready work", "discovery", pastTime - 1, pastTime - 1],
    )
    deps.db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, phase, time_created, time_updated) VALUES (?, ?, ?, 'in_progress', 'high', ?, ?, ?, ?)",
      ["task-a", "t1", "recover timed out task", "alice", "implementation", pastTime, pastTime],
    )
    deps.db.run("UPDATE team SET current_phase = 'implementation' WHERE id = 't1'")

    const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 })
    await watchdog.check()

    // Member should be timed_out
    const row = deps.db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get() as Record<string, string>
    expect(row.status).toBe("error")
    expect(row.execution_status).toBe("timed_out")

    // Session should have been aborted
    const abortCalls = deps.client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(1)

    // Toast should have been fired
    const toastCalls = deps.client.calls.filter(c => c.method === "tui.showToast")
    expect(toastCalls).toHaveLength(1)
    const msg = (toastCalls[0]!.args[0] as Record<string, unknown>).message as string
    expect(msg).toContain("alice")
    expect(msg).toContain("timed out")

    const alerts = deps.db.query(
      "SELECT content FROM team_message WHERE team_id = ? AND from_name = 'system' AND to_name = 'lead'",
    ).all("t1") as Array<{ content: string }>
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.content).toContain("alice")
    expect(alerts[0]!.content).toContain("timed out")
    expect((deps.db.query("SELECT status, assignee FROM team_task WHERE id = ?").get("task-a") as { status: string; assignee: string | null }))
      .toEqual({ status: "pending", assignee: null })
    expect(deps.db.query("SELECT current_phase FROM team WHERE id = 't1'").get())
      .toEqual({ current_phase: "discovery" })

    await watchdog.check()
    expect((deps.db.query("SELECT COUNT(*) AS count FROM team_message").get() as { count: number }).count).toBe(1)
  })

  test("does not time out a member within TTL", async () => {
    // Insert member with recent time_updated
    const now = Date.now()
    deps.db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', ?, ?)",
      ["t1", "alice", "sess-a", now, now]
    )
    deps.registry.register("t1", "alice", "sess-a")

    const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 })
    await watchdog.check()

    const row = deps.db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as Record<string, string>
    expect(row.status).toBe("busy")
  })

  test("uses the latest session activity timestamp before timing out stale members", async () => {
    const now = Date.now()
    const staleTime = now - 60_000
    for (const [name, sessionID] of [["active", "sess-active"], ["inactive", "sess-inactive"], ["silent", "sess-silent"]]) {
      deps.db.run(
        "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', ?, ?)",
        ["t1", name, sessionID, staleTime, staleTime],
      )
    }
    const activityBuffer = new ActivityBuffer()
    activityBuffer.record("sess-active", { type: "tool_call", tool: "bash", timestamp: now })
    activityBuffer.record("sess-active", { type: "step", timestamp: staleTime })
    activityBuffer.record("sess-inactive", { type: "tool_result", tool: "bash", timestamp: staleTime })

    const watchdog = new Watchdog({
      db: deps.db,
      client: deps.client,
      registry: deps.registry,
      ttlMs: 30_000,
      activityBuffer,
    })
    await watchdog.check()

    const members = deps.db.query(
      "SELECT name, status, execution_status FROM team_member ORDER BY name",
    ).all() as Array<{ name: string; status: string; execution_status: string }>
    expect(members).toEqual([
      { name: "active", status: "busy", execution_status: "running" },
      { name: "inactive", status: "error", execution_status: "timed_out" },
      { name: "silent", status: "error", execution_status: "timed_out" },
    ])
    expect(deps.client.calls.filter(call => call.method === "session.abort")).toHaveLength(2)
  })

  test("wakes the lead without awaiting prompt delivery after claiming a timeout", async () => {
    const pastTime = Date.now() - 60_000
    deps.db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', ?, ?)",
      ["t1", "alice", "sess-a", pastTime, pastTime],
    )
    deps.client.session.promptAsync = options => {
      deps.client.calls.push({ method: "session.promptAsync", args: [options] })
      return new Promise(() => { /* never resolves */ })
    }
    const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 })

    const outcome = await Promise.race([
      watchdog.check().then(() => "completed"),
      Bun.sleep(100).then(() => "blocked"),
    ])

    expect(outcome).toBe("completed")
    const prompts = deps.client.calls.filter(call => call.method === "session.promptAsync")
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.args[0]).toEqual({
      sessionID: "lead-sess",
      parts: [{ type: "text", text: "[System: Teammate alice timed out and termination is in progress; guidance is available in team messages]" }],
    })
    const alert = deps.db.query(
      "SELECT content, delivered FROM team_message WHERE team_id = ? AND from_name = 'system' AND to_name = 'lead'",
    ).get("t1") as { content: string; delivered: number }
    expect(alert.content).toContain('resume_from: "alice"')
    expect(alert.delivered).toBe(0)
  })

  test("persists and wakes timeout guidance before an abort that hangs", async () => {
    const pastTime = Date.now() - 60_000
    deps.db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', ?, ?)",
      ["t1", "alice", "sess-a", pastTime, pastTime],
    )
    deps.client.session.abort = async options => {
      deps.client.calls.push({ method: "session.abort", args: [options] })
      return new Promise(() => { /* hangs */ })
    }
    const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 })
    void watchdog.check()
    await Bun.sleep(10)

    const message = deps.db.query(
      "SELECT content FROM team_message WHERE team_id = 't1' AND from_name = 'system' AND to_name = 'lead'",
    ).get() as { content: string } | null
    expect(message?.content).toContain("termination is in progress")
    const prompts = deps.client.calls.filter(call => call.method === "session.promptAsync")
    expect(prompts).toHaveLength(1)
    expect((prompts[0]!.args[0] as { sessionID: string }).sessionID).toBe("lead-sess")
    expect(deps.db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get())
      .toEqual({ status: "busy", execution_status: "cancelling" })
  })

  test("does not time out non-busy members", async () => {
    const pastTime = Date.now() - 60_000
    deps.db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'ready', 'idle', ?, ?)",
      ["t1", "alice", "sess-a", pastTime, pastTime]
    )

    const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 })
    await watchdog.check()

    const row = deps.db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as Record<string, string>
    expect(row.status).toBe("ready")
  })

  test("does not mark a timed-out member terminal or release its task before abort resolves", async () => {
    const pastTime = Date.now() - 60_000
    deps.db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', ?, ?)",
      ["t1", "alice", "sess-a", pastTime, pastTime]
    )
    deps.db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES ('task-a', 't1', 'work', 'in_progress', 'high', 'alice', ?, ?)",
      [pastTime, pastTime],
    )
    let resolveAbort: (() => void) | undefined
    deps.client.session.abort = async () => new Promise<void>(resolve => { resolveAbort = resolve })

    const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 })
    const check = watchdog.check()
    await Bun.sleep(10)

    expect((deps.db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get() as { status: string; execution_status: string })).toEqual({ status: "busy", execution_status: "cancelling" })
    expect((deps.db.query("SELECT status, assignee FROM team_task WHERE id = 'task-a'").get() as { status: string; assignee: string })).toEqual({ status: "in_progress", assignee: "alice" })

    resolveAbort?.()
    await check
    expect((deps.db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as { status: string }).status).toBe("error")
  })

  test("claims a timed-out member once across overlapping watchdog checks", async () => {
    const pastTime = Date.now() - 60_000
    deps.db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', ?, ?)",
      ["t1", "alice", "sess-a", pastTime, pastTime]
    )
    let resolveAbort: (() => void) | undefined
    deps.client.session.abort = async options => {
      deps.client.calls.push({ method: "session.abort", args: [options] })
      return new Promise<void>(resolve => { resolveAbort = resolve })
    }
    const first = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 })
    const second = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 })

    const checks = Promise.all([first.check(), second.check()])
    await Bun.sleep(10)

    expect(deps.client.calls.filter(call => call.method === "session.abort")).toHaveLength(1)
    resolveAbort?.()
    await checks
  })

  test("keeps member and task ownership retryable when abort fails", async () => {
    const pastTime = Date.now() - 60_000
    deps.db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', ?, ?)",
      ["t1", "alice", "sess-a", pastTime, pastTime]
    )
    deps.db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES ('task-a', 't1', 'work', 'in_progress', 'high', 'alice', ?, ?)",
      [pastTime, pastTime],
    )
    deps.registry.register("t1", "alice", "sess-a")
    deps.client.session.abort = async () => { throw new Error("abort failed") }

    const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 })
    // Should not throw
    await watchdog.check()

    const row = deps.db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get() as Record<string, string>
    expect(row.status).toBe("busy")
    expect(row.execution_status).toBe("cancelling")
    expect((deps.db.query("SELECT status, assignee FROM team_task WHERE id = 'task-a'").get() as { status: string; assignee: string })).toEqual({ status: "in_progress", assignee: "alice" })
    const alert = deps.db.query(
      "SELECT content FROM team_message WHERE team_id = 't1' AND from_name = 'system' AND to_name = 'lead'",
    ).get() as { content: string }
    expect(alert.content).toContain("could not abort")
    expect(alert.content).toContain("retry")
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(1)

    deps.client.session.abort = async options => {
      deps.client.calls.push({ method: "session.abort", args: [options] })
      return {}
    }
  })

  test("retains the safe branch and durable claim when a timeout abort fails", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "ensemble-watchdog-abort-"))
    try {
      await git(repo, ["init"])
      await Bun.write(path.join(repo, "tracked.txt"), "first\n")
      await git(repo, ["add", "tracked.txt"])
      await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "first"])
      await git(repo, ["branch", "live-alice"])
      await git(repo, ["checkout", "live-alice"])

      const now = Date.now()
      const pastTime = now - 60_000
      deps.db.run(
        "INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES (?, 'watchdog-project', ?, 'active', ?, ?)",
        [repo, repo, now, now],
      )
      deps.db.run(
        "UPDATE team SET project_id = ? WHERE id = 't1'",
        [repo],
      )
      deps.db.run(
        "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, worktree_branch, worktree_dir, time_created, time_updated) VALUES ('t1', 'alice', 'sess-a', 'build', 'busy', 'running', 'live-alice', ?, ?, ?)",
        [repo, pastTime, pastTime],
      )
      let abortAttempts = 0
      deps.client.session.abort = async () => {
        const branch = (deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'").get() as { worktree_branch: string }).worktree_branch
        expect(branch).toStartWith("ensemble/preserved/")
        abortAttempts += 1
        if (abortAttempts === 1) throw new Error("transport unavailable")
        return {}
      }
      const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000, cwd: repo })

      await watchdog.check()
      const member = deps.db.query("SELECT execution_status, worktree_branch FROM team_member WHERE name = 'alice'").get() as {
        execution_status: string
        worktree_branch: string
      }
      expect(member.execution_status).toBe("cancelling")
      const safeBranch = member.worktree_branch
      expect(safeBranch).toStartWith("ensemble/preserved/")
      expect((await git(repo, ["rev-parse", safeBranch])).trim()).toBe((await git(repo, ["rev-parse", "live-alice"])).trim())
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("refreshes a legacy preserved record from its live worktree before abort", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "ensemble-watchdog-legacy-"))
    try {
      await git(repo, ["init"])
      await Bun.write(path.join(repo, "tracked.txt"), "latest\n")
      await git(repo, ["add", "tracked.txt"])
      await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "latest"])
      await git(repo, ["branch", "live-alice"])
      await git(repo, ["checkout", "live-alice"])
      const now = Date.now()
      const pastTime = now - 60_000
      deps.db.run(
        "INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES (?, 'watchdog-project', ?, 'active', ?, ?)",
        [repo, repo, now, now],
      )
      deps.db.run("UPDATE team SET project_id = ? WHERE id = 't1'", [repo])
      const safeBranch = "ensemble/preserved/watchdog-project/my-team#t1/alice"
      deps.db.run(
        `INSERT INTO team_member
         (team_id, name, session_id, agent, status, execution_status, worktree_dir, worktree_branch, time_created, time_updated)
         VALUES ('t1', 'alice', 'sess-a', 'build', 'busy', 'running', ?, ?, ?, ?)`,
        [repo, safeBranch, pastTime, pastTime],
      )

      await new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000, cwd: repo }).check()

      expect((await git(repo, ["rev-parse", safeBranch])).trim()).toBe((await git(repo, ["rev-parse", "live-alice"])).trim())
      expect((deps.db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as { status: string }).status).toBe("error")
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("does not overwrite a genuine completed idle transition when abort fails", async () => {
    const pastTime = Date.now() - 60_000
    deps.db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES ('t1', 'alice', 'sess-a', 'build', 'busy', 'running', ?, ?)",
      [pastTime, pastTime],
    )
    deps.db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES ('task-a', 't1', 'work', 'in_progress', 'high', 'alice', ?, ?)",
      [pastTime, pastTime],
    )
    deps.client.session.abort = async () => {
      deps.db.run("UPDATE team_task SET status = 'completed' WHERE id = 'task-a'")
      deps.db.run("UPDATE team_member SET status = 'ready', execution_status = 'idle', reported_to_lead = 1 WHERE team_id = 't1' AND name = 'alice'")
      throw new Error("abort failed after completion")
    }

    await new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 }).check()

    expect((deps.db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get() as { status: string; execution_status: string })).toEqual({ status: "ready", execution_status: "idle" })
    expect((deps.db.query("SELECT status, assignee FROM team_task WHERE id = 'task-a'").get() as { status: string; assignee: string })).toEqual({ status: "completed", assignee: "alice" })
  })

  test("times out multiple stale members across teams", async () => {
    insertTeam(deps.db, "t2", "other-team", "lead-sess-2")
    const pastTime = Date.now() - 60_000
    deps.db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', ?, ?)",
      ["t1", "alice", "sess-a", pastTime, pastTime]
    )
    deps.db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', ?, ?)",
      ["t2", "bob", "sess-b", pastTime, pastTime]
    )

    const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 })
    await watchdog.check()

    const alice = deps.db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as Record<string, string>
    const bob = deps.db.query("SELECT status FROM team_member WHERE name = 'bob'").get() as Record<string, string>
    expect(alice.status).toBe("error")
    expect(bob.status).toBe("error")
  })

  test("only times out members owned by its project", async () => {
    const projectB = "/tmp/project-b"
    const now = Date.now()
    const pastTime = now - 60_000
    deps.db.run(
      "INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES (?, 'project-b', ?, 'active', ?, ?)",
      [projectB, projectB, now, now],
    )
    deps.db.run(
      "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t2', 'team-b', ?, 'lead-b', 'active', 0, ?, ?)",
      [projectB, now, now],
    )
    deps.db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', ?, ?)",
      ["t1", "alice", "sess-a", pastTime, pastTime],
    )
    deps.db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', ?, ?)",
      ["t2", "bob", "sess-b", pastTime, pastTime],
    )

    const watchdog = new Watchdog({
      db: deps.db,
      client: deps.client,
      registry: deps.registry,
      ttlMs: 30_000,
      cwd: projectB,
    })
    await watchdog.check()

    expect((deps.db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as { status: string }).status).toBe("busy")
    expect((deps.db.query("SELECT status FROM team_member WHERE name = 'bob'").get() as { status: string }).status).toBe("error")
    expect(deps.client.calls.filter(call => call.method === "session.abort")).toHaveLength(1)
  })

  test("keeps a timed-out member retryable when branch preservation fails", async () => {
    const pastTime = Date.now() - 60_000
    deps.db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, worktree_branch, time_created, time_updated) VALUES ('t1', 'alice', 'sess-a', 'build', 'busy', 'running', 'missing-branch', ?, ?)",
      [pastTime, pastTime],
    )
    deps.db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES ('task-a', 't1', 'work', 'in_progress', 'high', 'alice', ?, ?)",
      [pastTime, pastTime],
    )
    const watchdog = new Watchdog({
      db: deps.db,
      client: deps.client,
      registry: deps.registry,
      ttlMs: 30_000,
      cwd: "/tmp/test-project",
    })

    await watchdog.check()

    expect((deps.db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as { status: string }).status).toBe("busy")
    expect((deps.db.query("SELECT status, assignee FROM team_task WHERE id = 'task-a'").get() as { status: string; assignee: string })).toEqual({ status: "in_progress", assignee: "alice" })
    expect(deps.client.calls.filter(call => call.method === "session.abort")).toHaveLength(0)
    expect((deps.db.query("SELECT content FROM team_message WHERE team_id = 't1' AND to_name = 'lead'").get() as { content: string }).content).toContain("could not be preserved")
  })

  test("fails closed when a timed-out writer has a branch but watchdog cwd is missing", async () => {
    const pastTime = Date.now() - 60_000
    deps.db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, worktree_branch, time_created, time_updated) VALUES ('t1', 'alice', 'sess-a', 'build', 'busy', 'running', 'live-alice', ?, ?)",
      [pastTime, pastTime],
    )

    await new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 }).check()

    expect(deps.client.calls.filter(call => call.method === "session.abort")).toHaveLength(0)
    expect(deps.db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get())
      .toEqual({ status: "busy", execution_status: "running" })
    expect((deps.db.query("SELECT content FROM team_message WHERE team_id = 't1' AND to_name = 'lead'").get() as { content: string }).content)
      .toContain("project directory")
  })

  test("start and stop control the interval", () => {
    const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000, checkIntervalMs: 60_000 })
    watchdog.start()
    expect(watchdog.isRunning()).toBe(true)
    watchdog.stop()
    expect(watchdog.isRunning()).toBe(false)
  })

  test("disabled when ttlMs is 0", async () => {
    const pastTime = Date.now() - 60_000
    deps.db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', ?, ?)",
      ["t1", "alice", "sess-a", pastTime, pastTime]
    )

    const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 0 })
    await watchdog.check()

    // Should not time out — disabled
    const row = deps.db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as Record<string, string>
    expect(row.status).toBe("busy")
  })

  describe("stall detection", () => {
    test("only checks stalled members owned by its project", async () => {
      const projectB = "/tmp/project-b"
      const now = Date.now()
      insertMember(deps.db, "t1", "alice", "sess-a", "busy", "running")
      deps.db.run(
        "INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES (?, 'project-b', ?, 'active', ?, ?)",
        [projectB, projectB, now, now],
      )
      deps.db.run(
        "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t2', 'team-b', ?, 'lead-b', 'active', 0, ?, ?)",
        [projectB, now, now],
      )
      insertMember(deps.db, "t2", "bob", "sess-b", "busy", "running")
      const progressTracker = new ProgressTracker()
      for (const sessionID of ["sess-a", "sess-b"]) {
        progressTracker.recordStep(sessionID, 10)
        progressTracker.recordStep(sessionID, 10)
        progressTracker.recordStep(sessionID, 10)
      }
      const watchdog = new Watchdog({
        db: deps.db,
        client: deps.client,
        registry: deps.registry,
        ttlMs: 0,
        cwd: projectB,
        progressTracker,
        stallThresholdMs: 60_000,
        stallMinSteps: 3,
        stallTokenThreshold: 500,
      })

      await watchdog.checkStalled()

      const promptCalls = deps.client.calls.filter(call => call.method === "session.promptAsync")
      expect(promptCalls).toHaveLength(2)
      expect(promptCalls.map(call => (call.args[0] as { sessionID: string }).sessionID).sort()).toEqual(["lead-b", "sess-b"])
    })

    test("does not flag low-output work when a recent tool result shows progress", async () => {
      insertMember(deps.db, "t1", "alice", "sess-a", "busy", "running")
      const progressTracker = new ProgressTracker()
      progressTracker.recordStep("sess-a", 10)
      progressTracker.recordStep("sess-a", 10)
      progressTracker.recordStep("sess-a", 10)
      const activityBuffer = new ActivityBuffer()
      activityBuffer.record("sess-a", {
        type: "tool_result",
        tool: "bash",
        output: "tests passed",
        timestamp: Date.now(),
      })
      const watchdog = new Watchdog({
        db: deps.db,
        client: deps.client,
        registry: deps.registry,
        ttlMs: 0,
        progressTracker,
        activityBuffer,
        stallThresholdMs: 60_000,
        stallMinSteps: 3,
        stallTokenThreshold: 500,
      })

      await watchdog.checkStalled()

      expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(0)
      expect(progressTracker.isTokenStalled("sess-a", 3, 500)).toBe(false)
    })

    test("still flags a genuine token stall without meaningful activity", async () => {
      insertMember(deps.db, "t1", "alice", "sess-a", "busy", "running")
      const progressTracker = new ProgressTracker()
      progressTracker.recordStep("sess-a", 10)
      progressTracker.recordStep("sess-a", 10)
      progressTracker.recordStep("sess-a", 10)
      const watchdog = new Watchdog({
        db: deps.db,
        client: deps.client,
        registry: deps.registry,
        ttlMs: 0,
        progressTracker,
        stallThresholdMs: 60_000,
        stallMinSteps: 3,
        stallTokenThreshold: 500,
      })

      await watchdog.checkStalled()

      const prompts = deps.client.calls.filter(call => call.method === "session.promptAsync")
      expect(prompts).toHaveLength(2)
      expect(prompts.map(call => (call.args[0] as { sessionID: string }).sessionID).sort())
        .toEqual(["lead-sess", "sess-a"])
    })

    test("still flags a genuine time stall without recent activity", async () => {
      insertMember(deps.db, "t1", "alice", "sess-a", "busy", "running")
      const progressTracker = new ProgressTracker()
      progressTracker.recordStep("sess-a", 1_000)
      await Bun.sleep(5)
      const watchdog = new Watchdog({
        db: deps.db,
        client: deps.client,
        registry: deps.registry,
        ttlMs: 0,
        progressTracker,
        stallThresholdMs: 1,
        stallMinSteps: 3,
        stallTokenThreshold: 500,
      })

      await watchdog.checkStalled()

      const prompts = deps.client.calls.filter(call => call.method === "session.promptAsync")
      expect(prompts).toHaveLength(2)
      expect(prompts.map(call => (call.args[0] as { sessionID: string }).sessionID).sort())
        .toEqual(["lead-sess", "sess-a"])
      const message = deps.db.query(
        "SELECT content FROM team_message WHERE team_id = 't1' AND from_name = 'system' AND to_name = 'lead'",
      ).get() as { content: string }
      expect(message.content).toContain("no communication")
    })
  })

  describe("chatty detection", () => {
    test("only checks chatty members owned by its project", async () => {
      const projectB = "/tmp/project-b"
      const now = Date.now()
      insertMember(deps.db, "t1", "alice", "sess-a", "busy", "running")
      deps.db.run(
        "INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES (?, 'project-b', ?, 'active', ?, ?)",
        [projectB, projectB, now, now],
      )
      deps.db.run(
        "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t2', 'team-b', ?, 'lead-b', 'active', 0, ?, ?)",
        [projectB, now, now],
      )
      insertMember(deps.db, "t2", "bob", "sess-b", "busy", "running")
      const progressTracker = new ProgressTracker()
      for (const sessionID of ["sess-a", "sess-b"]) {
        progressTracker.recordPeerMessage(sessionID)
        progressTracker.recordPeerMessage(sessionID)
      }
      const watchdog = new Watchdog({
        db: deps.db,
        client: deps.client,
        registry: deps.registry,
        ttlMs: 0,
        cwd: projectB,
        progressTracker,
        peerMessageLimit: 2,
      })

      await watchdog.checkChatty()

      const promptCalls = deps.client.calls.filter(call => call.method === "session.promptAsync")
      expect(promptCalls).toHaveLength(2)
      expect(promptCalls.map(call => (call.args[0] as { sessionID: string }).sessionID).sort()).toEqual(["lead-b", "sess-b"])
    })
  })

  describe("stale worktree GC", () => {
    test("only cleans stale worktrees owned by its project", async () => {
      const projectB = "/tmp/project-b"
      const now = Date.now()
      const pastTime = now - 600_000
      deps.db.run(
        "INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES (?, 'project-b', ?, 'active', ?, ?)",
        [projectB, projectB, now, now],
      )
      deps.db.run(
        "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t2', 'team-b', ?, 'lead-b', 'active', 0, ?, ?)",
        [projectB, now, now],
      )
      deps.db.run(
        "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, worktree_dir, time_created, time_updated) VALUES ('t1', 'alice', 'sess-a', 'build', 'shutdown', 'completed', '/tmp/wt-a', ?, ?)",
        [pastTime, pastTime],
      )
      deps.db.run(
        "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, worktree_dir, time_created, time_updated) VALUES ('t2', 'bob', 'sess-b', 'build', 'shutdown', 'completed', '/tmp/wt-b', ?, ?)",
        [pastTime, pastTime],
      )
      const watchdog = new Watchdog({
        db: deps.db,
        client: deps.client,
        registry: deps.registry,
        ttlMs: 0,
        cwd: projectB,
      })

      await watchdog.cleanupStaleWorktrees()

      const removeCalls = deps.client.calls.filter(call => call.method === "worktree.remove")
      expect(removeCalls).toHaveLength(1)
      expect((removeCalls[0]!.args[0] as { worktreeRemoveInput: { directory: string } }).worktreeRemoveInput.directory).toBe("/tmp/wt-b")
      expect((deps.db.query("SELECT worktree_dir FROM team_member WHERE name = 'alice'").get() as { worktree_dir: string }).worktree_dir).toBe("/tmp/wt-a")
    })

    test("cleans up stale worktrees for shutdown members past threshold", async () => {
      const pastTime = Date.now() - 600_000 // 10 min ago
      deps.db.run(
        "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, worktree_dir, worktree_branch, time_created, time_updated) VALUES (?, ?, ?, 'build', 'shutdown', 'completed', '/tmp/wt-alice', 'ensemble-alice', ?, ?)",
        ["t1", "alice", "sess-a", pastTime, pastTime]
      )

      const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 })
      await watchdog.cleanupStaleWorktrees()

      // worktree.remove should have been called
      const removeCalls = deps.client.calls.filter(c => c.method === "worktree.remove")
      expect(removeCalls).toHaveLength(1)
      expect((removeCalls[0]!.args[0] as Record<string, unknown>).worktreeRemoveInput).toEqual({ directory: "/tmp/wt-alice" })

      // DB should release stale resources but retain the branch for team_merge.
      const row = deps.db.query("SELECT worktree_dir, worktree_branch, workspace_id FROM team_member WHERE name = 'alice'").get() as Record<string, unknown>
      expect(row.worktree_dir).toBeNull()
      expect(row.worktree_branch).toBe("ensemble-alice")
    })

    test("does NOT clean up recently-updated shutdown members", async () => {
      const now = Date.now()
      deps.db.run(
        "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, worktree_dir, worktree_branch, time_created, time_updated) VALUES (?, ?, ?, 'build', 'shutdown', 'completed', '/tmp/wt-alice', 'ensemble-alice', ?, ?)",
        ["t1", "alice", "sess-a", now, now]
      )

      const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 })
      await watchdog.cleanupStaleWorktrees()

      const removeCalls = deps.client.calls.filter(c => c.method === "worktree.remove")
      expect(removeCalls).toHaveLength(0)

      const row = deps.db.query("SELECT worktree_dir FROM team_member WHERE name = 'alice'").get() as Record<string, unknown>
      expect(row.worktree_dir).toBe("/tmp/wt-alice")
    })

    test("cleans up workspace_id alongside worktree_dir", async () => {
      const pastTime = Date.now() - 600_000
      deps.db.run(
        "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, worktree_dir, worktree_branch, workspace_id, time_created, time_updated) VALUES (?, ?, ?, 'build', 'shutdown', 'completed', '/tmp/wt-bob', 'ensemble-bob', 'ws-123', ?, ?)",
        ["t1", "bob", "sess-b", pastTime, pastTime]
      )

      const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 })
      await watchdog.cleanupStaleWorktrees()

      // Both workspace.remove and worktree.remove should be called
      const wsRemoveCalls = deps.client.calls.filter(c => c.method === "workspace.remove")
      expect(wsRemoveCalls).toHaveLength(1)
      expect((wsRemoveCalls[0]!.args[0] as Record<string, unknown>).id).toBe("ws-123")

      const wtRemoveCalls = deps.client.calls.filter(c => c.method === "worktree.remove")
      expect(wtRemoveCalls).toHaveLength(1)

      // DB should release resources without erasing the preserved merge reference.
      const row = deps.db.query("SELECT worktree_dir, worktree_branch, workspace_id FROM team_member WHERE name = 'bob'").get() as Record<string, unknown>
      expect(row.worktree_dir).toBeNull()
      expect(row.worktree_branch).toBe("ensemble-bob")
      expect(row.workspace_id).toBeNull()
    })

    test("does NOT clean up worktrees for busy members", async () => {
      const pastTime = Date.now() - 600_000
      deps.db.run(
        "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, worktree_dir, worktree_branch, time_created, time_updated) VALUES (?, ?, ?, 'build', 'busy', 'running', '/tmp/wt-alice', 'ensemble-alice', ?, ?)",
        ["t1", "alice", "sess-a", pastTime, pastTime]
      )

      const watchdog = new Watchdog({ db: deps.db, client: deps.client, registry: deps.registry, ttlMs: 30_000 })
      await watchdog.cleanupStaleWorktrees()

      const removeCalls = deps.client.calls.filter(c => c.method === "worktree.remove")
      expect(removeCalls).toHaveLength(0)

      const row = deps.db.query("SELECT worktree_dir FROM team_member WHERE name = 'alice'").get() as Record<string, unknown>
      expect(row.worktree_dir).toBe("/tmp/wt-alice")
    })
  })
})
