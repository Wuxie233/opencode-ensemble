import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { applyMigrations } from "../src/schema"
import { recoverStaleMembers, recoverUndeliveredMessages, rehydrateRegistry } from "../src/recovery"
import type { PluginClient } from "../src/types"
import { MemberRegistry } from "../src/state"
import { sendMessage, broadcastMessage } from "../src/messaging"
import { getTeamResourceParts, preservedBranchName } from "../src/tools/merge-helper"

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

function setupDb(): Database {
  const db = new Database(":memory:")
  db.exec("PRAGMA journal_mode=WAL")
  db.exec("PRAGMA foreign_keys=ON")
  applyMigrations(db)
  return db
}

function insertTeam(db: Database, id: string, name: string, leadSession: string) {
  db.run(
    "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, 'active', 0, ?, ?)",
    [id, name, leadSession, Date.now(), Date.now()]
  )
}

function insertMember(db: Database, teamId: string, name: string, sessionId: string, status: string, execStatus: string) {
  db.run(
    "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', ?, ?, ?, ?)",
    [teamId, name, sessionId, status, execStatus, Date.now(), Date.now()]
  )
}

function mockClient(): PluginClient & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = []
  return {
    calls,
    session: {
      async create(options) { calls.push({ method: "session.create", args: [options] }); return { data: { id: "mock" } } },
      async promptAsync(options) { calls.push({ method: "session.promptAsync", args: [options] }); return {} },
      async abort(options) { calls.push({ method: "session.abort", args: [options] }); return {} },
      async status() { calls.push({ method: "session.status", args: [] }); return { data: {} } },
      async messages(options) { calls.push({ method: "session.messages", args: [options] }); return { data: [] } },
      async get(options) { calls.push({ method: "session.get", args: [options] }); return { data: {} } },
    },
    tui: {
      async showToast(options) { calls.push({ method: "tui.showToast", args: [options] }); return {} },
      async selectSession(options) { calls.push({ method: "tui.selectSession", args: [options] }); return {} },
    },
    worktree: {
      async create(options) { calls.push({ method: "worktree.create", args: [options] }); return { data: { name: "default", branch: "ensemble-default", directory: "/tmp/wt" } } },
      async remove(options) { calls.push({ method: "worktree.remove", args: [options] }); return {} },
      async list() { calls.push({ method: "worktree.list", args: [] }); return { data: [] } },
      async reset(options) { calls.push({ method: "worktree.reset", args: [options] }); return {} },
    },
    workspace: {
      async create(options) { calls.push({ method: "workspace.create", args: [options] }); return { data: { id: "ws-1", type: "worktree", branch: null, directory: null, projectID: "proj-1" } } },
      async remove(options) { calls.push({ method: "workspace.remove", args: [options] }); return {} },
      async list() { calls.push({ method: "workspace.list", args: [] }); return { data: [] } },
    },
  }
}

describe("recoverStaleMembers", () => {
  let db: Database
  let client: ReturnType<typeof mockClient>

  beforeEach(() => {
    db = setupDb()
    client = mockClient()
  })

  test("marks busy members as error on recovery", async () => {
    const now = Date.now()
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    insertMember(db, "t1", "bob", "sess-2", "busy", "running")
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, phase, time_created, time_updated) VALUES (?, ?, ?, 'pending', 'high', ?, ?, ?)",
      ["task-ready", "t1", "resume ready work", "discovery", now - 1, now - 1],
    )
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, phase, time_created, time_updated) VALUES (?, ?, ?, 'in_progress', 'high', ?, ?, ?, ?)",
      ["task-alice", "t1", "recover interrupted task", "alice", "implementation", now, now],
    )
    db.run("UPDATE team SET current_phase = 'implementation' WHERE id = 't1'")

    const result = await recoverStaleMembers(db, client)
    expect(result.interrupted).toBe(2)

    const alice = db.query("SELECT status, execution_status FROM team_member WHERE name = ?").get("alice") as Record<string, string>
    expect(alice.status).toBe("error")
    expect(alice.execution_status).toBe("idle")

    const bob = db.query("SELECT status, execution_status FROM team_member WHERE name = ?").get("bob") as Record<string, string>
    expect(bob.status).toBe("error")
    expect(bob.execution_status).toBe("idle")

    const alerts = db.query(
      "SELECT content FROM team_message WHERE team_id = ? AND from_name = 'system' AND to_name = 'lead' ORDER BY content",
    ).all("t1") as Array<{ content: string }>
    expect(alerts).toHaveLength(2)
    expect(alerts.map(alert => alert.content).join("\n")).toContain("alice")
    expect(alerts.map(alert => alert.content).join("\n")).toContain("bob")
    const leadWakes = client.calls.filter(call => call.method === "session.promptAsync")
    expect(leadWakes).toHaveLength(2)
    expect(leadWakes.every(call => (call.args[0] as { sessionID: string }).sessionID === "lead-sess")).toBe(true)
    expect((db.query("SELECT status, assignee FROM team_task WHERE id = ?").get("task-alice") as { status: string; assignee: string | null }))
      .toEqual({ status: "pending", assignee: null })
    expect(db.query("SELECT current_phase FROM team WHERE id = 't1'").get())
      .toEqual({ current_phase: "discovery" })

    expect((await recoverStaleMembers(db, client)).interrupted).toBe(0)
    expect((db.query("SELECT COUNT(*) AS count FROM team_message").get() as { count: number }).count).toBe(2)
  })

  test("aborts orphaned sessions during recovery", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    insertMember(db, "t1", "bob", "sess-2", "busy", "running")

    await recoverStaleMembers(db, client)

    const abortCalls = client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(2)
  })

  test("does not abort a session the server still reports as live", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    client.session.status = async () => {
      client.calls.push({ method: "session.status", args: [] })
      return { data: { "sess-1": { type: "busy" } } }
    }

    const result = await recoverStaleMembers(db, client)

    expect(result.interrupted).toBe(0)
    expect((db.query("SELECT status FROM team_member WHERE name = ?").get("alice") as { status: string }).status).toBe("busy")
    expect(client.calls.filter(call => call.method === "session.abort")).toHaveLength(0)
  })

  test("restores a live retry-breaker claim after restart", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "shutdown_requested", "cancelling")
    db.run("UPDATE team_member SET retry_count = 6, retry_tripped = 1, retry_attempts = '[1,2,3,4,5,6]' WHERE name = 'alice'")
    client.session.status = async () => ({ data: { "sess-1": { type: "busy" } } })

    expect((await recoverStaleMembers(db, client)).interrupted).toBe(1)
    expect(db.query("SELECT status, execution_status, retry_tripped FROM team_member WHERE name = 'alice'").get())
      .toEqual({ status: "error", execution_status: "failed", retry_tripped: 1 })
    expect(client.calls.filter(call => call.method === "session.abort")).toHaveLength(1)
  })

  test("settles an orphaned retry-breaker claim after restart", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "shutdown_requested", "cancelling")
    db.run("UPDATE team_member SET retry_count = 6, retry_tripped = 1, retry_attempts = '[1,2,3,4,5,6]' WHERE name = 'alice'")
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES ('task-a', 't1', 'work', 'in_progress', 'high', 'alice', ?, ?)",
      [Date.now(), Date.now()],
    )

    expect((await recoverStaleMembers(db, client)).interrupted).toBe(1)
    expect(db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get())
      .toEqual({ status: "error", execution_status: "failed" })
    expect(db.query("SELECT status, assignee FROM team_task WHERE id = 'task-a'").get())
      .toEqual({ status: "pending", assignee: null })
  })

  test("continues an unclaimed sixth-retry termination after restart", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    db.run("UPDATE team_member SET retry_count = 6, retry_tripped = 1, retry_attempts = '[1,2,3,4,5,6]' WHERE name = 'alice'")
    client.session.status = async () => ({ data: { "sess-1": { type: "busy" } } })

    expect((await recoverStaleMembers(db, client)).interrupted).toBe(1)
    expect(db.query("SELECT status, execution_status, retry_tripped FROM team_member WHERE name = 'alice'").get())
      .toEqual({ status: "error", execution_status: "failed", retry_tripped: 1 })
    expect(client.calls.filter(call => call.method === "session.abort")).toHaveLength(1)
  })

  test("settles a durable watchdog cancelling claim after restart", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "cancelling")
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES ('task-a', 't1', 'work', 'in_progress', 'high', 'alice', ?, ?)",
      [Date.now(), Date.now()],
    )
    client.session.status = async () => ({ data: { "sess-1": { type: "busy" } } })

    expect((await recoverStaleMembers(db, client)).interrupted).toBe(1)
    expect(db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get())
      .toEqual({ status: "error", execution_status: "timed_out" })
    expect(db.query("SELECT status, assignee FROM team_task WHERE id = 'task-a'").get())
      .toEqual({ status: "pending", assignee: null })
  })

  test.each(["idle", "starting", "running", "cancelling"])("settles durable shutdown_requested/%s after restart", async executionStatus => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "shutdown_requested", executionStatus)
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES ('task-a', 't1', 'work', 'in_progress', 'high', 'alice', ?, ?)",
      [Date.now(), Date.now()],
    )
    client.session.status = async () => ({ data: { "sess-1": { type: "busy" } } })

    expect((await recoverStaleMembers(db, client)).interrupted).toBe(1)
    expect(db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get())
      .toEqual({ status: "shutdown", execution_status: "idle" })
    expect(db.query("SELECT status, assignee FROM team_task WHERE id = 'task-a'").get())
      .toEqual({ status: "pending", assignee: null })
  })

  test("keeps a retry termination claim and task owned when restart abort fails", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "shutdown_requested", "cancelling")
    db.run("UPDATE team_member SET retry_count = 6, retry_tripped = 1 WHERE name = 'alice'")
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES ('task-a', 't1', 'work', 'in_progress', 'high', 'alice', ?, ?)",
      [Date.now(), Date.now()],
    )
    client.session.abort = async () => { throw new Error("transport unavailable") }

    expect((await recoverStaleMembers(db, client)).interrupted).toBe(0)
    expect(db.query("SELECT status, execution_status, retry_tripped FROM team_member WHERE name = 'alice'").get())
      .toEqual({ status: "shutdown_requested", execution_status: "cancelling", retry_tripped: 1 })
    expect(db.query("SELECT status, assignee FROM team_task WHERE id = 'task-a'").get())
      .toEqual({ status: "in_progress", assignee: "alice" })
  })

  test("fails closed when server liveness cannot be confirmed", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    client.session.status = async () => { throw new Error("server unavailable") }

    const result = await recoverStaleMembers(db, client)

    expect(result.interrupted).toBe(0)
    expect((db.query("SELECT status FROM team_member WHERE name = ?").get("alice") as { status: string }).status).toBe("busy")
    expect(client.calls.filter(call => call.method === "session.abort")).toHaveLength(0)
  })

  test("keeps an orphan retryable when branch preservation fails", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    db.run("UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND name = ?", ["missing-branch", "t1", "alice"])
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES ('task-a', 't1', 'work', 'in_progress', 'high', 'alice', ?, ?)",
      [Date.now(), Date.now()],
    )

    const result = await recoverStaleMembers(db, client, "/does/not/exist")

    expect(result.interrupted).toBe(0)
    expect((db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as { status: string }).status).toBe("busy")
    expect((db.query("SELECT status, assignee FROM team_task WHERE id = 'task-a'").get() as { status: string; assignee: string })).toEqual({ status: "in_progress", assignee: "alice" })
    expect(client.calls.filter(call => call.method === "session.abort")).toHaveLength(0)
    expect((db.query("SELECT content FROM team_message WHERE team_id = 't1' AND to_name = 'lead'").get() as { content: string }).content).toContain("could not be preserved")
  })

  test("fails closed when an orphaned writer has a branch but recovery cwd is missing", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    db.run("UPDATE team_member SET worktree_branch = 'live-alice' WHERE team_id = 't1' AND name = 'alice'")

    expect((await recoverStaleMembers(db, client)).interrupted).toBe(0)
    expect(client.calls.filter(call => call.method === "session.abort")).toHaveLength(0)
    expect(db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get())
      .toEqual({ status: "busy", execution_status: "running" })
    expect((db.query("SELECT content FROM team_message WHERE team_id = 't1' AND to_name = 'lead'").get() as { content: string }).content)
      .toContain("project directory")
  })

  test("does not mark an orphan terminal or release its task before abort resolves", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES ('task-a', 't1', 'work', 'in_progress', 'high', 'alice', ?, ?)",
      [Date.now(), Date.now()],
    )
    let resolveAbort: (() => void) | undefined
    client.session.abort = async () => new Promise<void>(resolve => { resolveAbort = resolve })

    const recovery = recoverStaleMembers(db, client)
    await Bun.sleep(10)

    expect((db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get() as { status: string; execution_status: string })).toEqual({ status: "busy", execution_status: "cancelling" })
    expect((db.query("SELECT status, assignee FROM team_task WHERE id = 'task-a'").get() as { status: string; assignee: string })).toEqual({ status: "in_progress", assignee: "alice" })

    resolveAbort?.()
    expect((await recovery).interrupted).toBe(1)
    expect((db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as { status: string }).status).toBe("error")
  })

  test("claims an orphan once across overlapping startup recovery calls", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    let resolveAbort: (() => void) | undefined
    client.session.abort = async options => {
      client.calls.push({ method: "session.abort", args: [options] })
      return new Promise<void>(resolve => { resolveAbort = resolve })
    }

    const recoveries = Promise.all([
      recoverStaleMembers(db, client),
      recoverStaleMembers(db, client),
    ])
    await Bun.sleep(10)

    expect(client.calls.filter(call => call.method === "session.abort")).toHaveLength(1)
    resolveAbort?.()
    expect(await recoveries).toEqual([{ interrupted: 1 }, { interrupted: 0 }])
  })

  test("keeps orphan and task ownership retryable when abort fails", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES ('task-a', 't1', 'work', 'in_progress', 'high', 'alice', ?, ?)",
      [Date.now(), Date.now()],
    )
    client.session.abort = async () => { throw new Error("abort failed") }

    const result = await recoverStaleMembers(db, client)
    expect(result.interrupted).toBe(0)

    expect((db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get() as { status: string; execution_status: string })).toEqual({ status: "busy", execution_status: "cancelling" })
    expect((db.query("SELECT status, assignee FROM team_task WHERE id = 'task-a'").get() as { status: string; assignee: string })).toEqual({ status: "in_progress", assignee: "alice" })
    const alert = db.query(
      "SELECT content FROM team_message WHERE team_id = 't1' AND from_name = 'system' AND to_name = 'lead'",
    ).get() as { content: string }
    expect(alert.content).toContain("could not abort")
    expect(alert.content).toContain("retry")
    expect(client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(1)

    client.session.abort = async options => {
      client.calls.push({ method: "session.abort", args: [options] })
      return {}
    }
    expect((await recoverStaleMembers(db, client)).interrupted).toBe(1)
    expect((db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as { status: string }).status).toBe("error")
    expect((db.query("SELECT status, assignee FROM team_task WHERE id = 'task-a'").get() as { status: string; assignee: string | null })).toEqual({ status: "pending", assignee: null })
  })

  test("retains and refreshes the live branch when startup abort must be retried", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "ensemble-recovery-abort-"))
    try {
      await git(repo, ["init"])
      await Bun.write(path.join(repo, "tracked.txt"), "first\n")
      await git(repo, ["add", "tracked.txt"])
      await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "first"])
      await git(repo, ["branch", "live-alice"])
      await git(repo, ["checkout", "live-alice"])
      insertTeam(db, "t1", "my-team", "lead-sess")
      insertMember(db, "t1", "alice", "sess-1", "busy", "running")
      db.run("UPDATE team_member SET worktree_branch = 'live-alice', worktree_dir = ? WHERE team_id = 't1' AND name = 'alice'", [repo])
      let abortAttempts = 0
      client.session.abort = async () => {
        const branch = (db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'").get() as { worktree_branch: string }).worktree_branch
        expect(branch).toStartWith("ensemble/preserved/")
        abortAttempts += 1
        if (abortAttempts === 1) throw new Error("transport unavailable")
        return {}
      }

      expect((await recoverStaleMembers(db, client, repo)).interrupted).toBe(0)
      expect((db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'").get() as { worktree_branch: string }).worktree_branch).toStartWith("ensemble/preserved/")

      await Bun.write(path.join(repo, "tracked.txt"), "second\n")
      await git(repo, ["add", "tracked.txt"])
      await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "second"])
      expect((await recoverStaleMembers(db, client, repo)).interrupted).toBe(1)

      const safeBranch = (db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'").get() as { worktree_branch: string }).worktree_branch
      expect(safeBranch).toStartWith("ensemble/preserved/")
      expect((await git(repo, ["rev-parse", safeBranch])).trim()).toBe((await git(repo, ["rev-parse", "live-alice"])).trim())
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test.each(["checking", "prompted"])("does not race active SafeAbort %s recovery during startup", async recoveryState => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    db.run(
      `UPDATE team_member SET abort_recovery_state = ?, abort_recovery_claim_token = 'owner',
         abort_recovery_claim_expires_at = ? WHERE name = 'alice'`,
      [recoveryState, Date.now() + 60_000],
    )

    expect((await recoverStaleMembers(db, client)).interrupted).toBe(0)
    expect(client.calls.filter(call => call.method === "session.abort")).toHaveLength(0)
    expect(db.query("SELECT status, execution_status, abort_recovery_state FROM team_member WHERE name = 'alice'").get())
      .toEqual({ status: "busy", execution_status: "running", abort_recovery_state: recoveryState })
  })

  test("keeps settled SafeAbort prompted work live during startup recovery", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    db.run(
      `UPDATE team_member SET abort_recovery_state = 'prompted', abort_recovery_claim_token = NULL,
         abort_recovery_claim_expires_at = NULL WHERE name = 'alice'`,
    )

    expect((await recoverStaleMembers(db, client)).interrupted).toBe(0)
    expect(client.calls.filter(call => call.method === "session.abort")).toHaveLength(0)
  })

  test("refreshes a legacy preserved record from its live worktree before startup abort", async () => {
    const repo = await mkdtemp(path.join(tmpdir(), "ensemble-recovery-legacy-"))
    try {
      await git(repo, ["init"])
      await Bun.write(path.join(repo, "tracked.txt"), "latest\n")
      await git(repo, ["add", "tracked.txt"])
      await git(repo, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "latest"])
      await git(repo, ["branch", "live-alice"])
      await git(repo, ["checkout", "live-alice"])
      insertTeam(db, "t1", "my-team", "lead-sess")
      insertMember(db, "t1", "alice", "sess-1", "busy", "running")
      const resource = getTeamResourceParts(db, "t1")
      const safeBranch = preservedBranchName(resource.projectName, resource.teamName, resource.teamId, "alice")
      db.run(
        "UPDATE team_member SET worktree_dir = ?, worktree_branch = ? WHERE team_id = 't1' AND name = 'alice'",
        [repo, safeBranch],
      )

      expect((await recoverStaleMembers(db, client, repo)).interrupted).toBe(1)

      expect((await git(repo, ["rev-parse", safeBranch])).trim()).toBe((await git(repo, ["rev-parse", "live-alice"])).trim())
      expect((db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as { status: string }).status).toBe("error")
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("does not overwrite a genuine completed idle transition when abort fails", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES ('task-a', 't1', 'work', 'in_progress', 'high', 'alice', ?, ?)",
      [Date.now(), Date.now()],
    )
    client.session.abort = async () => {
      db.run("UPDATE team_task SET status = 'completed' WHERE id = 'task-a'")
      db.run("UPDATE team_member SET status = 'ready', execution_status = 'idle', reported_to_lead = 1 WHERE team_id = 't1' AND name = 'alice'")
      throw new Error("abort failed after completion")
    }

    expect((await recoverStaleMembers(db, client)).interrupted).toBe(0)
    expect((db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get() as { status: string; execution_status: string })).toEqual({ status: "ready", execution_status: "idle" })
    expect((db.query("SELECT status, assignee FROM team_task WHERE id = 'task-a'").get() as { status: string; assignee: string })).toEqual({ status: "completed", assignee: "alice" })
  })

  test("does not touch non-busy members", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "ready", "idle")
    insertMember(db, "t1", "bob", "sess-2", "shutdown", "idle")

    const result = await recoverStaleMembers(db, client)
    expect(result.interrupted).toBe(0)

    const alice = db.query("SELECT status FROM team_member WHERE name = ?").get("alice") as Record<string, string>
    expect(alice.status).toBe("ready")

    // No abort calls
    const abortCalls = client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(0)
  })

  test("returns zero when no stale state exists", async () => {
    const result = await recoverStaleMembers(db, client)
    expect(result.interrupted).toBe(0)
  })

  test("is idempotent — running twice produces same result", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")

    await recoverStaleMembers(db, client)
    const result2 = await recoverStaleMembers(db, client)
    expect(result2.interrupted).toBe(0)

    const alice = db.query("SELECT status FROM team_member WHERE name = ?").get("alice") as Record<string, string>
    expect(alice.status).toBe("error")
  })

  test("only recovers members in active teams", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    db.run("UPDATE team SET status = 'archived' WHERE id = ?", ["t1"])
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")

    const result = await recoverStaleMembers(db, client)
    expect(result.interrupted).toBe(0)
  })

  test("only recovers stale members for the current project when provided", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    db.run("INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated) VALUES (?, ?, ?, 'active', ?, ?)", ["/tmp/project-a", "project-a", "/tmp/project-a", Date.now(), Date.now()])
    db.run("UPDATE team SET project_id = ? WHERE id = ?", ["/tmp/project-a", "t1"])
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")

    insertTeam(db, "t2", "other-team", "other-lead")
    db.run("INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated) VALUES (?, ?, ?, 'active', ?, ?)", ["/tmp/project-b", "project-b", "/tmp/project-b", Date.now(), Date.now()])
    db.run("UPDATE team SET project_id = ? WHERE id = ?", ["/tmp/project-b", "t2"])
    insertMember(db, "t2", "bob", "sess-2", "busy", "running")

    const result = await recoverStaleMembers(db, client, "/tmp/project-a")
    expect(result.interrupted).toBe(1)

    const alice = db.query("SELECT status FROM team_member WHERE name = ?").get("alice") as { status: string }
    const bob = db.query("SELECT status FROM team_member WHERE name = ?").get("bob") as { status: string }
    expect(alice.status).toBe("error")
    expect(bob.status).toBe("busy")

    const abortCalls = client.calls.filter(c => c.method === "session.abort")
    expect(abortCalls).toHaveLength(1)
    expect((abortCalls[0]!.args[0] as { sessionID: string }).sessionID).toBe("sess-1")
  })

  test("recovers legacy default-project members when current project is provided", async () => {
    insertTeam(db, "legacy", "legacy-team", "legacy-lead")
    insertMember(db, "legacy", "alice", "sess-legacy", "busy", "running")

    insertTeam(db, "current", "current-team", "current-lead")
    db.run("INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated) VALUES (?, ?, ?, 'active', ?, ?)", ["/tmp/project-a", "project-a", "/tmp/project-a", Date.now(), Date.now()])
    db.run("UPDATE team SET project_id = ? WHERE id = ?", ["/tmp/project-a", "current"])
    insertMember(db, "current", "bob", "sess-current", "busy", "running")

    insertTeam(db, "other", "other-team", "other-lead")
    db.run("INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated) VALUES (?, ?, ?, 'active', ?, ?)", ["/tmp/project-b", "project-b", "/tmp/project-b", Date.now(), Date.now()])
    db.run("UPDATE team SET project_id = ? WHERE id = ?", ["/tmp/project-b", "other"])
    insertMember(db, "other", "cara", "sess-other", "busy", "running")

    const result = await recoverStaleMembers(db, client, "/tmp/project-a")
    expect(result.interrupted).toBe(2)

    const alice = db.query("SELECT status FROM team_member WHERE name = ?").get("alice") as { status: string }
    const bob = db.query("SELECT status FROM team_member WHERE name = ?").get("bob") as { status: string }
    const cara = db.query("SELECT status FROM team_member WHERE name = ?").get("cara") as { status: string }
    expect(alice.status).toBe("error")
    expect(bob.status).toBe("error")
    expect(cara.status).toBe("busy")
  })
})

describe("recoverUndeliveredMessages", () => {
  let db: Database
  let client: ReturnType<typeof mockClient>
  let registry: MemberRegistry

  beforeEach(() => {
    db = setupDb()
    client = mockClient()
    registry = new MemberRegistry()
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-alice")
    insertMember(db, "t1", "bob", "sess-bob")
    registry.register("t1", "alice", "sess-alice")
    registry.register("t1", "bob", "sess-bob")
  })

  function insertMember(db: Database, teamId: string, name: string, sessionId: string) {
    db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'ready', 'idle', ?, ?)",
      [teamId, name, sessionId, Date.now(), Date.now()]
    )
  }

  test("redelivers undelivered direct messages via promptAsync", async () => {
    sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "hello" })

    const result = await recoverUndeliveredMessages(db, client, registry)
    expect(result.redelivered).toBe(1)

    const promptCalls = client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)

    // Message should now be marked delivered
    const msgs = db.query("SELECT delivered FROM team_message WHERE team_id = ?").all("t1") as Array<{ delivered: number }>
    expect(msgs[0]!.delivered).toBe(1)
  })

  test("skips lead-bound messages (delivered via system prompt transform instead)", async () => {
    sendMessage(db, { teamId: "t1", from: "alice", to: "lead", content: "done" })

    const result = await recoverUndeliveredMessages(db, client, registry)
    expect(result.redelivered).toBe(0)

    // No promptAsync calls for lead messages
    const promptCalls = client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(0)
  })

  test("skips already-delivered messages", async () => {
    const id = sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "hello" })
    db.run("UPDATE team_message SET delivered = 1 WHERE id = ?", [id])

    const result = await recoverUndeliveredMessages(db, client, registry)
    expect(result.redelivered).toBe(0)
  })

  test("returns zero when no undelivered messages", async () => {
    const result = await recoverUndeliveredMessages(db, client, registry)
    expect(result.redelivered).toBe(0)
  })

  test("handles multiple undelivered messages (skips lead-bound)", async () => {
    sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "msg1" })
    sendMessage(db, { teamId: "t1", from: "bob", to: "alice", content: "msg2" })
    sendMessage(db, { teamId: "t1", from: "alice", to: "lead", content: "msg3" })

    const result = await recoverUndeliveredMessages(db, client, registry)
    expect(result.redelivered).toBe(2) // only member-to-member, not lead

    const promptCalls = client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(2)
  })

  test("restores an asynchronously failed delivery for retry", async () => {
    sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "msg1" })
    client.session.promptAsync = () => Promise.reject(new Error("network error"))

    const result = await recoverUndeliveredMessages(db, client, registry)
    expect(result.redelivered).toBe(1)

    await Promise.resolve()
    const message = db.query("SELECT delivered FROM team_message WHERE team_id = ?").get("t1") as { delivered: number }
    expect(message.delivered).toBe(0)
  })

  test("restores a failed delivery to a busy recovered member", async () => {
    db.run("UPDATE team_member SET status = 'busy', execution_status = 'running' WHERE team_id = ? AND name = ?", ["t1", "bob"])
    sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "msg1" })
    client.session.promptAsync = () => Promise.reject(new Error("network error"))

    const result = await recoverUndeliveredMessages(db, client, registry)
    expect(result.redelivered).toBe(1)

    await Promise.resolve()
    const message = db.query("SELECT delivered FROM team_message WHERE team_id = ?").get("t1") as { delivered: number }
    expect(message.delivered).toBe(0)
  })

  test("does not wait for promptAsync to settle", async () => {
    sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "msg1" })
    client.session.promptAsync = () => new Promise(() => {})

    const result = await Promise.race([
      recoverUndeliveredMessages(db, client, registry),
      Bun.sleep(50).then(() => "timed-out" as const),
    ])

    expect(result).toEqual({ redelivered: 1 })
    const message = db.query("SELECT delivered, delivery_claimed_at FROM team_message WHERE team_id = ?").get("t1") as {
      delivered: number
      delivery_claimed_at: number | null
    }
    expect(message.delivered).toBe(0)
    expect(message.delivery_claimed_at).not.toBeNull()
  })

  test("reclaims an expired recovery delivery lease", async () => {
    const id = sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "msg1" })
    db.run("UPDATE team_message SET delivery_claimed_at = ? WHERE id = ?", [0, id])

    const result = await recoverUndeliveredMessages(db, client, registry)

    expect(result.redelivered).toBe(1)
    expect(client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(1)
  })

  test("skips broadcast messages (to_name is NULL)", async () => {
    broadcastMessage(db, { teamId: "t1", from: "alice", content: "hey everyone" })

    const result = await recoverUndeliveredMessages(db, client, registry)
    expect(result.redelivered).toBe(0)

    // No promptAsync calls should have been made
    const promptCalls = client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(0)

    // Message should remain undelivered
    const msgs = db.query("SELECT delivered FROM team_message WHERE team_id = ?").all("t1") as Array<{ delivered: number }>
    expect(msgs[0]!.delivered).toBe(0)
  })

  test("skips messages to unknown recipients not in registry", async () => {
    sendMessage(db, { teamId: "t1", from: "alice", to: "charlie", content: "hello" })

    const result = await recoverUndeliveredMessages(db, client, registry)
    expect(result.redelivered).toBe(0)

    const promptCalls = client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(0)
  })

  test("returns zero when no active teams exist", async () => {
    db.run("UPDATE team SET status = 'archived' WHERE id = ?", ["t1"])
    sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "hello" })

    const result = await recoverUndeliveredMessages(db, client, registry)
    expect(result.redelivered).toBe(0)
  })

  test("recovers member-to-member messages across multiple active teams (skips lead-bound)", async () => {
    // Set up a second team
    db.run(
      "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, 'active', 0, ?, ?)",
      ["t2", "team-two", "lead-sess-2", Date.now(), Date.now()]
    )
    db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', 'ready', 'idle', ?, ?)",
      ["t2", "charlie", "sess-charlie", Date.now(), Date.now()]
    )
    registry.register("t2", "charlie", "sess-charlie")

    sendMessage(db, { teamId: "t1", from: "alice", to: "bob", content: "msg for t1" })
    sendMessage(db, { teamId: "t2", from: "charlie", to: "lead", content: "msg for t2" })

    const result = await recoverUndeliveredMessages(db, client, registry)
    expect(result.redelivered).toBe(1) // only member-to-member, lead-bound skipped

    const promptCalls = client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)
  })
})

describe("recoverOrphanedBranches", () => {
  let db: Database

  beforeEach(() => {
    db = setupDb()
  })

  test("only deletes preserved branches for archived teams in the current project", async () => {
    insertTeam(db, "t1", "alpha", "lead-a")
    db.run("INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated) VALUES (?, ?, ?, 'active', ?, ?)", ["/tmp/project-a", "project-a", "/tmp/project-a", Date.now(), Date.now()])
    db.run("UPDATE team SET status = 'archived', project_id = ? WHERE id = ?", ["/tmp/project-a", "t1"])

    insertTeam(db, "t2", "beta", "lead-b")
    db.run("INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated) VALUES (?, ?, ?, 'active', ?, ?)", ["/tmp/project-b", "project-b", "/tmp/project-b", Date.now(), Date.now()])
    db.run("UPDATE team SET status = 'archived', project_id = ? WHERE id = ?", ["/tmp/project-b", "t2"])

    const repo = await mkdtemp(path.join(tmpdir(), "ensemble-branches-"))
    try {
      db.run("INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated) VALUES (?, 'project-a', ?, 'active', ?, ?)", [repo, repo, Date.now(), Date.now()])
      db.run("UPDATE team SET project_id = ? WHERE id = ?", [repo, "t1"])
      await git(repo, ["init"])
      await git(repo, ["config", "user.email", "test@example.com"])
      await git(repo, ["config", "user.name", "Test User"])
      await git(repo, ["commit", "--allow-empty", "-m", "init"])
      await git(repo, ["branch", "ensemble/preserved/project-a/alpha#t1/alice"])
      await git(repo, ["branch", "ensemble/preserved/alpha/legacy-alice"])
      await git(repo, ["branch", "ensemble/preserved/project-b/beta#t2/bob"])

      const { recoverOrphanedBranches } = await import("../src/recovery")
      const result = await recoverOrphanedBranches(db, repo)
      const remaining = await git(repo, ["branch", "--list", "ensemble/preserved/*", "--format", "%(refname:short)"])

      expect(result.removed).toBe(2)
      expect(remaining.trim()).toBe("ensemble/preserved/project-b/beta#t2/bob")
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test.each(["none", "merging"])("retains an archived team's %s preserved branch for later merge", async mergeState => {
    const repo = await mkdtemp(path.join(tmpdir(), "ensemble-branches-retained-"))
    try {
      await git(repo, ["init"])
      await git(repo, ["config", "user.email", "test@example.com"])
      await git(repo, ["config", "user.name", "Test User"])
      await git(repo, ["commit", "--allow-empty", "-m", "init"])
      insertTeam(db, "t1", "alpha", "lead-a")
      db.run("INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated) VALUES (?, 'project-a', ?, 'active', ?, ?)", [repo, repo, Date.now(), Date.now()])
      db.run("UPDATE team SET status = 'archived', project_id = ? WHERE id = 't1'", [repo])
      insertMember(db, "t1", "alice", "sess-a", "shutdown", "idle")
      const branch = "ensemble/preserved/project-a/alpha#t1/alice"
      await git(repo, ["branch", branch])
      db.run(
        "UPDATE team_member SET worktree_branch = ?, merge_state = ?, merged_source_branch = ? WHERE team_id = 't1' AND name = 'alice'",
        [branch, mergeState, mergeState === "merging" ? branch : null],
      )

      const { recoverOrphanedBranches } = await import("../src/recovery")
      expect(await recoverOrphanedBranches(db, repo)).toEqual({ removed: 0 })
      expect((await git(repo, ["branch", "--list", branch, "--format", "%(refname:short)"])).trim()).toBe(branch)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })
})

describe("recoverOrphanedWorktrees", () => {
  let db: Database
  let client: ReturnType<typeof mockClient>

  beforeEach(() => {
    db = setupDb()
    client = mockClient()
    insertTeam(db, "t1", "my-team", "lead-sess")
  })

  test("removes orphaned ensemble worktrees not in active teams", async () => {
    // Mock worktree.list returns a worktree that has no matching active member
    client.worktree.list = async () => {
      client.calls.push({ method: "worktree.list", args: [] })
      return { data: [
        { name: "ensemble-old-team-alice", branch: "ensemble-old-team-alice", directory: "/tmp/wt-orphan" },
      ] }
    }

    const { recoverOrphanedWorktrees } = await import("../src/recovery")
    const result = await recoverOrphanedWorktrees(db, client)
    expect(result.removed).toBe(1)

    const removeCalls = client.calls.filter(c => c.method === "worktree.remove")
    expect(removeCalls).toHaveLength(1)
  })

  test("does not remove worktrees belonging to active members", async () => {
    insertMember(db, "t1", "alice", "sess-alice", "busy", "running")
    db.run("UPDATE team_member SET worktree_dir = ? WHERE name = 'alice'", ["/tmp/wt-alice"])

    client.worktree.list = async () => {
      client.calls.push({ method: "worktree.list", args: [] })
      return { data: [
        { name: "ensemble-my-team-alice", branch: "ensemble-my-team-alice", directory: "/tmp/wt-alice" },
      ] }
    }

    const { recoverOrphanedWorktrees } = await import("../src/recovery")
    const result = await recoverOrphanedWorktrees(db, client)
    expect(result.removed).toBe(0)
  })

  test("does not remove an active worktree belonging to another project", async () => {
    const now = Date.now()
    db.run(
      "INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('/tmp/project-b', 'project-b', '/tmp/project-b', 'active', ?, ?)",
      [now, now],
    )
    db.run(
      "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t2', 'team-b', '/tmp/project-b', 'lead-b', 'active', 0, ?, ?)",
      [now, now],
    )
    insertMember(db, "t2", "bob", "sess-bob", "busy", "running")
    db.run("UPDATE team_member SET worktree_dir = '/tmp/wt-bob' WHERE team_id = 't2' AND name = 'bob'")
    client.worktree.list = async () => ({
      data: [{ name: "ensemble-project-b-team-b-bob", branch: "ensemble-bob", directory: "/tmp/wt-bob" }],
    })

    const { recoverOrphanedWorktrees } = await import("../src/recovery")
    expect(await recoverOrphanedWorktrees(db, client)).toEqual({ removed: 0 })
    expect(client.calls.filter(call => call.method === "worktree.remove")).toHaveLength(0)
  })

  test("ignores non-ensemble worktrees", async () => {
    client.worktree.list = async () => {
      client.calls.push({ method: "worktree.list", args: [] })
      return { data: [
        { name: "user-feature-branch", branch: "feature-branch", directory: "/tmp/wt-user" },
      ] }
    }

    const { recoverOrphanedWorktrees } = await import("../src/recovery")
    const result = await recoverOrphanedWorktrees(db, client)
    expect(result.removed).toBe(0)
  })

  test("returns zero when worktree.list fails", async () => {
    client.worktree.list = async () => { throw new Error("not supported") }

    const { recoverOrphanedWorktrees } = await import("../src/recovery")
    const result = await recoverOrphanedWorktrees(db, client)
    expect(result.removed).toBe(0)
  })

  test("continues if individual worktree removal fails", async () => {
    client.worktree.list = async () => {
      client.calls.push({ method: "worktree.list", args: [] })
      return { data: [
        { name: "ensemble-old-a", branch: "ensemble-old-a", directory: "/tmp/wt-a" },
        { name: "ensemble-old-b", branch: "ensemble-old-b", directory: "/tmp/wt-b" },
      ] }
    }
    let removeCount = 0
    client.worktree.remove = async () => {
      removeCount++
      if (removeCount === 1) throw new Error("failed")
      return {}
    }

    const { recoverOrphanedWorktrees } = await import("../src/recovery")
    const result = await recoverOrphanedWorktrees(db, client)
    expect(result.removed).toBe(1) // second one succeeded
  })
})

describe("rehydrateRegistry", () => {
  let db: Database
  let registry: MemberRegistry

  beforeEach(() => {
    db = setupDb()
    registry = new MemberRegistry()
  })

  test("rehydrates an idle (ready) member from SQLite — the desktop bug", () => {
    // This is the exact scenario from the production bug:
    // a teammate exists in SQLite at status='ready' from a previous plugin
    // lifetime, the plugin restarts, the registry is empty. Without
    // rehydration, the teammate's team_* tool calls fail with "This
    // session is not in a team."
    insertTeam(db, "t1", "smoke", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "ready", "idle")

    const count = rehydrateRegistry(db, registry)

    expect(count).toBe(1)
    const entry = registry.getBySession("scout-sess")
    expect(entry?.memberName).toBe("scout")
    expect(entry?.teamId).toBe("t1")
  })

  test("rehydrates a busy member (not just ready ones)", () => {
    insertTeam(db, "t1", "smoke", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "busy", "running")

    const count = rehydrateRegistry(db, registry)

    expect(count).toBe(1)
    expect(registry.getBySession("scout-sess")?.memberName).toBe("scout")
  })

  test("skips members in terminal states (shutdown, error)", () => {
    insertTeam(db, "t1", "smoke", "lead-sess")
    insertMember(db, "t1", "alice", "alice-sess", "shutdown", "completed")
    insertMember(db, "t1", "bob", "bob-sess", "error", "failed")
    insertMember(db, "t1", "carol", "carol-sess", "ready", "idle")

    const count = rehydrateRegistry(db, registry)

    expect(count).toBe(1)
    expect(registry.getBySession("alice-sess")).toBeUndefined()
    expect(registry.getBySession("bob-sess")).toBeUndefined()
    expect(registry.getBySession("carol-sess")?.memberName).toBe("carol")
  })

  test("skips members in archived teams", () => {
    db.run(
      "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, 'archived', 0, ?, ?)",
      ["t1", "old", "lead-sess", Date.now(), Date.now()]
    )
    insertMember(db, "t1", "scout", "scout-sess", "ready", "idle")

    const count = rehydrateRegistry(db, registry)

    expect(count).toBe(0)
    expect(registry.getBySession("scout-sess")).toBeUndefined()
  })

  test("returns 0 when no active teams exist", () => {
    expect(rehydrateRegistry(db, registry)).toBe(0)
  })

  test("rehydrates members from multiple active teams", () => {
    insertTeam(db, "t1", "alpha", "lead-1")
    insertTeam(db, "t2", "beta", "lead-2")
    insertMember(db, "t1", "scout", "scout-sess", "ready", "idle")
    insertMember(db, "t2", "ranger", "ranger-sess", "busy", "running")

    const count = rehydrateRegistry(db, registry)

    expect(count).toBe(2)
    expect(registry.getBySession("scout-sess")?.teamId).toBe("t1")
    expect(registry.getBySession("ranger-sess")?.teamId).toBe("t2")
  })

  test("is idempotent — running twice does not duplicate or error", () => {
    insertTeam(db, "t1", "smoke", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "ready", "idle")

    rehydrateRegistry(db, registry)
    const count = rehydrateRegistry(db, registry)

    expect(count).toBe(1)
    expect(registry.getBySession("scout-sess")?.memberName).toBe("scout")
  })
})
