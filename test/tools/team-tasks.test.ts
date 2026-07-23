import { describe, test, expect, beforeEach } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "../helpers"
import { executeTeamTasksList } from "../../src/tools/team-tasks-list"
import { executeTeamTasksAdd } from "../../src/tools/team-tasks-add"
import { executeTeamTasksComplete } from "../../src/tools/team-tasks-complete"
import { executeTeamClaim } from "../../src/tools/team-claim"
import { parseTaskResult } from "../../src/result-parser"
import { recomputeCurrentPhase } from "../../src/task-phase"

describe("team_tasks_list", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    deps.registry.register("t1", "alice", "sess-alice")
  })

  test("returns empty message when no tasks", async () => {
    const result = await executeTeamTasksList(deps, "sess-alice")
    expect(result).toContain("No tasks")
  })

  test("lists tasks with status and assignee", async () => {
    await executeTeamTasksAdd(deps, { tasks: [
      { content: "Fix bug", priority: "high" },
      { content: "Write docs", priority: "low" },
    ] }, "sess-alice")

    const result = await executeTeamTasksList(deps, "sess-alice")
    expect(result).toContain("Fix bug")
    expect(result).toContain("Write docs")
    expect(result).toContain("pending")
  })

  test("presents dependency-blocked tasks as waiting", async () => {
    const result = await executeTeamTasksAdd(deps, { tasks: [
      { key: "first", content: "First", priority: "high" },
      { content: "Second", priority: "medium", depends_on: ["first"] },
    ] }, "sess-alice")

    expect(result).toContain("first=")
    const board = await executeTeamTasksList(deps, "sess-alice")
    expect(board).toContain("[waiting] Second")
    expect(board).not.toContain("[blocked] Second")
    expect(deps.db.query("SELECT status FROM team_task WHERE content = 'Second'").get())
      .toEqual({ status: "blocked" })
  })

  test("rejects if not in a team", async () => {
    await expect(executeTeamTasksList(deps, "random-sess"))
      .rejects.toThrow("not in a team")
  })
})

describe("team_tasks_add", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    deps.registry.register("t1", "alice", "sess-alice")
  })

  test("adds tasks and returns IDs", async () => {
    const result = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Task A", priority: "high" },
      { content: "Task B", priority: "medium" },
    ] }, "sess-alice")

    expect(result).toContain("Added 2 task")
    const rows = deps.db.query("SELECT * FROM team_task WHERE team_id = ?").all("t1")
    expect(rows).toHaveLength(2)
  })

  test("adds tasks with dependencies", async () => {
    const result1 = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Task A", priority: "high" },
    ] }, "sess-alice")
    // Extract the task ID from the result
    const idMatch = result1.match(/task_\S+/)
    expect(idMatch).toBeTruthy()
    const taskAId = idMatch![0]

    await executeTeamTasksAdd(deps, { tasks: [
      { content: "Task B", priority: "medium", depends_on: [taskAId!] },
    ] }, "sess-alice")

    const taskB = deps.db.query("SELECT * FROM team_task WHERE content = ?").get("Task B") as Record<string, unknown>
    expect(taskB.depends_on).toBeTruthy()
    expect(taskB.status).toBe("blocked")
  })

  test("resolves batch-local dependency keys atomically", async () => {
    const result = await executeTeamTasksAdd(deps, { tasks: [
      { key: "contract", content: "Define contract", priority: "high" },
      { key: "backend", content: "Build backend", priority: "high", depends_on: ["contract"] },
      { key: "integration", content: "Integrate", priority: "medium", depends_on: ["backend"] },
    ] }, "sess-alice")

    expect(result).toContain("contract=")
    expect(result).toContain("backend=")
    const rows = deps.db.query("SELECT id, content, status, depends_on FROM team_task WHERE team_id = ? ORDER BY time_created, id")
      .all("t1") as Array<{ id: string; content: string; status: string; depends_on: string | null }>
    const contract = rows.find(row => row.content === "Define contract")!
    const backend = rows.find(row => row.content === "Build backend")!
    const integration = rows.find(row => row.content === "Integrate")!
    expect(contract.status).toBe("pending")
    expect(backend.status).toBe("blocked")
    expect(JSON.parse(backend.depends_on!)).toEqual([contract.id])
    expect(JSON.parse(integration.depends_on!)).toEqual([backend.id])
  })

  test("rejects missing dependency IDs without inserting partial tasks", async () => {
    await expect(executeTeamTasksAdd(deps, { tasks: [
      { key: "valid", content: "Would otherwise insert", priority: "high" },
      { content: "Broken", priority: "high", depends_on: ["task_missing"] },
    ] }, "sess-alice")).rejects.toThrow("not found")

    expect(deps.db.query("SELECT id FROM team_task WHERE team_id = ?").all("t1")).toHaveLength(0)
  })

  test("rejects cyclic batch dependencies without inserting tasks", async () => {
    await expect(executeTeamTasksAdd(deps, { tasks: [
      { key: "a", content: "A", priority: "high", depends_on: ["b"] },
      { key: "b", content: "B", priority: "high", depends_on: ["a"] },
    ] }, "sess-alice")).rejects.toThrow("cycle")

    expect(deps.db.query("SELECT id FROM team_task WHERE team_id = ?").all("t1")).toHaveLength(0)
  })

  test("rejects if not in a team", async () => {
    await expect(executeTeamTasksAdd(deps, { tasks: [{ content: "x", priority: "medium" }] }, "random-sess"))
      .rejects.toThrow("not in a team")
  })

  test("lead can add tasks", async () => {
    const result = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Lead task", priority: "high" },
    ] }, "lead-sess")
    expect(result).toContain("Added 1 task")
  })
})

describe("team_tasks_complete", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    deps.registry.register("t1", "alice", "sess-alice")
  })

  test("marks a task as completed", async () => {
    const addResult = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Fix bug", priority: "high" },
    ] }, "sess-alice")
    const taskId = addResult.match(/task_\S+/)![0]!

    // Claim it first
    await executeTeamClaim(deps, { task_id: taskId }, "sess-alice")

    const result = await executeTeamTasksComplete(deps, { task_id: taskId }, "sess-alice")
    expect(result).toContain("Completed")
    expect(result).toContain("Fix bug")

    const row = deps.db.query("SELECT status FROM team_task WHERE id = ?").get(taskId) as Record<string, string>
    expect(row.status).toBe("completed")
  })

  test("fires a progress toast on completion", async () => {
    const addResult = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Task A", priority: "high" },
      { content: "Task B", priority: "high" },
    ] }, "sess-alice")
    const taskIds = [...addResult.matchAll(/task_[a-z0-9_]+/g)].map(m => m[0])

    await executeTeamClaim(deps, { task_id: taskIds[0]! }, "sess-alice")
    await executeTeamTasksComplete(deps, { task_id: taskIds[0]! }, "sess-alice")

    const toasts = deps.client.calls.filter(c => c.method === "tui.showToast")
    expect(toasts.length).toBeGreaterThanOrEqual(1)
    const last = toasts[toasts.length - 1]!.args[0] as { message: string }
    expect(last.message).toContain("1/2 tasks complete")
  })

  test("persists and wakes one Lead event for the first completion only", async () => {
    const addResult = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Task A", priority: "high" },
    ] }, "sess-alice")
    const taskId = addResult.match(/task_\S+/)![0]!
    await executeTeamClaim(deps, { task_id: taskId }, "sess-alice")
    deps.client.calls.length = 0

    await executeTeamTasksComplete(deps, { task_id: taskId }, "sess-alice")
    await executeTeamTasksComplete(deps, { task_id: taskId }, "sess-alice")

    const events = deps.db.query(
      "SELECT content FROM team_message WHERE team_id = 't1' AND from_name = 'system' AND to_name = 'lead'",
    ).all() as Array<{ content: string }>
    expect(events).toHaveLength(1)
    expect(events[0]!.content).toContain(taskId)
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(1)
  })

  test("derives current phase from the ready task frontier", async () => {
    await executeTeamTasksAdd(deps, { tasks: [
      { key: "research", content: "Research", priority: "high", phase: "discovery" },
      { key: "build", content: "Build", priority: "high", depends_on: ["research"], phase: "implementation" },
      { key: "review", content: "Review", priority: "medium", depends_on: ["build"], phase: "verification" },
    ] }, "sess-alice")

    expect(deps.db.query("SELECT current_phase FROM team WHERE id = 't1'").get())
      .toEqual({ current_phase: "discovery" })
    const board = await executeTeamTasksList(deps, "sess-alice")
    expect(board).toContain("phase: discovery")
    expect(board).toContain("phase: implementation")
  })

  test("prefers an in-progress phase and clears it when no active frontier remains", async () => {
    const added = await executeTeamTasksAdd(deps, { tasks: [
      { key: "first", content: "First", priority: "high", phase: "discovery" },
      { key: "second", content: "Second", priority: "high", phase: "implementation" },
    ] }, "sess-alice")
    expect(added).toContain("first=")
    const firstId = (deps.db.query("SELECT id FROM team_task WHERE content = 'First'").get() as { id: string }).id
    const secondId = (deps.db.query("SELECT id FROM team_task WHERE content = 'Second'").get() as { id: string }).id
    expect(firstId).toBeTruthy()
    expect(secondId).toBeTruthy()

    await executeTeamClaim(deps, { task_id: secondId! }, "sess-alice")
    expect(deps.db.query("SELECT current_phase FROM team WHERE id = 't1'").get())
      .toEqual({ current_phase: "implementation" })

    deps.db.run("UPDATE team_task SET status = 'completed' WHERE id = ?", [secondId!])
    recomputeCurrentPhase(deps.db, "t1", Date.now())
    expect(deps.db.query("SELECT current_phase FROM team WHERE id = 't1'").get())
      .toEqual({ current_phase: "discovery" })
    deps.db.run("UPDATE team_task SET status = 'completed' WHERE id = ?", [firstId!])
    recomputeCurrentPhase(deps.db, "t1", Date.now())
    expect(deps.db.query("SELECT current_phase FROM team WHERE id = 't1'").get())
      .toEqual({ current_phase: null })
  })

  test("unblocks dependent tasks when completed", async () => {
    const r1 = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Task A", priority: "high" },
    ] }, "sess-alice")
    const taskAId = r1.match(/task_\S+/)![0]!

    await executeTeamTasksAdd(deps, { tasks: [
      { content: "Task B", priority: "medium", depends_on: [taskAId] },
    ] }, "sess-alice")

    // Task B should be blocked
    const taskBBefore = deps.db.query("SELECT status FROM team_task WHERE content = ?").get("Task B") as Record<string, string>
    expect(taskBBefore.status).toBe("blocked")

    // Claim and complete Task A
    await executeTeamClaim(deps, { task_id: taskAId }, "sess-alice")
    await executeTeamTasksComplete(deps, { task_id: taskAId }, "sess-alice")

    // Task B should now be pending
    const taskBAfter = deps.db.query("SELECT status FROM team_task WHERE content = ?").get("Task B") as Record<string, string>
    expect(taskBAfter.status).toBe("pending")
  })

  test("atomically completes an owned task, reports its result, and wakes Lead once", async () => {
    const resultA = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Task A", priority: "high", phase: "implementation" },
    ] }, "sess-alice")
    const taskAId = resultA.match(/task_\S+/)![0]!
    await executeTeamTasksAdd(deps, { tasks: [
      { content: "Task B", priority: "high", depends_on: [taskAId], phase: "verification" },
    ] }, "sess-alice")
    await executeTeamClaim(deps, { task_id: taskAId }, "sess-alice")
    deps.client.calls.length = 0

    await executeTeamTasksComplete(deps, {
      task_id: taskAId,
      result: {
        summary: "Implemented the fix",
        details: "Changed the transaction and added tests.",
        branch: "ensemble/example/alice",
      },
    }, "sess-alice")

    const taskA = deps.db.query("SELECT status FROM team_task WHERE id = ?").get(taskAId)
    const taskB = deps.db.query("SELECT status FROM team_task WHERE content = 'Task B'").get()
    expect(taskA).toEqual({ status: "completed" })
    expect(taskB).toEqual({ status: "pending" })
    expect(deps.db.query("SELECT current_phase FROM team WHERE id = 't1'").get())
      .toEqual({ current_phase: "verification" })
    expect(deps.db.query(
      "SELECT execution_status, reported_to_lead FROM team_member WHERE team_id = 't1' AND name = 'alice'",
    ).get()).toEqual({ execution_status: "completed", reported_to_lead: 1 })

    const messages = deps.db.query(
      "SELECT from_name, to_name, content FROM team_message WHERE team_id = 't1'",
    ).all() as Array<{ from_name: string; to_name: string; content: string }>
    expect(messages).toHaveLength(1)
    expect(messages[0]!.from_name).toBe("alice")
    expect(messages[0]!.to_name).toBe("lead")
    expect(parseTaskResult(messages[0]!.content)).toEqual({
      kind: "result",
      taskId: taskAId,
      status: "completed",
      summary: "Implemented the fix",
      details: "Changed the transaction and added tests.",
      branch: "ensemble/example/alice",
    })
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(1)
  })

  test("rejects an atomic result from a non-owner without changing state", async () => {
    insertMember(deps.db, "t1", "bob", "sess-bob")
    deps.registry.register("t1", "bob", "sess-bob")
    const added = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Owned task", priority: "high" },
    ] }, "sess-alice")
    const taskId = added.match(/task_\S+/)![0]!
    await executeTeamClaim(deps, { task_id: taskId }, "sess-alice")
    deps.client.calls.length = 0

    await expect(executeTeamTasksComplete(deps, {
      task_id: taskId,
      result: { summary: "Not mine", details: "Tried to complete another member's task." },
    }, "sess-bob")).rejects.toThrow("owned by alice")

    expect(deps.db.query("SELECT status FROM team_task WHERE id = ?").get(taskId)).toEqual({ status: "in_progress" })
    expect(deps.db.query("SELECT id FROM team_message WHERE team_id = 't1'").all()).toHaveLength(0)
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(0)
  })

  test("rejects an oversized atomic result before completing the task", async () => {
    const added = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Large result", priority: "high" },
    ] }, "sess-alice")
    const taskId = added.match(/task_\S+/)![0]!
    await executeTeamClaim(deps, { task_id: taskId }, "sess-alice")
    deps.client.calls.length = 0

    await expect(executeTeamTasksComplete(deps, {
      task_id: taskId,
      result: { summary: "Large", details: "x".repeat(11 * 1024) },
    }, "sess-alice")).rejects.toThrow("10KB")

    expect(deps.db.query("SELECT status FROM team_task WHERE id = ?").get(taskId)).toEqual({ status: "in_progress" })
    expect(deps.db.query("SELECT id FROM team_message WHERE team_id = 't1'").all()).toHaveLength(0)
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(0)
  })

  test("rolls back task, dependency, and reporting state when result insertion fails", async () => {
    const added = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Atomic task", priority: "high" },
    ] }, "sess-alice")
    const taskId = added.match(/task_\S+/)![0]!
    await executeTeamTasksAdd(deps, { tasks: [
      { content: "Dependent", priority: "high", depends_on: [taskId] },
    ] }, "sess-alice")
    await executeTeamClaim(deps, { task_id: taskId }, "sess-alice")
    deps.db.exec("CREATE TRIGGER fail_terminal_result BEFORE INSERT ON team_message BEGIN SELECT RAISE(ABORT, 'message insert failed'); END")
    deps.client.calls.length = 0

    await expect(executeTeamTasksComplete(deps, {
      task_id: taskId,
      result: { summary: "Done", details: "Should roll back." },
    }, "sess-alice")).rejects.toThrow("message insert failed")

    expect(deps.db.query("SELECT status FROM team_task WHERE id = ?").get(taskId)).toEqual({ status: "in_progress" })
    expect(deps.db.query("SELECT status FROM team_task WHERE content = 'Dependent'").get()).toEqual({ status: "blocked" })
    expect(deps.db.query(
      "SELECT execution_status, reported_to_lead FROM team_member WHERE team_id = 't1' AND name = 'alice'",
    ).get()).toEqual({ execution_status: "idle", reported_to_lead: 0 })
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(0)
  })

  test("does not duplicate an atomic result or wake when completion is retried", async () => {
    const added = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Retry task", priority: "high" },
    ] }, "sess-alice")
    const taskId = added.match(/task_\S+/)![0]!
    await executeTeamClaim(deps, { task_id: taskId }, "sess-alice")
    const args = {
      task_id: taskId,
      result: { summary: "Done once", details: "The retry is idempotent." },
    }
    deps.client.calls.length = 0

    const results = await Promise.all([
      executeTeamTasksComplete(deps, args, "sess-alice"),
      executeTeamTasksComplete(deps, args, "sess-alice"),
    ])

    expect(results.some(result => result.includes("already completed"))).toBe(true)
    expect(deps.db.query("SELECT id FROM team_message WHERE team_id = 't1'").all()).toHaveLength(1)
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(1)
  })

  test("rejects if task not found", async () => {
    await expect(executeTeamTasksComplete(deps, { task_id: "nonexistent" }, "sess-alice"))
      .rejects.toThrow("not found")
  })

  test("rejects if not in a team", async () => {
    await expect(executeTeamTasksComplete(deps, { task_id: "x" }, "random-sess"))
      .rejects.toThrow("not in a team")
  })
})

describe("team_claim", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    insertMember(deps.db, "t1", "bob", "sess-bob")
    deps.registry.register("t1", "alice", "sess-alice")
    deps.registry.register("t1", "bob", "sess-bob")
  })

  test("claims a pending task", async () => {
    const addResult = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Fix bug", priority: "high" },
    ] }, "sess-alice")
    const taskId = addResult.match(/task_\S+/)![0]!

    const result = await executeTeamClaim(deps, { task_id: taskId }, "sess-alice")
    expect(result).toContain("Claimed")
    expect(result).toContain("Fix bug")

    const row = deps.db.query("SELECT status, assignee FROM team_task WHERE id = ?").get(taskId) as Record<string, string>
    expect(row.status).toBe("in_progress")
    expect(row.assignee).toBe("alice")
  })

  test("rejects claiming an already-claimed task", async () => {
    const addResult = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Fix bug", priority: "high" },
    ] }, "sess-alice")
    const taskId = addResult.match(/task_\S+/)![0]!

    await executeTeamClaim(deps, { task_id: taskId }, "sess-alice")
    await expect(executeTeamClaim(deps, { task_id: taskId }, "sess-bob"))
      .rejects.toThrow("not pending")
  })

  test("rejects claiming a blocked task", async () => {
    const r1 = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Task A", priority: "high" },
    ] }, "sess-alice")
    const taskAId = r1.match(/task_\S+/)![0]!

    const r2 = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Task B", priority: "medium", depends_on: [taskAId] },
    ] }, "sess-alice")
    const taskBId = r2.match(/task_\S+/)![0]!

    await expect(executeTeamClaim(deps, { task_id: taskBId }, "sess-alice"))
      .rejects.toThrow("waiting")
  })

  test("rejects if task not found", async () => {
    await expect(executeTeamClaim(deps, { task_id: "nonexistent" }, "sess-alice"))
      .rejects.toThrow("not found")
  })

  test("race condition: two concurrent claims, only one succeeds", async () => {
    const addResult = await executeTeamTasksAdd(deps, { tasks: [
      { content: "Contested task", priority: "high" },
    ] }, "sess-alice")
    const taskId = addResult.match(/task_\S+/)![0]!

    const results = await Promise.allSettled([
      executeTeamClaim(deps, { task_id: taskId }, "sess-alice"),
      executeTeamClaim(deps, { task_id: taskId }, "sess-bob"),
    ])

    const fulfilled = results.filter(r => r.status === "fulfilled")
    const rejected = results.filter(r => r.status === "rejected")
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
  })
})
