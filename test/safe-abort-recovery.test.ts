import { beforeEach, describe, expect, test } from "bun:test"
import { SafeAbortRecovery, recoverStaleAbortChecks } from "../src/safe-abort-recovery"
import type { SessionErrorAlert } from "../src/hooks"
import type { Database } from "../src/db"
import { insertMember, insertTeam, mockClient, setupDb } from "./helpers"
import { MemberRegistry } from "../src/state"

const ABORT_ERROR = { name: "MessageAbortedError", data: { message: "Aborted" } }

function abortedMessage(id = "msg-abort", parts: unknown[] = [], completed = Date.now()) {
  return { info: { id, role: "assistant", time: { created: completed - 1, completed }, error: { name: "MessageAbortedError" } }, parts }
}

function userMessage(id: string, created = Date.now()) {
  return { info: { id, role: "user", time: { created } }, parts: [] }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index++) {
    await Bun.sleep(1)
  }
}

describe("SafeAbortRecovery", () => {
  let db: Database
  let registry: MemberRegistry
  let client: ReturnType<typeof mockClient>
  let terminalAlerts: SessionErrorAlert[]

  beforeEach(() => {
    db = setupDb()
    registry = new MemberRegistry()
    client = mockClient()
    terminalAlerts = []
    insertTeam(db, "t1", "smoke", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "busy", "running")
    registry.register("t1", "scout", "scout-sess")
  })

  function coordinator() {
    return new SafeAbortRecovery({
      db,
      registry,
      client,
      retryDelaysMs: [0, 0],
      onTerminal: alert => terminalAlerts.push(alert),
    })
  }

  test("silently recovers the first exact terminal abort with no tool parts", async () => {
    const now = Date.now()
    db.run("INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES ('task-1', 't1', 'work', 'in_progress', 'high', 'scout', ?, ?)", [now, now])
    client.session.messages = async () => ({ data: [abortedMessage()] })

    expect(coordinator().handleSessionError("scout-sess", ABORT_ERROR, "event-1")).toBe(true)
    await settle()

    const member = db.query("SELECT status, execution_status, abort_recovery_state, abort_recovery_message_id FROM team_member WHERE session_id = ?").get("scout-sess")
    expect(member).toEqual({ status: "busy", execution_status: "running", abort_recovery_state: "prompted", abort_recovery_message_id: "msg-abort" })
    expect(db.query("SELECT status, assignee FROM team_task WHERE id = 'task-1'").get()).toEqual({ status: "in_progress", assignee: "scout" })
    expect((db.query("SELECT COUNT(*) AS count FROM team_message").get() as { count: number }).count).toBe(0)
    expect(terminalAlerts).toEqual([])
    const prompts = client.calls.filter(call => call.method === "session.promptAsync")
    expect(prompts).toHaveLength(1)
    expect(JSON.stringify(prompts[0]?.args)).toContain("inspect")
    expect(JSON.stringify(prompts[0]?.args)).toContain("avoid repeating")
    expect(JSON.stringify(prompts[0]?.args)).toContain("report")
  })

  test("uses a durable CAS so concurrent plugin instances prompt only once", async () => {
    client.session.messages = async () => ({ data: [abortedMessage()] })
    const first = coordinator()
    const second = coordinator()

    expect(first.handleSessionError("scout-sess", ABORT_ERROR, "event-1")).toBe(true)
    expect(second.handleSessionError("scout-sess", ABORT_ERROR, "event-1")).toBe(true)
    await settle()

    expect(client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(1)
  })

  test("treats concurrent abort events without SDK event IDs as the same recoverable turn", async () => {
    client.session.messages = async () => ({ data: [abortedMessage()] })
    const first = coordinator()
    const second = coordinator()

    expect(first.handleSessionError("scout-sess", ABORT_ERROR)).toBe(true)
    expect(second.handleSessionError("scout-sess", ABORT_ERROR)).toBe(true)
    await settle()

    expect(client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(1)
    expect(terminalAlerts).toEqual([])
    expect(db.query("SELECT status, execution_status, abort_recovery_state FROM team_member WHERE session_id = ?").get("scout-sess"))
      .toEqual({ status: "busy", execution_status: "running", abort_recovery_state: "prompted" })
  })

  test("ignores a duplicate event for the same failed message without consuming another recovery", async () => {
    client.session.messages = async () => ({ data: [abortedMessage()] })
    const recovery = coordinator()
    recovery.handleSessionError("scout-sess", ABORT_ERROR, "event-1")
    await settle()

    expect(recovery.handleSessionError("scout-sess", ABORT_ERROR, "event-1")).toBe(true)
    await settle()

    expect(client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(1)
    expect(terminalAlerts).toEqual([])
    expect((db.query("SELECT abort_recovery_state FROM team_member WHERE session_id = ?").get("scout-sess") as { abort_recovery_state: string }).abort_recovery_state).toBe("prompted")
  })

  test("terminal-fails a distinct second aborted assistant turn", async () => {
    let messages = [abortedMessage("msg-1")]
    client.session.messages = async () => ({ data: messages })
    const recovery = coordinator()
    recovery.handleSessionError("scout-sess", ABORT_ERROR, "event-1")
    await settle()
    messages = [abortedMessage("msg-1", [], Date.now() - 10), abortedMessage("msg-2")]

    recovery.handleSessionError("scout-sess", ABORT_ERROR, "event-2")
    await settle()

    expect(terminalAlerts).toEqual([{ leadSessionId: "lead-sess", memberName: "scout" }])
    expect((db.query("SELECT status FROM team_member WHERE session_id = ?").get("scout-sess") as { status: string }).status).toBe("error")
  })

  test("detects a distinct second abort that persists after its session.error", async () => {
    let messages = [abortedMessage("msg-1")]
    client.session.messages = async () => ({ data: messages })
    const recovery = new SafeAbortRecovery({ db, registry, client, retryDelaysMs: [1000], onTerminal: alert => terminalAlerts.push(alert) })
    recovery.handleSessionError("scout-sess", ABORT_ERROR, "event-1")
    await settle()

    recovery.handleSessionError("scout-sess", ABORT_ERROR, "event-2")
    await Bun.sleep(2)
    messages = [abortedMessage("msg-1", [], Date.now() - 10), abortedMessage("msg-2")]
    recovery.observeMessage("scout-sess")
    await settle()

    expect(terminalAlerts).toHaveLength(1)
    expect((db.query("SELECT status FROM team_member WHERE session_id = ?").get("scout-sess") as { status: string }).status).toBe("error")
  })

  test("fails closed when a second abort message persists after the inspection window", async () => {
    let messages: Array<{ info: unknown; parts: unknown[] }> = [abortedMessage("msg-1", [], 100)]
    client.session.messages = async () => ({ data: messages })
    const recovery = new SafeAbortRecovery({ db, registry, client, retryDelaysMs: [0], onTerminal: alert => terminalAlerts.push(alert) })
    recovery.handleSessionError("scout-sess", ABORT_ERROR, "event-1")
    await settle()

    messages = [abortedMessage("msg-1", [], 100), userMessage("user-2", 200)]
    recovery.handleSessionError("scout-sess", ABORT_ERROR, "event-2")
    await settle()
    messages.push(abortedMessage("msg-2", [], 300))
    recovery.observeMessage("scout-sess")
    await settle()

    expect(terminalAlerts).toHaveLength(1)
    expect((db.query("SELECT status FROM team_member WHERE session_id = ?").get("scout-sess") as { status: string }).status).toBe("error")
  })

  test("fails closed when the aborted turn contains any tool part", async () => {
    client.session.messages = async () => ({ data: [abortedMessage("msg-tool", [{ type: "tool", tool: "bash", state: { status: "pending" } }])] })

    coordinator().handleSessionError("scout-sess", ABORT_ERROR)
    await settle()

    expect(terminalAlerts).toHaveLength(1)
    expect(client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(0)
  })

  test("waits for delayed message persistence and rechecks on message.updated", async () => {
    let messages: Array<ReturnType<typeof abortedMessage>> = []
    client.session.messages = async () => ({ data: messages })
    const recovery = new SafeAbortRecovery({ db, registry, client, retryDelaysMs: [1000], onTerminal: alert => terminalAlerts.push(alert) })
    recovery.handleSessionError("scout-sess", ABORT_ERROR, "event-1")
    await Bun.sleep(2)
    messages = [abortedMessage()]

    recovery.observeMessage("scout-sess")
    await settle()

    expect(client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(1)
    expect(terminalAlerts).toEqual([])
  })

  test.each([
    ["reported completion", () => db.run("UPDATE team_member SET reported_to_lead = 1 WHERE session_id = 'scout-sess'")],
    ["outbound lead message", () => db.run("INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES ('m1', 't1', 'scout', 'lead', 'done', 1, ?)", [Date.now()])],
    ["outbound broadcast", () => db.run("INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES ('m1', 't1', 'scout', NULL, 'done', 1, ?)", [Date.now()])],
    ["completed assigned task", () => db.run("INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES ('done', 't1', 'done', 'completed', 'high', 'scout', ?, ?)", [Date.now(), Date.now()])],
  ])("does not auto-recover after %s", async (_label, arrange) => {
    arrange()
    client.session.messages = async () => ({ data: [abortedMessage()] })

    expect(coordinator().handleSessionError("scout-sess", ABORT_ERROR)).toBe(false)
    expect(client.calls.filter(call => call.method === "session.messages")).toHaveLength(0)
  })

  test("does not auto-recover normal errors or shutdown aborts", () => {
    expect(coordinator().handleSessionError("scout-sess", { name: "ProviderAuthError" })).toBe(false)
    db.run("UPDATE team_member SET status = 'shutdown_requested' WHERE session_id = 'scout-sess'")
    expect(coordinator().handleSessionError("scout-sess", ABORT_ERROR)).toBe(false)
  })

  test("fails closed after ambiguous history retries are exhausted", async () => {
    client.session.messages = async () => ({ data: [] })

    coordinator().handleSessionError("scout-sess", ABORT_ERROR)
    await settle()

    expect(terminalAlerts).toHaveLength(1)
    expect((db.query("SELECT status FROM team_member WHERE session_id = ?").get("scout-sess") as { status: string }).status).toBe("error")
  })

  test("fails closed on messages API failure", async () => {
    client.session.messages = async () => { throw new Error("transport failed") }

    coordinator().handleSessionError("scout-sess", ABORT_ERROR)
    await settle()

    expect(terminalAlerts).toHaveLength(1)
  })

  test("fails closed when messages API never returns", async () => {
    client.session.messages = () => new Promise(() => {})
    const recovery = new SafeAbortRecovery({
      db,
      registry,
      client,
      retryDelaysMs: [],
      apiTimeoutMs: 2,
      onTerminal: alert => terminalAlerts.push(alert),
    })

    recovery.handleSessionError("scout-sess", ABORT_ERROR)
    await settle()

    expect(terminalAlerts).toHaveLength(1)
  })

  test("fails closed when the recovery prompt rejects", async () => {
    client.session.messages = async () => ({ data: [abortedMessage()] })
    client.session.promptAsync = async () => { throw new Error("delivery failed") }

    coordinator().handleSessionError("scout-sess", ABORT_ERROR)
    await settle()

    expect(terminalAlerts).toHaveLength(1)
    expect((db.query("SELECT status FROM team_member WHERE session_id = ?").get("scout-sess") as { status: string }).status).toBe("error")
  })

  test("does not prompt if shutdown starts while message inspection is pending", async () => {
    let resolveMessages: ((value: { data: ReturnType<typeof abortedMessage>[] }) => void) | undefined
    client.session.messages = () => new Promise(resolve => { resolveMessages = resolve })
    const recovery = coordinator()
    recovery.handleSessionError("scout-sess", ABORT_ERROR)
    db.run("UPDATE team_member SET status = 'shutdown_requested' WHERE session_id = 'scout-sess'")
    resolveMessages?.({ data: [abortedMessage()] })
    await settle()

    expect(client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(0)
    expect((db.query("SELECT status FROM team_member WHERE session_id = ?").get("scout-sess") as { status: string }).status).toBe("shutdown_requested")
  })

  test("allows another instance to resume a durable checking claim on message update", async () => {
    let messages: ReturnType<typeof abortedMessage>[] = []
    client.session.messages = async () => ({ data: messages })
    const owner = new SafeAbortRecovery({ db, registry, client, retryDelaysMs: [1000], onTerminal: alert => terminalAlerts.push(alert) })
    const observer = coordinator()
    owner.handleSessionError("scout-sess", ABORT_ERROR)
    await Bun.sleep(2)
    messages = [abortedMessage()]

    observer.observeMessage("scout-sess")
    await settle()

    expect(client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(1)
  })

  test("does not let a stale inspector fail closed a row another instance already prompted", async () => {
    let rejectOwner: ((reason: Error) => void) | undefined
    const ownerClient = mockClient()
    ownerClient.session.messages = () => new Promise((_resolve, reject) => { rejectOwner = reject })
    const observerClient = mockClient()
    observerClient.session.messages = async () => ({ data: [abortedMessage()] })
    const owner = new SafeAbortRecovery({ db, registry, client: ownerClient, retryDelaysMs: [1000], onTerminal: alert => terminalAlerts.push(alert) })
    const observer = new SafeAbortRecovery({ db, registry, client: observerClient, retryDelaysMs: [0], onTerminal: alert => terminalAlerts.push(alert) })
    owner.handleSessionError("scout-sess", ABORT_ERROR)
    await Bun.sleep(2)

    observer.observeMessage("scout-sess")
    await settle()
    rejectOwner?.(new Error("stale transport failed"))
    await settle()

    expect(observerClient.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(1)
    expect(terminalAlerts).toEqual([])
    expect(db.query("SELECT status, execution_status, abort_recovery_state FROM team_member WHERE session_id = ?").get("scout-sess"))
      .toEqual({ status: "busy", execution_status: "running", abort_recovery_state: "prompted" })
  })

  test("dispose clears retries and prevents late prompt delivery", async () => {
    let resolveMessages: ((value: { data: ReturnType<typeof abortedMessage>[] }) => void) | undefined
    client.session.messages = () => new Promise(resolve => { resolveMessages = resolve })
    const recovery = coordinator()
    recovery.handleSessionError("scout-sess", ABORT_ERROR)
    recovery.dispose()
    resolveMessages?.({ data: [abortedMessage()] })
    await settle()

    expect(client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(0)
  })

  test("dispose fails closed a locally owned checking claim instead of stranding it", async () => {
    client.session.messages = () => new Promise(() => {})
    const recovery = coordinator()
    recovery.handleSessionError("scout-sess", ABORT_ERROR)

    recovery.dispose()
    await settle()

    expect(terminalAlerts).toEqual([{ leadSessionId: "lead-sess", memberName: "scout" }])
    expect(db.query("SELECT status, execution_status, abort_recovery_state FROM team_member WHERE session_id = ?").get("scout-sess"))
      .toEqual({ status: "error", execution_status: "failed", abort_recovery_state: "consumed" })
  })

  test("fails closed durably when fire-and-forget recovery prompting never settles", async () => {
    client.session.messages = async () => ({ data: [abortedMessage()] })
    client.session.promptAsync = options => {
      client.calls.push({ method: "session.promptAsync", args: [options] })
      return new Promise(() => {})
    }
    const recovery = new SafeAbortRecovery({
      db,
      registry,
      client,
      retryDelaysMs: [0],
      apiTimeoutMs: 2,
      promptTimeoutMs: 2,
      onTerminal: alert => terminalAlerts.push(alert),
    })

    recovery.handleSessionError("scout-sess", ABORT_ERROR)
    await settle()

    expect(client.calls.filter(call => call.method === "session.promptAsync")).toHaveLength(1)
    expect(terminalAlerts).toEqual([{ leadSessionId: "lead-sess", memberName: "scout" }])
    expect(db.query("SELECT status, execution_status, abort_recovery_state, abort_recovery_started_at FROM team_member WHERE session_id = ?").get("scout-sess"))
      .toEqual({ status: "error", execution_status: "failed", abort_recovery_state: "consumed", abort_recovery_started_at: null })
  })
})

describe("recoverStaleAbortChecks", () => {
  test("does not consume an unexpired claim owned by another live instance", () => {
    const db = setupDb()
    const registry = new MemberRegistry()
    insertTeam(db, "t1", "smoke", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "busy", "running")
    db.run(
      `UPDATE team_member SET abort_recovery_state = 'prompted', abort_recovery_claim_token = ?,
         abort_recovery_claim_expires_at = ? WHERE session_id = ?`,
      ["live-owner", Date.now() + 60_000, "scout-sess"],
    )

    expect(recoverStaleAbortChecks(db, registry)).toEqual([])
    expect(db.query("SELECT status, abort_recovery_state FROM team_member WHERE session_id = ?").get("scout-sess"))
      .toEqual({ status: "busy", abort_recovery_state: "prompted" })
  })

  test("fails closed a checking claim left behind by a crashed instance", () => {
    const db = setupDb()
    const registry = new MemberRegistry()
    insertTeam(db, "t1", "smoke", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "busy", "running")
    db.run("UPDATE team_member SET abort_recovery_state = 'checking', abort_recovery_started_at = ? WHERE session_id = ?", [Date.now() - 60_000, "scout-sess"])

    const alerts = recoverStaleAbortChecks(db, registry)

    expect(alerts).toEqual([{ leadSessionId: "lead-sess", memberName: "scout" }])
    expect((db.query("SELECT status, abort_recovery_state FROM team_member WHERE session_id = ?").get("scout-sess")))
      .toEqual({ status: "error", abort_recovery_state: "consumed" })
  })

  test("fails closed an expired prompted delivery lease", () => {
    const db = setupDb()
    const registry = new MemberRegistry()
    insertTeam(db, "t1", "smoke", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "busy", "running")
    db.run(
      `UPDATE team_member SET abort_recovery_state = 'prompted', abort_recovery_claim_token = ?,
         abort_recovery_claim_expires_at = ? WHERE session_id = ?`,
      ["expired-owner", Date.now() - 1, "scout-sess"],
    )

    expect(recoverStaleAbortChecks(db, registry)).toEqual([{ leadSessionId: "lead-sess", memberName: "scout" }])
    expect(db.query("SELECT status, abort_recovery_state FROM team_member WHERE session_id = ?").get("scout-sess"))
      .toEqual({ status: "error", abort_recovery_state: "consumed" })
  })
})
