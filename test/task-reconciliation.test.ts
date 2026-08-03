import { beforeEach, describe, expect, test } from "bun:test"
import { handleSessionErrorEvent, handleSessionStatusEvent } from "../src/hooks"
import { executeTeamClaim } from "../src/tools/team-claim"
import { executeTeamMessage } from "../src/tools/team-message"
import { executeTeamTasksAdd } from "../src/tools/team-tasks-add"
import { executeTeamTasksComplete } from "../src/tools/team-tasks-complete"
import { insertMember, insertTeam, setupDeps } from "./helpers"

describe("task/result reconciliation", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(async () => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "reconcile", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice", "busy", "running")
    deps.registry.register("t1", "alice", "sess-alice")
    const added = await executeTeamTasksAdd(deps, { tasks: [{ content: "Owned work", priority: "high" }] }, "lead-sess")
    const taskId = added.match(/task_\S+/)?.[0]
    if (!taskId) throw new Error("Expected task id")
    await executeTeamClaim(deps, { task_id: taskId }, "sess-alice")
    deps.client.calls.length = 0
  })

  test("surfaces a terminal structured result without completing its owned task", async () => {
    const taskId = (deps.db.query("SELECT id FROM team_task WHERE team_id = 't1'").get() as { id: string }).id
    const terminal = `<task-result><kind>result</kind><task_id>${taskId}</task_id><status>completed</status><summary>Implemented</summary><details>Focused tests pass.</details></task-result>`

    await executeTeamMessage(deps, { to: "lead", text: terminal }, "sess-alice")

    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id = ?").get(taskId))
      .toEqual({ status: "in_progress", assignee: "alice" })
    const messages = deps.db.query("SELECT from_name, content FROM team_message ORDER BY time_created, id").all() as Array<{ from_name: string; content: string }>
    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual({ from_name: "alice", content: terminal })
    expect(messages[1]?.content).toContain(`Task reconciliation required`)
    expect(messages[1]?.content).toContain(taskId)
    expect(messages[1]?.content).toContain("team_tasks_complete only for successful work")
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(1)
  })

  test("surfaces a failed terminal result without inventing failure recovery transitions", async () => {
    const taskId = (deps.db.query("SELECT id FROM team_task WHERE team_id = 't1'").get() as { id: string }).id
    const terminal = `<task-result><kind>result</kind><task_id>${taskId}</task_id><status>failed</status><summary>Blocked by provider</summary><details>No source changes were made.</details></task-result>`

    await executeTeamMessage(deps, { to: "lead", text: terminal }, "sess-alice")

    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id = ?").get(taskId))
      .toEqual({ status: "in_progress", assignee: "alice" })
    expect(deps.db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get())
      .toEqual({ status: "busy", execution_status: "running" })
    const alert = deps.db.query("SELECT content FROM team_message WHERE from_name = 'system'").get() as { content: string }
    expect(alert.content).toContain("normal shutdown/recovery flow")
  })

  test("records one idle inconsistency while preserving task ownership and state", () => {
    const taskId = (deps.db.query("SELECT id FROM team_task WHERE team_id = 't1'").get() as { id: string }).id

    const transition = handleSessionStatusEvent(deps.db, deps.registry, "sess-alice", "idle")
    const repeated = handleSessionStatusEvent(deps.db, deps.registry, "sess-alice", "idle")

    expect(transition).toEqual({
      memberName: "alice",
      teamId: "t1",
      from: "busy",
      to: "ready",
      reconciliationAlert: true,
    })
    expect(repeated).toBeUndefined()
    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id = ?").get(taskId))
      .toEqual({ status: "in_progress", assignee: "alice" })
    expect(deps.db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get())
      .toEqual({ status: "ready", execution_status: "idle" })
    expect(deps.db.query("SELECT id FROM team_message WHERE from_name = 'system'").all()).toHaveLength(1)
  })

  test("leaves ordinary atomic completion as the only success transition", async () => {
    const taskId = (deps.db.query("SELECT id FROM team_task WHERE team_id = 't1'").get() as { id: string }).id

    await executeTeamTasksComplete(deps, {
      task_id: taskId,
      result: { summary: "Implemented", details: "Focused tests pass." },
    }, "sess-alice")

    expect(deps.db.query("SELECT status FROM team_task WHERE id = ?").get(taskId)).toEqual({ status: "completed" })
    expect(deps.db.query("SELECT id FROM team_message WHERE from_name = 'system'").all()).toHaveLength(0)
  })

  test("rolls back a terminal report when its reconciliation alert cannot be persisted", async () => {
    const taskId = (deps.db.query("SELECT id FROM team_task WHERE team_id = 't1'").get() as { id: string }).id
    deps.db.exec("CREATE TRIGGER reject_reconciliation BEFORE INSERT ON team_message WHEN NEW.from_name = 'system' BEGIN SELECT RAISE(ABORT, 'alert rejected'); END")
    const terminal = `<task-result><kind>result</kind><task_id>${taskId}</task_id><status>completed</status><summary>Done</summary><details>Evidence.</details></task-result>`

    await expect(executeTeamMessage(deps, { to: "lead", text: terminal }, "sess-alice"))
      .rejects.toThrow("alert rejected")

    expect(deps.db.query("SELECT id FROM team_message").all()).toHaveLength(0)
    expect(deps.db.query("SELECT status FROM team_task WHERE id = ?").get(taskId)).toEqual({ status: "in_progress" })
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(0)
  })

  test("keeps normal session-error recovery authoritative instead of emitting reconciliation", () => {
    const taskId = (deps.db.query("SELECT id FROM team_task WHERE team_id = 't1'").get() as { id: string }).id

    const alert = handleSessionErrorEvent(deps.db, deps.registry, "sess-alice", { name: "ProviderError" })

    expect(alert).toEqual({ leadSessionId: "lead-sess", memberName: "alice" })
    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id = ?").get(taskId))
      .toEqual({ status: "pending", assignee: null })
    const messages = deps.db.query("SELECT content FROM team_message WHERE from_name = 'system'").all() as Array<{ content: string }>
    expect(messages).toHaveLength(1)
    expect(messages[0]?.content).toContain("failed with a session error")
    expect(messages[0]?.content).not.toContain("Task reconciliation required")
  })
})
