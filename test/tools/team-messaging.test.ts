import { describe, test, expect, beforeEach } from "bun:test"
import { setupDeps, insertTeam, insertMember } from "../helpers"
import { executeTeamMessage } from "../../src/tools/team-message"
import { executeTeamBroadcast } from "../../src/tools/team-broadcast"

describe("team_message", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    insertMember(deps.db, "t1", "bob", "sess-bob")
    deps.registry.register("t1", "alice", "sess-alice")
    deps.registry.register("t1", "bob", "sess-bob")
  })

  test("teammate sends message to lead", async () => {
    const result = await executeTeamMessage(deps, { to: "lead", text: "done with task" }, "sess-alice")
    expect(result).toContain("lead")

    // Check DB
    const rows = deps.db.query("SELECT * FROM team_message WHERE team_id = ?").all("t1") as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.from_name).toBe("alice")
    expect(rows[0]!.to_name).toBe("lead")

    // Check promptAsync WAS called — wake-up for the lead
    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)
  })

  test("teammate sends message to another teammate", async () => {
    const result = await executeTeamMessage(deps, { to: "bob", text: "need help" }, "sess-alice")
    expect(result).toContain("bob")

    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)
  })

  test("lead sends message to teammate", async () => {
    const result = await executeTeamMessage(deps, { to: "alice", text: "check this" }, "lead-sess")
    expect(result).toContain("alice")
  })

  test("rejects if sender is not in a team", async () => {
    await expect(executeTeamMessage(deps, { to: "alice", text: "hi" }, "random-sess"))
      .rejects.toThrow("not in a team")
  })

  test("queues message if peer recipient not yet spawned", async () => {
    const result = await executeTeamMessage(deps, { to: "unknown", text: "hi" }, "sess-alice")
    expect(result).toContain("queued")
    expect(result).toContain("unknown")
  })

  test("rejects messages over 10KB", async () => {
    await expect(executeTeamMessage(deps, { to: "lead", text: "x".repeat(10241) }, "sess-alice"))
      .rejects.toThrow("10KB")
  })

  test("message to lead over 500 chars is stored in DB (wake-up sent, content via system prompt)", async () => {
    const longText = "a".repeat(600)
    const result = await executeTeamMessage(deps, { to: "lead", text: longText }, "sess-alice")
    expect(result).toContain("Message sent to lead")

    // promptAsync called once (wake-up only, not full content)
    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)

    // Full content stored in DB
    const row = deps.db.query("SELECT content FROM team_message WHERE team_id = ?").get("t1") as { content: string }
    expect(row.content).toBe(longText)
  })

  test("message to lead under 500 chars is stored in DB (wake-up sent, content via system prompt)", async () => {
    const shortText = "b".repeat(400)
    const result = await executeTeamMessage(deps, { to: "lead", text: shortText }, "sess-alice")
    expect(result).toContain("Message sent to lead")

    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)

    const row = deps.db.query("SELECT content FROM team_message WHERE team_id = ?").get("t1") as { content: string }
    expect(row.content).toBe(shortText)
  })

  test("message to teammate is always delivered in full regardless of size", async () => {
    const longText = "c".repeat(600)
    await executeTeamMessage(deps, { to: "bob", text: longText }, "sess-alice")

    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)
    const delivered = (promptCalls[0]!.args[0] as { parts: Array<{ text: string }> }).parts[0]!.text
    expect(delivered).toContain(longText)
    expect(delivered).not.toContain("use team_results to read full message")
  })

  test("full content is stored in DB untruncated even when delivery is truncated", async () => {
    const longText = "d".repeat(600)
    await executeTeamMessage(deps, { to: "lead", text: longText }, "sess-alice")

    const rows = deps.db.query("SELECT content FROM team_message WHERE team_id = ?").all("t1") as Array<{ content: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe(longText)
  })
})

describe("team_broadcast", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    insertMember(deps.db, "t1", "bob", "sess-bob")
    deps.registry.register("t1", "alice", "sess-alice")
    deps.registry.register("t1", "bob", "sess-bob")
  })

  test("broadcasts to all members + lead (excluding sender)", async () => {
    const result = await executeTeamBroadcast(deps, { text: "status update" }, "sess-alice")
    expect(result).toContain("Broadcast")

    // Should call promptAsync for bob + lead (not alice)
    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(2)

    // Each recipient has independent durable delivery state.
    const rows = deps.db.query("SELECT * FROM team_message WHERE team_id = ?").all("t1") as Record<string, unknown>[]
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.to_name).sort()).toEqual(["bob", "lead"])
  })

  test("lead broadcasts to all members", async () => {
    const result = await executeTeamBroadcast(deps, { text: "new plan" }, "lead-sess")
    expect(result).toContain("Broadcast")

    // Should call promptAsync for alice + bob (not lead)
    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(2)
  })

  test("rejects if sender is not in a team", async () => {
    await expect(executeTeamBroadcast(deps, { text: "hi" }, "random-sess"))
      .rejects.toThrow("not in a team")
  })

  test("does not mark message delivered when all deliveries fail", async () => {
    deps.client.session.promptAsync = async () => { throw new Error("delivery failed") }

    await executeTeamBroadcast(deps, { text: "status update" }, "sess-alice")

    // Message should remain undelivered in DB
    const rows = deps.db.query("SELECT delivered FROM team_message WHERE team_id = ?").all("t1") as Array<{ delivered: number }>
    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.delivered === 0)).toBe(true)
  })

  test("tracks each broadcast recipient independently", async () => {
    deps.client.session.promptAsync = async (opts: unknown) => {
      deps.client.calls.push({ method: "session.promptAsync", args: [opts] })
      if ((opts as { sessionID: string }).sessionID === "lead-sess") throw new Error("delivery failed")
      return {}
    }

    await executeTeamBroadcast(deps, { text: "status update" }, "sess-alice")
    await Bun.sleep(1)

    const rows = deps.db.query(
      "SELECT to_name, delivered, content FROM team_message WHERE team_id = ? ORDER BY to_name",
    ).all("t1") as Array<{ to_name: string | null; delivered: number; content: string }>
    expect(rows).toContainEqual({ to_name: "lead", delivered: 0, content: "status update" })
    expect(rows).toContainEqual({ to_name: "bob", delivered: 1, content: "status update" })
  })
})

describe("team_broadcast — fire-and-forget promptAsync", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    insertMember(deps.db, "t1", "bob", "sess-bob")
    deps.registry.register("t1", "alice", "sess-alice")
    deps.registry.register("t1", "bob", "sess-bob")
  })

  test("returns immediately even if promptAsync never resolves", async () => {
    deps.client.session.promptAsync = () => new Promise(() => { /* never resolves */ })

    const result = await executeTeamBroadcast(deps, { text: "update" }, "sess-alice")
    expect(result).toContain("Broadcast")
  })
})

describe("team_message — fire-and-forget promptAsync", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    deps.registry.register("t1", "alice", "sess-alice")
  })

  test("returns immediately even if promptAsync never resolves", async () => {
    deps.client.session.promptAsync = () => new Promise(() => { /* never resolves */ })

    const result = await executeTeamMessage(deps, { to: "lead", text: "done" }, "sess-alice")
    expect(result).toContain("lead")

    // Message should be in DB
    const rows = deps.db.query("SELECT * FROM team_message WHERE team_id = ?").all("t1") as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
  })
})

describe("team_message — lead-bound messages wake the lead", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    deps.registry.register("t1", "alice", "sess-alice")
  })

  test("fires promptAsync wake-up on lead session for lead-bound messages", async () => {
    const result = await executeTeamMessage(deps, { to: "lead", text: "done" }, "sess-alice")
    expect(result).toContain("Message sent to lead")

    // promptAsync should be called once (wake-up)
    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)

    // Wake-up should target the lead session
    const call = promptCalls[0]!.args[0] as { sessionID: string; parts: Array<{ text: string }> }
    expect(call.sessionID).toBe("lead-sess")
    expect(call.parts[0]!.text).toContain("System")
    expect(call.parts[0]!.text).toContain("alice")
  })

  test("stores message in DB with delivered=0 (system prompt transform delivers content)", async () => {
    await executeTeamMessage(deps, { to: "lead", text: "done" }, "sess-alice")

    const rows = deps.db.query("SELECT delivered FROM team_message WHERE team_id = ?").all("t1") as Array<{ delivered: number }>
    expect(rows).toHaveLength(1)
    expect(rows[0]!.delivered).toBe(0)
  })

  test("returns immediately even if promptAsync never resolves (fire-and-forget)", async () => {
    deps.client.session.promptAsync = () => new Promise(() => { /* never resolves */ })

    const result = await executeTeamMessage(deps, { to: "lead", text: "done" }, "sess-alice")
    expect(result).toContain("Message sent to lead")
  })

  test("never calls session.status for lead-bound messages", async () => {
    await executeTeamMessage(deps, { to: "lead", text: "done" }, "sess-alice")

    const statusCalls = deps.client.calls.filter(c => c.method === "session.status")
    expect(statusCalls).toHaveLength(0)
  })

  test("still calls promptAsync for member-to-member messages", async () => {
    insertMember(deps.db, "t1", "bob", "sess-bob")
    deps.registry.register("t1", "bob", "sess-bob")

    await executeTeamMessage(deps, { to: "bob", text: "hey" }, "sess-alice")

    const promptCalls = deps.client.calls.filter(c => c.method === "session.promptAsync")
    expect(promptCalls).toHaveLength(1)
  })
})

describe("team_message — plan approval", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    insertMember(deps.db, "t1", "bob", "sess-bob")
    deps.registry.register("t1", "alice", "sess-alice")
    deps.registry.register("t1", "bob", "sess-bob")
  })

  test("approve=true flips plan_approval from pending to approved and prepends tag", async () => {
    deps.db.run("UPDATE team_member SET plan_approval = 'pending' WHERE team_id = ? AND name = ?", ["t1", "alice"])

    const result = await executeTeamMessage(deps, { to: "alice", text: "looks good", approve: true }, "lead-sess")
    expect(result).toContain("alice")

    // Check DB was updated
    const row = deps.db.query("SELECT plan_approval FROM team_member WHERE team_id = ? AND name = ?").get("t1", "alice") as { plan_approval: string }
    expect(row.plan_approval).toBe("approved")

    // Check message content was prepended
    const msgs = deps.db.query("SELECT content FROM team_message WHERE team_id = ?").all("t1") as Array<{ content: string }>
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.content).toContain("[Plan Approved]")
    expect(msgs[0]!.content).toContain("looks good")
  })

  test("reject flips plan_approval from pending to rejected and prepends reason", async () => {
    deps.db.run("UPDATE team_member SET plan_approval = 'pending' WHERE team_id = ? AND name = ?", ["t1", "bob"])

    const result = await executeTeamMessage(deps, { to: "bob", text: "try again", reject: "needs more detail" }, "lead-sess")
    expect(result).toContain("bob")

    const row = deps.db.query("SELECT plan_approval FROM team_member WHERE team_id = ? AND name = ?").get("t1", "bob") as { plan_approval: string }
    expect(row.plan_approval).toBe("rejected")

    const msgs = deps.db.query("SELECT content FROM team_message WHERE team_id = ?").all("t1") as Array<{ content: string }>
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.content).toContain("[Plan Rejected: needs more detail]")
    expect(msgs[0]!.content).toContain("try again")
  })

  test("approve errors if recipient has plan_approval=none", async () => {
    // plan_approval defaults to 'none' from insertMember
    await expect(executeTeamMessage(deps, { to: "alice", text: "ok", approve: true }, "lead-sess"))
      .rejects.toThrow("not in plan approval mode")
  })

  test("approve errors if recipient has plan_approval=approved (already approved)", async () => {
    deps.db.run("UPDATE team_member SET plan_approval = 'approved' WHERE team_id = ? AND name = ?", ["t1", "alice"])

    await expect(executeTeamMessage(deps, { to: "alice", text: "ok", approve: true }, "lead-sess"))
      .rejects.toThrow("not in plan approval mode")
  })

  test("both approve and reject set returns error", async () => {
    deps.db.run("UPDATE team_member SET plan_approval = 'pending' WHERE team_id = ? AND name = ?", ["t1", "alice"])

    await expect(executeTeamMessage(deps, { to: "alice", text: "ok", approve: true, reject: "no" }, "lead-sess"))
      .rejects.toThrow("Cannot both approve and reject")
  })

  test("only lead can approve — member trying to approve errors", async () => {
    deps.db.run("UPDATE team_member SET plan_approval = 'pending' WHERE team_id = ? AND name = ?", ["t1", "alice"])

    await expect(executeTeamMessage(deps, { to: "alice", text: "ok", approve: true }, "sess-bob"))
      .rejects.toThrow("Only the lead can approve or reject")
  })

  test("rolls back approval when the durable message insert fails", async () => {
    deps.db.run("UPDATE team_member SET plan_approval = 'pending' WHERE team_id = ? AND name = ?", ["t1", "alice"])
    deps.db.exec("CREATE TRIGGER fail_plan_message BEFORE INSERT ON team_message BEGIN SELECT RAISE(ABORT, 'message insert failed'); END")

    await expect(executeTeamMessage(deps, { to: "alice", text: "looks good", approve: true }, "lead-sess"))
      .rejects.toThrow("message insert failed")

    expect(deps.db.query("SELECT plan_approval FROM team_member WHERE team_id = ? AND name = ?").get("t1", "alice"))
      .toEqual({ plan_approval: "pending" })
    expect(deps.db.query("SELECT id FROM team_message WHERE team_id = ?").all("t1")).toHaveLength(0)
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(0)
  })

  test("makes concurrent identical approval retries idempotent with one durable message and wake", async () => {
    deps.db.run("UPDATE team_member SET plan_approval = 'pending' WHERE team_id = ? AND name = ?", ["t1", "alice"])

    const results = await Promise.allSettled([
      executeTeamMessage(deps, { to: "alice", text: "approved once", approve: true }, "lead-sess"),
      executeTeamMessage(deps, { to: "alice", text: "approved once", approve: true }, "lead-sess"),
    ])

    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(2)
    expect(deps.db.query("SELECT plan_approval FROM team_member WHERE team_id = ? AND name = ?").get("t1", "alice"))
      .toEqual({ plan_approval: "approved" })
    expect(deps.db.query("SELECT id FROM team_message WHERE team_id = ? AND to_name = ?").all("t1", "alice")).toHaveLength(1)
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(1)
  })

  test("makes an identical approval retry idempotent but rejects a conflicting later rejection", async () => {
    deps.db.run("UPDATE team_member SET plan_approval = 'pending' WHERE team_id = ? AND name = ?", ["t1", "alice"])
    await executeTeamMessage(deps, { to: "alice", text: "ship it", approve: true }, "lead-sess")

    await expect(executeTeamMessage(deps, { to: "alice", text: "ship it", approve: true }, "lead-sess"))
      .resolves.toBe("Message sent to alice.")
    await expect(executeTeamMessage(deps, { to: "alice", text: "changed my mind", reject: "revise it" }, "lead-sess"))
      .rejects.toThrow("not in plan approval mode")

    expect(deps.db.query("SELECT content FROM team_message WHERE team_id = ? AND to_name = ?").all("t1", "alice")).toHaveLength(1)
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(1)
  })

  test("makes an identical rejection retry idempotent and delivers the first rejection once", async () => {
    deps.db.run("UPDATE team_member SET plan_approval = 'pending', reported_to_lead = 1 WHERE team_id = ? AND name = ?", ["t1", "alice"])
    const args = { to: "alice", text: "revise the plan", reject: "missing rollback coverage" }

    await expect(executeTeamMessage(deps, args, "lead-sess")).resolves.toBe("Message sent to alice.")
    await expect(executeTeamMessage(deps, args, "lead-sess")).resolves.toBe("Message sent to alice.")
    await Bun.sleep(1)

    expect(deps.db.query("SELECT plan_approval, reported_to_lead FROM team_member WHERE team_id = ? AND name = ?").get("t1", "alice"))
      .toEqual({ plan_approval: "rejected", reported_to_lead: 0 })
    expect(deps.db.query("SELECT delivered FROM team_message WHERE team_id = ? AND to_name = ?").all("t1", "alice"))
      .toEqual([{ delivered: 1 }])
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(1)
  })

  test("commits approval and its message before waking the same teammate session", async () => {
    deps.db.run("UPDATE team_member SET plan_approval = 'pending', reported_to_lead = 1 WHERE team_id = ? AND name = ?", ["t1", "alice"])
    let observed: { plan_approval: string; messages: number; sessionID: string } | undefined
    deps.client.session.promptAsync = (options) => {
      observed = {
        ...(deps.db.query("SELECT plan_approval FROM team_member WHERE team_id = ? AND name = ?").get("t1", "alice") as { plan_approval: string }),
        messages: (deps.db.query("SELECT COUNT(*) AS count FROM team_message WHERE team_id = ? AND to_name = ?").get("t1", "alice") as { count: number }).count,
        sessionID: options.sessionID,
      }
      return Promise.resolve({})
    }

    await executeTeamMessage(deps, { to: "alice", text: "continue implementation", approve: true }, "lead-sess")

    expect(observed).toEqual({ plan_approval: "approved", messages: 1, sessionID: "sess-alice" })
  })

  test("atomically reopens a reported rejected plan and a later approval wakes the same session", async () => {
    deps.db.run(
      "UPDATE team_member SET plan_approval = 'rejected', reported_to_lead = 1 WHERE team_id = ? AND name = ?",
      ["t1", "alice"],
    )
    const revision = [
      "<plan-submission>",
      "<summary>Add rollback coverage</summary>",
      "<details>Write the failure-path test before changing the transaction.</details>",
      "</plan-submission>",
    ].join("\n")

    await executeTeamMessage(deps, { to: "lead", text: revision }, "sess-alice")

    expect(deps.db.query(
      "SELECT plan_approval, reported_to_lead, status, execution_status FROM team_member WHERE team_id = ? AND name = ?",
    ).get("t1", "alice")).toEqual({
      plan_approval: "pending",
      reported_to_lead: 0,
      status: "ready",
      execution_status: "idle",
    })
    expect(deps.db.query("SELECT content FROM team_message WHERE team_id = ? AND from_name = ?").all("t1", "alice"))
      .toEqual([{ content: revision }])

    deps.client.calls.length = 0
    await executeTeamMessage(deps, { to: "alice", text: "Proceed", approve: true }, "lead-sess")

    expect(deps.db.query("SELECT plan_approval FROM team_member WHERE team_id = ? AND name = ?").get("t1", "alice"))
      .toEqual({ plan_approval: "approved" })
    const approvalWake = deps.client.calls.find(call => call.method === "session.promptAsync")
    expect((approvalWake?.args[0] as { sessionID: string }).sessionID).toBe("sess-alice")
  })

  test("keeps identical pending plan submissions idempotent and wakes the lead once", async () => {
    deps.db.run("UPDATE team_member SET plan_approval = 'pending' WHERE team_id = ? AND name = ?", ["t1", "alice"])
    const plan = "<plan-submission><summary>Initial plan</summary><details>Test, implement, verify.</details></plan-submission>"

    const results = await Promise.allSettled([
      executeTeamMessage(deps, { to: "lead", text: plan }, "sess-alice"),
      executeTeamMessage(deps, { to: "lead", text: plan }, "sess-alice"),
    ])

    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(2)
    expect(deps.db.query("SELECT plan_approval FROM team_member WHERE team_id = ? AND name = ?").get("t1", "alice"))
      .toEqual({ plan_approval: "pending" })
    expect(deps.db.query("SELECT id FROM team_message WHERE team_id = ? AND from_name = ?").all("t1", "alice"))
      .toHaveLength(1)
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(1)
  })

  test("deduplicates concurrent identical rejected plan revisions and wakes the lead once", async () => {
    deps.db.run("UPDATE team_member SET plan_approval = 'rejected' WHERE team_id = ? AND name = ?", ["t1", "alice"])
    const revision = "<plan-submission><summary>Revised plan</summary><details>Add rollback coverage.</details></plan-submission>"

    const results = await Promise.allSettled([
      executeTeamMessage(deps, { to: "lead", text: revision }, "sess-alice"),
      executeTeamMessage(deps, { to: "lead", text: revision }, "sess-alice"),
    ])

    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(2)
    expect(deps.db.query("SELECT plan_approval, reported_to_lead FROM team_member WHERE team_id = ? AND name = ?").get("t1", "alice"))
      .toEqual({ plan_approval: "pending", reported_to_lead: 0 })
    expect(deps.db.query("SELECT id FROM team_message WHERE team_id = ? AND from_name = ?").all("t1", "alice"))
      .toHaveLength(1)
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(1)
  })

  test("does not reopen rejected plans for ordinary, structured, or malformed messages", async () => {
    const messages = [
      "progress: inspecting the transaction",
      "<task-result><kind>progress</kind><status>in_progress</status><summary>working</summary><details>inspecting</details></task-result>",
      "<task-result><kind>result</kind><status>completed</status><summary>done</summary><details>done</details></task-result>",
      "<task-result><kind>blocker</kind><status>pending</status><summary>blocked</summary><details>need input</details></task-result>",
      "<plan-submission><summary>missing details</summary></plan-submission>",
      "<plan-submission><summary> </summary><details>nonempty</details></plan-submission>",
      "prefix <plan-submission><summary>Plan</summary><details>Steps</details></plan-submission>",
      "<plan-submission><summary>Plan</summary><details>Steps</details></plan-submission> suffix",
    ]

    for (const text of messages) {
      deps.db.run("UPDATE team_member SET plan_approval = 'rejected', reported_to_lead = 1 WHERE team_id = ? AND name = ?", ["t1", "alice"])
      await executeTeamMessage(deps, { to: "lead", text }, "sess-alice")
      expect(deps.db.query("SELECT plan_approval, reported_to_lead FROM team_member WHERE team_id = ? AND name = ?").get("t1", "alice"))
        .toEqual({ plan_approval: "rejected", reported_to_lead: 1 })
    }
  })

  test("rolls back rejected-to-pending when the revised plan message insert fails", async () => {
    deps.db.run(
      "UPDATE team_member SET plan_approval = 'rejected', reported_to_lead = 1 WHERE team_id = ? AND name = ?",
      ["t1", "alice"],
    )
    deps.db.exec("CREATE TRIGGER fail_revised_plan_message BEFORE INSERT ON team_message BEGIN SELECT RAISE(ABORT, 'message insert failed'); END")
    const revision = "<plan-submission><summary>Revised plan</summary><details>Add the requested test.</details></plan-submission>"

    await expect(executeTeamMessage(deps, { to: "lead", text: revision }, "sess-alice"))
      .rejects.toThrow("message insert failed")

    expect(deps.db.query("SELECT plan_approval, reported_to_lead FROM team_member WHERE team_id = ? AND name = ?").get("t1", "alice"))
      .toEqual({ plan_approval: "rejected", reported_to_lead: 1 })
    expect(deps.db.query("SELECT id FROM team_message WHERE team_id = ?").all("t1")).toHaveLength(0)
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(0)
  })
})
