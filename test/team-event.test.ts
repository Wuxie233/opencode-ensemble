import { beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { appendTeamEvent, deleteArchivedTeamForExplicitPurge } from "../src/team-event"
import { applyMigrations, MIGRATIONS } from "../src/schema"
import { executeTeamClaim } from "../src/tools/team-claim"
import { executeTeamCleanup } from "../src/tools/team-cleanup"
import { executeTeamCreate } from "../src/tools/team-create"
import { executeTeamMerge } from "../src/tools/team-merge"
import { executeTeamMessage } from "../src/tools/team-message"
import { executeTeamSpawn } from "../src/tools/team-spawn"
import { executeTeamTasksAdd } from "../src/tools/team-tasks-add"
import { executeTeamTasksComplete } from "../src/tools/team-tasks-complete"
import { insertMember, insertTeam, setupDeps } from "./helpers"

interface EventRow {
  id: string
  kind: string
  payload: string
  cause_event_id: string | null
}

describe("team_event migration", () => {
  test("migration 13 creates empty immutable event rows retained until Team purge without backfill", () => {
    const db = new Database(":memory:")
    db.exec("PRAGMA foreign_keys=ON")
    for (let i = 0; i < 12; i++) {
      db.exec(MIGRATIONS[i]!)
      db.exec(`PRAGMA user_version = ${i + 1}`)
    }
    db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('p', 'p', 'p', 'active', 1, 1)")
    db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t', 'legacy', 'p', 's', 'active', 0, 1, 1)")

    applyMigrations(db)

    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length)
    expect(db.query("SELECT * FROM team_event").all()).toEqual([])
    const indexes = db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'team_event'").all() as Array<{ name: string }>
    expect(indexes.map(row => row.name)).toEqual(expect.arrayContaining(["team_event_team_time_idx"]))
    expect(indexes.map(row => row.name)).toEqual(expect.arrayContaining([
      "team_event_kind_time_idx", "team_event_version_time_idx",
    ]))
    expect(indexes.map(row => row.name)).not.toContain("team_event_operation_idx")
  })

  test("migration 16 leaves legacy coverage unknown and creates an empty aggregate table", () => {
    const db = new Database(":memory:")
    for (let i = 0; i < 15; i++) {
      db.exec(MIGRATIONS[i]!)
      db.exec(`PRAGMA user_version = ${i + 1}`)
    }
    db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('p', 'p', 'p', 'active', 1, 1)")
    db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t', 'legacy', 'p', 's', 'active', 0, 1, 1)")
    db.run("INSERT INTO team_event (id, team_id, kind, payload, time_created) VALUES ('event_legacy', 't', 'team.created', '{}', 1)")

    applyMigrations(db)

    expect(db.query("SELECT instrumentation_version FROM team_event").get()).toEqual({ instrumentation_version: null })
    expect(db.query("SELECT * FROM team_usage_aggregate").all()).toEqual([])
  })

  test("migration 17 preserves existing telemetry and adds replay and immutability guards", () => {
    const db = new Database(":memory:")
    for (let i = 0; i < 16; i++) {
      db.exec(MIGRATIONS[i]!)
      db.exec(`PRAGMA user_version = ${i + 1}`)
    }
    db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('p', 'p', 'p', 'active', 1, 1)")
    db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t', 'legacy', 'p', 's', 'active', 0, 1, 1)")
    db.run("INSERT INTO team_event (id, team_id, kind, payload, time_created, instrumentation_version) VALUES ('event_legacy', 't', 'team.created', '{}', 1, 1)")

    applyMigrations(db)

    expect(db.query("SELECT id FROM team_event").all()).toEqual([{ id: "event_legacy" }])
    expect(db.query("SELECT * FROM team_usage_event").all()).toEqual([])
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(MIGRATIONS.length)
  })

  test("ordinary Team deletion cannot bypass immutable event retention", () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "team", "lead")
    const cause = appendTeamEvent(deps.db, { teamId: "t1", kind: "team.created", payload: {} })
    appendTeamEvent(deps.db, {
      teamId: "t1", kind: "team.archived", payload: {}, causeEventId: cause,
    })
    expect(() => deps.db.run("DELETE FROM team WHERE id = ?", ["t1"])).toThrow("immutable")
    expect(deps.db.query("SELECT id FROM team WHERE id = 't1'").all()).toHaveLength(1)
    expect(deps.db.query("SELECT id FROM team_event").all()).toHaveLength(2)
  })
})

describe("appendTeamEvent", () => {
  const forbidden = ["prompt", "content", "error", "model", "session", "branch", "path", "source"]
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "team", "lead")
  })

  test("accepts only the closed kind and payload allowlist", () => {
    appendTeamEvent(deps.db, { teamId: "t1", kind: "task.claimed", payload: { task_id: "task_1", assignee: "alice" } })
    expect(() => appendTeamEvent(deps.db, {
      teamId: "t1",
      kind: "task.claimed",
      payload: { task_id: "task_2", assignee: "alice", content: "secret" },
    } as never)).toThrow("payload")
    expect(() => appendTeamEvent(deps.db, {
      teamId: "t1",
      kind: "transport.retried",
      payload: {},
    } as never)).toThrow("event kind")
    expect(() => appendTeamEvent(deps.db, {
      teamId: "t1", kind: "task.claimed", payload: { task_id: "private task content", assignee: "alice" },
    })).toThrow("payload value")
  })

  test("accepts typed numeric enum and opaque ID values but rejects arbitrary strings", () => {
    appendTeamEvent(deps.db, {
      teamId: "t1",
      kind: "retry.observed",
      payload: { member_name: "alice", attempt: 0 },
    })
    appendTeamEvent(deps.db, {
      teamId: "t1",
      kind: "resume.linked",
      payload: { member_name: "bob", predecessor_name: "alice", context_truncated: true },
    })
    expect(() => appendTeamEvent(deps.db, {
      teamId: "t1",
      kind: "retry.observed",
      payload: { member_name: "alice", attempt: Number.NaN },
    })).toThrow("payload value")
    expect(() => appendTeamEvent(deps.db, {
      teamId: "t1",
      kind: "recovery.stage",
      payload: { member_name: "alice", mechanism: "private runtime detail", stage: "failed" },
    } as never)).toThrow("payload value")
    expect(() => appendTeamEvent(deps.db, {
      teamId: "t1",
      kind: "consultation.requested",
      payload: { consultation_id: "private question", task_id: "task_1", requester: "alice", planner: "bob" },
    })).toThrow("payload value")

    const rows = deps.db.query("SELECT instrumentation_version, payload FROM team_event ORDER BY time_created, id").all() as Array<{ instrumentation_version: number; payload: string }>
    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.instrumentation_version === 1)).toBe(true)
    expect(rows.map(row => row.payload).join("\n")).not.toContain("private")
  })

  test("rejects oversized identifiers before persistence and never persists forbidden fields", () => {
    expect(() => appendTeamEvent(deps.db, {
      teamId: "t1",
      kind: "task.created",
      payload: { task_id: `task_${"x".repeat(2048)}`, status: "pending" },
    })).toThrow("payload value")

    const rows = deps.db.query("SELECT payload FROM team_event").all() as Array<{ payload: string }>
    expect(rows).toEqual([])
    for (const field of forbidden) expect(JSON.stringify(rows)).not.toContain(`\"${field}\"`)
  })

  test("rebuilds payloads before serialization to resist custom toJSON and Proxy traps", () => {
    const payload = new Proxy({ task_id: "task_1", assignee: "alice" }, {
      get(target, property, receiver) {
        if (property === "toJSON") return () => ({ prompt: "private prompt", task_id: "stolen" })
        return Reflect.get(target, property, receiver)
      },
    })

    appendTeamEvent(deps.db, { teamId: "t1", kind: "task.claimed", payload })

    const row = deps.db.query("SELECT payload FROM team_event").get() as { payload: string }
    expect(JSON.parse(row.payload)).toEqual({ task_id: "task_1", assignee: "alice" })
    expect(row.payload).not.toContain("private")
    expect(row.payload).not.toContain("prompt")
  })

  test("stores validated cause identifiers without accepting caller operation identifiers", () => {
    const cause = appendTeamEvent(deps.db, {
      teamId: "t1", kind: "task.completed", payload: { task_id: "task_1" },
    })
    appendTeamEvent(deps.db, {
      teamId: "t1", kind: "task.unblocked", payload: { task_id: "task_2" }, causeEventId: cause,
    })
    const rows = deps.db.query("SELECT cause_event_id FROM team_event ORDER BY time_created, id").all() as EventRow[]
    expect(rows[1]).toMatchObject({ cause_event_id: cause })
    expect(() => appendTeamEvent(deps.db, {
      teamId: "t1", kind: "team.archived", payload: {}, operationId: "caller_chosen",
    } as never)).toThrow()
  })

  test("keeps rows immutable while allowing explicit Team purge deletion", () => {
    const id = appendTeamEvent(deps.db, { teamId: "t1", kind: "team.created", payload: {} })
    expect(() => deps.db.run("UPDATE team_event SET kind = 'team.archived' WHERE id = ?", [id])).toThrow("immutable")
    expect(() => deps.db.run("DELETE FROM team_event WHERE id = ?", [id])).toThrow("immutable")
    expect(() => deps.db.run(
      "INSERT OR REPLACE INTO team_event (id, team_id, kind, payload, time_created, instrumentation_version) VALUES (?, 't1', 'team.archived', '{}', 2, 1)",
      [id],
    )).toThrow("immutable")
    expect(() => deps.db.run(
      "REPLACE INTO team_event (id, team_id, kind, payload, time_created, instrumentation_version) VALUES (?, 't1', 'team.archived', '{}', 2, 1)",
      [id],
    )).toThrow("immutable")
    expect((deps.db.query("SELECT kind FROM team_event WHERE id = ?").get(id) as { kind: string }).kind).toBe("team.created")
  })

  test("keeps the delete guard active when an explicit purge deletion fails", () => {
    deps.db.run("UPDATE team SET status = 'archived' WHERE id = 't1'")
    const id = appendTeamEvent(deps.db, { teamId: "t1", kind: "team.created", payload: {} })
    deps.db.exec("CREATE TRIGGER reject_team_delete BEFORE DELETE ON team BEGIN SELECT RAISE(ABORT, 'reject purge'); END")

    expect(() => deleteArchivedTeamForExplicitPurge(deps.db, "t1")).toThrow("reject purge")
    expect(() => deps.db.run("DELETE FROM team_event WHERE id = ?", [id])).toThrow("immutable")
    expect(deps.db.query("SELECT team_id FROM team_purge_guard").all()).toEqual([])
  })
})

describe("team_event transactional callsites", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
  })

  test("records team, task, member, plan, merge, and archive-safe lifecycle events without private data", async () => {
    await executeTeamCreate(deps, { name: "events" }, "lead")
    const teamId = (deps.db.query("SELECT id FROM team WHERE name = 'events'").get() as { id: string }).id
    await executeTeamTasksAdd(deps, { tasks: [
      { key: "a", content: "private task A", priority: "high" },
      { key: "b", content: "private task B", priority: "low", depends_on: ["a"] },
    ] }, "lead")
    const taskA = (deps.db.query("SELECT id FROM team_task WHERE content = 'private task A'").get() as { id: string }).id
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "private prompt", plan_approval: true }, "lead")
    await executeTeamMessage(deps, { to: "alice", text: "private decision", approve: true }, "lead")
    await executeTeamClaim(deps, { task_id: taskA }, "lead")
    await executeTeamTasksComplete(deps, { task_id: taskA }, "lead")

    deps.db.run("UPDATE team_member SET status = 'shutdown' WHERE team_id = ? AND name = 'alice'", [teamId])
    deps.db.run("UPDATE team_member SET worktree_branch = 'private-branch' WHERE team_id = ? AND name = 'alice'", [teamId])
    await executeTeamMerge(deps, { member: "alice" }, "lead", async () => ({ ok: true }), async () => false, async () => [])

    const rows = deps.db.query("SELECT id, kind, payload, cause_event_id FROM team_event WHERE team_id = ? ORDER BY time_created, id").all(teamId) as EventRow[]
    expect(rows.map(row => row.kind)).toEqual(expect.arrayContaining([
      "team.created", "task.created", "member.registered", "plan.approved", "task.claimed",
      "task.completed", "task.unblocked", "merge.started", "merge.completed",
    ]))
    const serialized = rows.map(row => row.payload).join("\n")
    expect(serialized).not.toContain("private")
    expect(rows.every(row => new TextEncoder().encode(row.payload).length <= 2048)).toBe(true)
  })

  test("records rejected plans and failed merges only when their state changes", async () => {
    await executeTeamCreate(deps, { name: "failures" }, "lead")
    const teamId = (deps.db.query("SELECT id FROM team WHERE name = 'failures'").get() as { id: string }).id
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "private", plan_approval: true }, "lead")
    await executeTeamMessage(deps, { to: "alice", text: "private", reject: "private reason" }, "lead")
    deps.db.run("UPDATE team_member SET status = 'shutdown', worktree_branch = 'private-branch' WHERE team_id = ? AND name = 'alice'", [teamId])
    await executeTeamMerge(deps, { member: "alice" }, "lead", async () => ({ ok: false, error: "private error" }), async () => true, async () => [])

    const rows = deps.db.query("SELECT kind, payload FROM team_event WHERE team_id = ?").all(teamId) as EventRow[]
    expect(rows.map(row => row.kind)).toEqual(expect.arrayContaining(["plan.rejected", "merge.started", "merge.failed"]))
    expect(rows.map(row => row.payload).join("\n")).not.toContain("private")
  })

  test("records team.archived in the cleanup state transaction", async () => {
    await executeTeamCreate(deps, { name: "archive" }, "lead")
    const teamId = (deps.db.query("SELECT id FROM team WHERE name = 'archive'").get() as { id: string }).id
    await executeTeamCleanup(deps, { force: false }, "lead", undefined, async () => ({ ok: true }), async () => true, false)
    expect(deps.db.query("SELECT kind FROM team_event WHERE team_id = ? AND kind = 'team.archived'").all(teamId)).toHaveLength(1)
  })

  test("purging an archived team cascades its event history", async () => {
    insertTeam(deps.db, "t1", "old-team", "old-lead", "archived")
    appendTeamEvent(deps.db, { teamId: "t1", kind: "team.created", payload: {} })
    const preview = await executeTeamCleanup(
      deps, { force: false, purge: ["old-team"] }, "main", undefined,
      async () => ({ ok: true }), async () => true, false, undefined, undefined, async () => [],
    )
    const token = preview.match(/Confirmation token: (\S+)/)?.[1]
    if (!token) throw new Error("Expected purge confirmation token")
    const approvalLabel = deps.purgeApprovals.approvalLabel(token)
    deps.purgeApprovals.recordQuestionAnswer(
      "main",
      `User has answered your questions: "Delete?"="${approvalLabel}".`,
      { questions: [{ question: "Delete?", header: "Confirm", options: [
        { label: approvalLabel, description: "Delete" },
        { label: deps.purgeApprovals.denialLabel(token), description: "Keep" },
      ], multiple: false }] },
    )
    await executeTeamCleanup(
      deps, { force: false, purge: ["old-team"], confirm_purge: true, confirm_token: token }, "main", undefined,
      async () => ({ ok: true }), async () => true, false, undefined, undefined, async () => [],
    )
    expect(deps.db.query("SELECT id FROM team_event WHERE team_id = 't1'").all()).toEqual([])
    insertTeam(deps.db, "t2", "retained-team", "retained-lead", "archived")
    const retainedId = appendTeamEvent(deps.db, { teamId: "t2", kind: "team.created", payload: {} })
    expect(() => deps.db.run("DELETE FROM team_event WHERE id = ?", [retainedId])).toThrow("immutable")
  })

  test("event insertion failure rolls back team creation", async () => {
    deps.db.exec("CREATE TRIGGER reject_event BEFORE INSERT ON team_event BEGIN SELECT RAISE(ABORT, 'event rejected'); END")
    await expect(executeTeamCreate(deps, { name: "rollback" }, "lead")).rejects.toThrow("event rejected")
    expect(deps.db.query("SELECT id FROM team WHERE name = 'rollback'").get()).toBeNull()
  })

  test("event insertion failure rolls back a conditional task claim", async () => {
    insertTeam(deps.db, "t1", "team", "lead")
    await executeTeamTasksAdd(deps, { tasks: [{ content: "task", priority: "high" }] }, "lead")
    const taskId = (deps.db.query("SELECT id FROM team_task").get() as { id: string }).id
    deps.db.exec("CREATE TRIGGER reject_claim_event BEFORE INSERT ON team_event WHEN NEW.kind = 'task.claimed' BEGIN SELECT RAISE(ABORT, 'claim event rejected'); END")

    await expect(executeTeamClaim(deps, { task_id: taskId }, "lead")).rejects.toThrow("claim event rejected")
    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id = ?").get(taskId)).toEqual({ status: "pending", assignee: null })
  })

  test("event insertion failure rolls back an entire task creation batch", async () => {
    insertTeam(deps.db, "t1", "team", "lead")
    deps.db.exec("CREATE TRIGGER reject_task_event BEFORE INSERT ON team_event WHEN NEW.kind = 'task.created' BEGIN SELECT RAISE(ABORT, 'task event rejected'); END")
    await expect(executeTeamTasksAdd(deps, { tasks: [
      { content: "one", priority: "high" },
      { content: "two", priority: "low" },
    ] }, "lead")).rejects.toThrow("task event rejected")
    expect(deps.db.query("SELECT id FROM team_task WHERE team_id = 't1'").all()).toEqual([])
  })

  test("event insertion failure rolls back a plan decision and its message", async () => {
    await executeTeamCreate(deps, { name: "plan-rollback" }, "lead")
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "private", plan_approval: true }, "lead")
    deps.db.exec("CREATE TRIGGER reject_plan_event BEFORE INSERT ON team_event WHEN NEW.kind = 'plan.approved' BEGIN SELECT RAISE(ABORT, 'plan event rejected'); END")
    await expect(executeTeamMessage(deps, { to: "alice", text: "private", approve: true }, "lead")).rejects.toThrow("plan event rejected")
    expect(deps.db.query("SELECT plan_approval FROM team_member WHERE name = 'alice'").get()).toEqual({ plan_approval: "pending" })
    expect(deps.db.query("SELECT id FROM team_message WHERE to_name = 'alice'").all()).toEqual([])
  })

  test("team_spawn claim_task records its task claim transaction", async () => {
    await executeTeamCreate(deps, { name: "spawn-claim" }, "lead")
    await executeTeamTasksAdd(deps, { tasks: [{ content: "task", priority: "high" }] }, "lead")
    const taskId = (deps.db.query("SELECT id FROM team_task").get() as { id: string }).id
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "private", claim_task: taskId }, "lead")
    const rows = deps.db.query("SELECT payload FROM team_event WHERE kind = 'task.claimed'").all() as Array<{ payload: string }>
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]?.payload ?? "null")).toEqual({ task_id: taskId, assignee: "alice" })
  })

  test("team_spawn rollback releases the exact claim with privacy-safe causality", async () => {
    await executeTeamCreate(deps, { name: "spawn-release" }, "lead")
    await executeTeamTasksAdd(deps, { tasks: [{ content: "private task", priority: "high" }] }, "lead")
    const taskId = (deps.db.query("SELECT id FROM team_task").get() as { id: string }).id
    deps.client.session.create = async () => { throw new Error("private session error") }

    await expect(executeTeamSpawn(deps, {
      name: "alice", agent: "build", prompt: "private prompt", claim_task: taskId,
    }, "lead")).rejects.toThrow("private session error")

    const rows = deps.db.query(
      "SELECT id, kind, payload, cause_event_id FROM team_event WHERE kind IN ('task.claimed', 'task.released') ORDER BY time_created, id",
    ).all() as EventRow[]
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ kind: "task.released", cause_event_id: rows[0]?.id })
    expect(JSON.parse(rows[1]?.payload ?? "null")).toEqual({ task_id: taskId, reason: "spawn_rollback" })
    expect(rows.map(row => row.payload).join("\n")).not.toContain("private")
  })

  test("task release event insertion failure rolls back the conditional spawn claim release", async () => {
    await executeTeamCreate(deps, { name: "release-rollback" }, "lead")
    await executeTeamTasksAdd(deps, { tasks: [{ content: "task", priority: "high" }] }, "lead")
    const taskId = (deps.db.query("SELECT id FROM team_task").get() as { id: string }).id
    deps.client.session.create = async () => { throw new Error("session failed") }
    deps.db.exec("CREATE TRIGGER reject_release_event BEFORE INSERT ON team_event WHEN NEW.kind = 'task.released' BEGIN SELECT RAISE(ABORT, 'release event rejected'); END")

    await expect(executeTeamSpawn(deps, {
      name: "alice", agent: "build", prompt: "prompt", claim_task: taskId,
    }, "lead")).rejects.toThrow("release event rejected")

    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id = ?").get(taskId))
      .toEqual({ status: "in_progress", assignee: "alice" })
    expect(deps.db.query("SELECT id FROM team_event WHERE kind = 'task.released'").all()).toEqual([])
  })

  test("team_spawn releases its exact claim when session creation returns no session id", async () => {
    await executeTeamCreate(deps, { name: "missing-session" }, "lead")
    await executeTeamTasksAdd(deps, { tasks: [{ content: "task", priority: "high" }] }, "lead")
    const taskId = (deps.db.query("SELECT id FROM team_task").get() as { id: string }).id
    deps.client.session.create = async () => ({})

    await expect(executeTeamSpawn(deps, {
      name: "alice", agent: "build", prompt: "prompt", claim_task: taskId,
    }, "lead")).rejects.toThrow("Failed to create teammate session")

    const events = deps.db.query(
      "SELECT id, kind, cause_event_id FROM team_event WHERE kind IN ('task.claimed', 'task.released') ORDER BY time_created, id",
    ).all() as EventRow[]
    expect(events.map(event => event.kind)).toEqual(["task.claimed", "task.released"])
    expect(events[1]?.cause_event_id).toBe(events[0]?.id)
    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id = ?").get(taskId))
      .toEqual({ status: "pending", assignee: null })
  })

  test("merge terminal events reference their exact merge.started event", async () => {
    await executeTeamCreate(deps, { name: "merge-causes" }, "lead")
    const teamId = (deps.db.query("SELECT id FROM team WHERE name = 'merge-causes'").get() as { id: string }).id
    await executeTeamSpawn(deps, { name: "alice", agent: "build", prompt: "private" }, "lead")
    deps.db.run("UPDATE team_member SET status = 'shutdown', worktree_branch = 'branch-a' WHERE name = 'alice'")
    await executeTeamMerge(deps, { member: "alice" }, "lead", async () => ({ ok: false, error: "private" }), async () => true, async () => [])
    deps.db.run("UPDATE team_member SET worktree_branch = 'branch-b' WHERE name = 'alice'")
    await executeTeamMerge(deps, { member: "alice" }, "lead", async () => ({ ok: true }), async () => false, async () => [])

    const events = deps.db.query(
      "SELECT id, kind, cause_event_id FROM team_event WHERE team_id = ? AND kind LIKE 'merge.%' ORDER BY time_created, id",
    ).all(teamId) as EventRow[]
    expect(events.map(event => event.kind)).toEqual(["merge.started", "merge.failed", "merge.started", "merge.completed"])
    expect(events[1]?.cause_event_id).toBe(events[0]?.id)
    expect(events[3]?.cause_event_id).toBe(events[2]?.id)
  })

  test("conditional claim update emits exactly one event under competition", async () => {
    insertTeam(deps.db, "t1", "team", "lead")
    insertMember(deps.db, "t1", "alice", "alice-session")
    insertMember(deps.db, "t1", "bob", "bob-session")
    deps.registry.register("t1", "alice", "alice-session")
    deps.registry.register("t1", "bob", "bob-session")
    await executeTeamTasksAdd(deps, { tasks: [{ content: "task", priority: "high" }] }, "lead")
    const taskId = (deps.db.query("SELECT id FROM team_task").get() as { id: string }).id

    const results = await Promise.allSettled([
      executeTeamClaim(deps, { task_id: taskId }, "alice-session"),
      executeTeamClaim(deps, { task_id: taskId }, "bob-session"),
    ])

    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
    expect(deps.db.query("SELECT id FROM team_event WHERE kind = 'task.claimed' AND json_extract(payload, '$.task_id') = ?").all(taskId)).toHaveLength(1)
  })

  test("already completed changes=0 emits no second event", async () => {
    insertTeam(deps.db, "t1", "team", "lead")
    await executeTeamTasksAdd(deps, { tasks: [{ content: "task", priority: "high" }] }, "lead")
    const taskId = (deps.db.query("SELECT id FROM team_task").get() as { id: string }).id
    await executeTeamClaim(deps, { task_id: taskId }, "lead")
    await executeTeamTasksComplete(deps, { task_id: taskId }, "lead")
    await executeTeamTasksComplete(deps, { task_id: taskId }, "lead")
    expect(deps.db.query("SELECT id FROM team_event WHERE kind = 'task.completed'").all()).toHaveLength(1)
  })
})
