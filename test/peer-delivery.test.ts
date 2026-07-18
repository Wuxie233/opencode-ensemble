import { beforeEach, describe, expect, test } from "bun:test"
import { flushPendingPeerMessage, releasePendingPeerDelivery, sendMessage } from "../src/messaging"
import { executeTeamCleanup } from "../src/tools/team-cleanup"
import { insertMember, insertTeam, setupDeps } from "./helpers"

describe("idle peer message delivery", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    releasePendingPeerDelivery("sess-bob")
    deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    insertMember(deps.db, "t1", "bob", "sess-bob")
  })

  test("atomically delivers the oldest message content only once", async () => {
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "bob", content: "first finding" })
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "bob", content: "second finding" })

    const results = await Promise.all(Array.from({ length: 8 }, async () =>
      flushPendingPeerMessage(deps.db, deps.client, "sess-bob", Date.now() + 1)
    ))

    expect(results.filter(Boolean)).toHaveLength(1)
    const calls = deps.client.calls.filter(call => call.method === "session.promptAsync")
    expect(calls).toHaveLength(1)
    const prompt = calls[0]!.args[0] as { parts: Array<{ text: string }> }
    expect(prompt.parts[0]!.text).toBe("[Team message from alice]: first finding")
    expect((deps.db.query("SELECT delivered FROM team_message WHERE content = ?").get("first finding") as { delivered: number }).delivered).toBe(1)
    expect((deps.db.query("SELECT delivered FROM team_message WHERE content = ?").get("second finding") as { delivered: number }).delivered).toBe(0)

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(flushPendingPeerMessage(deps.db, deps.client, "sess-bob", Date.now() + 1)).toBeFalse()

    releasePendingPeerDelivery("sess-bob")
    expect(flushPendingPeerMessage(deps.db, deps.client, "sess-bob", Date.now() + 1)).toBeTrue()
  })

  test.each(["busy", "shutdown_requested", "shutdown", "error"])("does not wake a %s member", (status) => {
    deps.db.run("UPDATE team_member SET status = ? WHERE team_id = ? AND name = ?", [status, "t1", "bob"])
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "bob", content: "late finding" })

    expect(flushPendingPeerMessage(deps.db, deps.client, "sess-bob", Date.now() + 1)).toBeFalse()
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(0)
  })

  test("does not wake a member from an archived team", () => {
    deps.db.run("UPDATE team SET status = 'archived' WHERE id = ?", ["t1"])
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "bob", content: "late finding" })

    expect(flushPendingPeerMessage(deps.db, deps.client, "sess-bob", Date.now() + 1)).toBeFalse()
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(0)
  })

  test("does not wake a member who already reported completion", () => {
    deps.db.run("UPDATE team_member SET reported_to_lead = 1 WHERE team_id = ? AND name = ?", ["t1", "bob"])
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "bob", content: "late finding" })

    expect(flushPendingPeerMessage(deps.db, deps.client, "sess-bob", Date.now() + 1)).toBeFalse()
    expect(deps.client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(0)
  })

  test("releases the claim when prompt delivery fails", async () => {
    deps.client.session.promptAsync = async () => { throw new Error("delivery failed") }
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "bob", content: "retry me" })

    expect(flushPendingPeerMessage(deps.db, deps.client, "sess-bob", Date.now() + 1)).toBeTrue()
    await new Promise(resolve => setTimeout(resolve, 0))

    const row = deps.db.query("SELECT delivered FROM team_message WHERE content = ?").get("retry me") as { delivered: number }
    expect(row.delivered).toBe(0)
  })

  test("does not release a failed claim after the team is archived", async () => {
    let rejectDelivery: (error: Error) => void = () => {}
    deps.client.session.promptAsync = () => new Promise((_, reject) => {
      rejectDelivery = reject
    })
    sendMessage(deps.db, { teamId: "t1", from: "alice", to: "bob", content: "archive me" })

    expect(flushPendingPeerMessage(deps.db, deps.client, "sess-bob", Date.now() + 1)).toBeTrue()
    deps.db.run("UPDATE team SET status = 'archived' WHERE id = ?", ["t1"])
    rejectDelivery(new Error("delivery failed"))
    await new Promise(resolve => setTimeout(resolve, 0))

    const row = deps.db.query("SELECT delivered FROM team_message WHERE content = ?").get("archive me") as { delivered: number }
    expect(row.delivered).toBe(1)
  })
})

describe("team cleanup message delivery", () => {
  test("archives the team and consumes residual messages together", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown")
    sendMessage(deps.db, { teamId: "t1", from: "lead", to: "alice", content: "stale message" })

    await executeTeamCleanup(
      deps,
      { force: false },
      "lead-sess",
      undefined,
      async () => ({ ok: true }),
      async () => true,
      false,
    )

    const team = deps.db.query("SELECT status FROM team WHERE id = ?").get("t1") as { status: string }
    const message = deps.db.query("SELECT delivered FROM team_message WHERE team_id = ?").get("t1") as { delivered: number }
    expect(team.status).toBe("archived")
    expect(message.delivered).toBe(1)
  })
})
