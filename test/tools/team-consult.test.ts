import { beforeEach, describe, expect, test } from "bun:test"
import { executeTeamConsult } from "../../src/tools/team-consult"
import { executeTeamConsultReply } from "../../src/tools/team-consult-reply"
import { insertMember, insertTeam, setupDeps } from "../helpers"

describe("team consultation", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "builder", "builder-sess", "ready", "idle")
    insertMember(deps.db, "t1", "planner", "planner-sess", "ready", "idle")
    deps.db.run("UPDATE team_member SET profile = 'backend' WHERE team_id = 't1' AND name = 'builder'")
    deps.db.run("UPDATE team_member SET profile = 'planner', agent = 'plan' WHERE team_id = 't1' AND name = 'planner'")
    deps.registry.register("t1", "builder", "builder-sess")
    deps.registry.register("t1", "planner", "planner-sess")
    deps.db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES ('task-1', 't1', 'Implement API', 'in_progress', 'high', 'builder', 1, 1)",
    )
  })

  test("persists a technical consultation and wakes only the selected planner", async () => {
    const result = await executeTeamConsult(
      deps,
      { task_id: "task-1", question: "Should retries own idempotency?", planner: "planner" },
      "builder-sess",
    )

    expect(result).toContain("waiting")
    const member = deps.db.query(
      "SELECT consult_id, consult_state, consult_task_id, consult_planner FROM team_member WHERE name = 'builder'",
    ).get() as Record<string, unknown>
    expect(member.consult_id).toBeString()
    expect(member).toMatchObject({ consult_state: "waiting", consult_task_id: "task-1", consult_planner: "planner" })
    const prompts = deps.client.calls.filter((call) => call.method === "session.promptAsync")
    expect(prompts).toHaveLength(1)
    expect((prompts[0]!.args[0] as { sessionID: string }).sessionID).toBe("planner-sess")
    const requestEvent = deps.db.query("SELECT payload FROM team_event WHERE kind = 'consultation.requested'").get() as { payload: string }
    expect(JSON.parse(requestEvent.payload)).toMatchObject({ task_id: "task-1", requester: "builder", planner: "planner" })
    expect(requestEvent.payload).not.toContain("idempotency")
  })

  test("planner reply atomically resolves the wait and wakes only the requester", async () => {
    await executeTeamConsult(
      deps,
      { task_id: "task-1", question: "Should retries own idempotency?", planner: "planner" },
      "builder-sess",
    )
    const consult = deps.db.query("SELECT consult_id FROM team_member WHERE name = 'builder'").get() as {
      consult_id: string
    }
    deps.client.calls.length = 0

    const result = await executeTeamConsultReply(
      deps,
      { consult_id: consult.consult_id, reply: "Keep idempotency at the durable task boundary." },
      "planner-sess",
    )

    expect(result).toContain("resolved")
    expect(deps.db.query("SELECT consult_state FROM team_member WHERE name = 'builder'").get()).toEqual({
      consult_state: "answered",
    })
    const prompts = deps.client.calls.filter((call) => call.method === "session.promptAsync")
    expect(prompts).toHaveLength(1)
    expect((prompts[0]!.args[0] as { sessionID: string }).sessionID).toBe("builder-sess")
    expect(deps.db.query("SELECT COUNT(*) AS count FROM team_event WHERE kind = 'consultation.resolved'").get()).toEqual({ count: 1 })
  })

  test("planner escalation keeps the builder waiting and wakes the lead", async () => {
    await executeTeamConsult(
      deps,
      { task_id: "task-1", question: "Should this change billing behavior?", planner: "planner" },
      "builder-sess",
    )
    const consult = deps.db.query("SELECT consult_id FROM team_member WHERE name = 'builder'").get() as {
      consult_id: string
    }
    deps.client.calls.length = 0

    await executeTeamConsultReply(
      deps,
      { consult_id: consult.consult_id, reply: "This changes a business outcome.", escalate_to_lead: true },
      "planner-sess",
    )

    expect(deps.db.query("SELECT consult_state FROM team_member WHERE name = 'builder'").get()).toEqual({
      consult_state: "escalated",
    })
    const prompts = deps.client.calls.filter((call) => call.method === "session.promptAsync")
    expect(prompts).toHaveLength(1)
    expect((prompts[0]!.args[0] as { sessionID: string }).sessionID).toBe("lead-sess")
    expect(deps.db.query("SELECT COUNT(*) AS count FROM team_event WHERE kind = 'consultation.escalated'").get()).toEqual({ count: 1 })
  })

  test("planner resolves an escalated consultation after the lead supplies the business decision", async () => {
    await executeTeamConsult(
      deps,
      { task_id: "task-1", question: "Should this change billing behavior?", planner: "planner" },
      "builder-sess",
    )
    const consult = deps.db.query("SELECT consult_id FROM team_member WHERE name = 'builder'").get() as {
      consult_id: string
    }
    await executeTeamConsultReply(
      deps,
      { consult_id: consult.consult_id, reply: "This needs a business decision.", escalate_to_lead: true },
      "planner-sess",
    )
    deps.client.calls.length = 0

    const result = await executeTeamConsultReply(
      deps,
      { consult_id: consult.consult_id, reply: "The Lead confirmed existing billing behavior must remain unchanged." },
      "planner-sess",
    )

    expect(result).toContain("resolved")
    expect(deps.db.query("SELECT consult_state, consult_reply FROM team_member WHERE name = 'builder'").get()).toEqual({
      consult_state: "answered",
      consult_reply: "The Lead confirmed existing billing behavior must remain unchanged.",
    })
    const prompts = deps.client.calls.filter((call) => call.method === "session.promptAsync")
    expect(prompts).toHaveLength(1)
    expect((prompts[0]!.args[0] as { sessionID: string }).sessionID).toBe("builder-sess")
  })

  test("rejects consultation for a task not owned by the requester without durable changes", async () => {
    await expect(
      executeTeamConsult(deps, { task_id: "task-1", question: "Question" }, "planner-sess"),
    ).rejects.toThrow("owned by builder")

    expect(deps.db.query("SELECT consult_id FROM team_member WHERE name = 'planner'").get()).toEqual({
      consult_id: null,
    })
    expect(deps.client.calls).toHaveLength(0)
  })
})
