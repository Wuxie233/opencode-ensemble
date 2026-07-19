import type { Database } from "./db"
import { handleSessionErrorEvent, type SessionErrorAlert, type SessionErrorPayload } from "./hooks"
import { log } from "./log"
import type { MemberRegistry } from "./state"
import type { PluginClient } from "./types"

const ABORT_ERROR_NAME = "MessageAbortedError"
const DEFAULT_RETRY_DELAYS_MS = [50, 150, 350]
const DEFAULT_API_TIMEOUT_MS = 1_000
const RECOVERY_PROMPT = "[System: Your previous turn was unexpectedly aborted before any tool call. inspect the actual repository, task board, team messages, and current state before continuing. avoid repeating completed actions. Continue only the remaining work, then report the result to the lead via team_message.]"

interface AbortMember {
  team_id: string
  name: string
  status: string
  execution_status: string
  reported_to_lead: number
  abort_recovery_state: "none" | "checking" | "prompted" | "consumed"
  abort_recovery_message_id: string | null
  abort_recovery_event_id: string | null
}

interface MessageInfo {
  id?: string
  role?: string
  time?: { created?: number; completed?: number }
  error?: { name?: string }
}

interface SessionMessage {
  info: unknown
  parts: unknown[]
}

interface SafeAbortRecoveryOptions {
  db: Database
  registry: MemberRegistry
  client: PluginClient
  retryDelaysMs?: number[]
  apiTimeoutMs?: number
  onTerminal?: (alert: SessionErrorAlert) => void
}

interface PendingCheck {
  attempt: number
  running: boolean
  timer?: ReturnType<typeof setTimeout>
}

/** Coordinates durable, one-shot recovery of side-effect-free aborted teammate turns. */
export class SafeAbortRecovery {
  private readonly db: Database
  private readonly registry: MemberRegistry
  private readonly client: PluginClient
  private readonly retryDelaysMs: number[]
  private readonly apiTimeoutMs: number
  private readonly onTerminal: (alert: SessionErrorAlert) => void
  private readonly pending = new Map<string, PendingCheck>()
  private disposed = false

  constructor(options: SafeAbortRecoveryOptions) {
    this.db = options.db
    this.registry = options.registry
    this.client = options.client
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
    this.apiTimeoutMs = options.apiTimeoutMs ?? DEFAULT_API_TIMEOUT_MS
    this.onTerminal = options.onTerminal ?? (() => {})
  }

  /** Claim an eligible abort for asynchronous inspection; false means use normal terminal handling. */
  handleSessionError(sessionId: string | undefined, error: SessionErrorPayload | undefined, eventId?: string): boolean {
    if (!sessionId || error?.name !== ABORT_ERROR_NAME) return false
    const member = this.lookupEligibleMember(sessionId)
    if (!member) return false

    if (member.abort_recovery_state === "consumed") return false
    if (eventId && member.abort_recovery_event_id === eventId) return true
    if (member.abort_recovery_state === "checking") {
      this.failClosed(sessionId, "a distinct abort arrived while recovery inspection was already active")
      return true
    }
    if (member.abort_recovery_state === "prompted" && !eventId) return false

    const claimed = this.db.run(
      `UPDATE team_member
       SET abort_recovery_state = 'checking', abort_recovery_event_id = ?, abort_recovery_started_at = ?, time_updated = ?
       WHERE team_id = ? AND name = ? AND session_id = ? AND abort_recovery_state = ?
          AND status IN ('ready', 'busy')
          AND execution_status IN ('idle', 'starting', 'running')`,
      [eventId ?? null, Date.now(), Date.now(), member.team_id, member.name, sessionId, member.abort_recovery_state],
    )
    if (claimed.changes !== 1) return true

    this.pending.set(sessionId, { attempt: 0, running: false })
    void this.inspect(sessionId)
    return true
  }

  /** Recheck a pending abort when message persistence emits message.updated. */
  observeMessage(sessionId: string): void {
    if (this.disposed) return
    const check = this.pending.get(sessionId) ?? this.resumeDurableCheck(sessionId)
    if (!check) return
    if (check.timer) clearTimeout(check.timer)
    check.timer = undefined
    void this.inspect(sessionId)
  }

  /** Whether idle side effects must be suppressed while turn inspection is unresolved. */
  isChecking(sessionId: string): boolean {
    const row = this.db.query("SELECT abort_recovery_state FROM team_member WHERE session_id = ?")
      .get(sessionId) as { abort_recovery_state: string } | null
    return row?.abort_recovery_state === "checking"
  }

  /** Stop task-owned timers and prevent in-flight checks from prompting after plugin disposal. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const check of this.pending.values()) {
      if (check.timer) clearTimeout(check.timer)
    }
    this.pending.clear()
  }

  private resumeDurableCheck(sessionId: string): PendingCheck | undefined {
    const row = this.db.query(
      "SELECT 1 AS found FROM team_member WHERE session_id = ? AND abort_recovery_state = 'checking'",
    ).get(sessionId)
    if (!row) return
    const check: PendingCheck = { attempt: 0, running: false }
    this.pending.set(sessionId, check)
    return check
  }

  private lookupEligibleMember(sessionId: string): AbortMember | undefined {
    const member = this.db.query(
      `SELECT tm.team_id, tm.name, tm.status, tm.execution_status, tm.reported_to_lead,
              tm.abort_recovery_state, tm.abort_recovery_message_id, tm.abort_recovery_event_id
       FROM team_member tm
       JOIN team t ON t.id = tm.team_id
       WHERE tm.session_id = ? AND t.status = 'active'
         AND tm.status IN ('ready', 'busy')
         AND tm.execution_status IN ('idle', 'starting', 'running')`,
    ).get(sessionId) as AbortMember | null
    if (!member || member.reported_to_lead !== 0) return

    const outbound = this.db.query(
      "SELECT 1 AS found FROM team_message WHERE team_id = ? AND from_name = ? AND (to_name = 'lead' OR to_name IS NULL) LIMIT 1",
    ).get(member.team_id, member.name)
    if (outbound) return
    const completedTask = this.db.query(
      "SELECT 1 AS found FROM team_task WHERE team_id = ? AND assignee = ? AND status = 'completed' LIMIT 1",
    ).get(member.team_id, member.name)
    if (completedTask) return
    return member
  }

  private async inspect(sessionId: string): Promise<void> {
    if (this.disposed) return
    const check = this.pending.get(sessionId)
    if (!check || check.running) return
    check.running = true
    try {
      const response = await this.withTimeout(this.client.session.messages({ sessionID: sessionId, limit: 20 }))
      if (this.disposed) return
      const memberState = this.db.query(
        "SELECT abort_recovery_message_id FROM team_member WHERE session_id = ? AND abort_recovery_state = 'checking'",
      ).get(sessionId) as { abort_recovery_message_id: string | null } | null
      if (!memberState) {
        this.pending.delete(sessionId)
        return
      }
      const inspected = inspectNewestTerminalTurn(response.data, memberState.abort_recovery_message_id)
      if (inspected.kind === "wait") {
        this.retry(sessionId, check)
        return
      }
      if (inspected.kind === "unsafe") {
        this.failClosed(sessionId, inspected.reason)
        return
      }

      if (memberState.abort_recovery_message_id) {
        this.failClosed(sessionId, "a distinct second aborted turn was observed")
        return
      }

      const prompted = this.db.run(
        `UPDATE team_member SET abort_recovery_state = 'prompted', abort_recovery_message_id = ?,
           abort_recovery_started_at = NULL, time_updated = ?
         WHERE session_id = ? AND abort_recovery_state = 'checking' AND abort_recovery_message_id IS NULL
           AND status IN ('ready', 'busy')
           AND execution_status IN ('idle', 'starting', 'running')
           AND reported_to_lead = 0
           AND EXISTS (SELECT 1 FROM team t WHERE t.id = team_member.team_id AND t.status = 'active')
           AND NOT EXISTS (
             SELECT 1 FROM team_message msg
             WHERE msg.team_id = team_member.team_id AND msg.from_name = team_member.name
               AND (msg.to_name = 'lead' OR msg.to_name IS NULL)
           )
           AND NOT EXISTS (
             SELECT 1 FROM team_task task
             WHERE task.team_id = team_member.team_id AND task.assignee = team_member.name
               AND task.status = 'completed'
           )`,
        [inspected.messageId, Date.now(), sessionId],
      )
      if (prompted.changes !== 1) {
        this.db.run(
          "UPDATE team_member SET abort_recovery_state = 'consumed', abort_recovery_started_at = NULL WHERE session_id = ? AND abort_recovery_state = 'checking'",
          [sessionId],
        )
        this.pending.delete(sessionId)
        return
      }
      this.pending.delete(sessionId)
      if (this.disposed) return
      this.client.session.promptAsync({
        sessionID: sessionId,
        parts: [{ type: "text", text: RECOVERY_PROMPT }],
      }).catch(error => {
        this.failClosed(sessionId, `recovery prompt failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    } catch (error) {
      this.failClosed(sessionId, `message inspection failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      const current = this.pending.get(sessionId)
      if (current) current.running = false
    }
  }

  private retry(sessionId: string, check: PendingCheck): void {
    const delay = this.retryDelaysMs[check.attempt]
    if (delay === undefined) {
      this.failClosed(sessionId, "the aborted assistant turn could not be identified before inspection timed out")
      return
    }
    check.attempt += 1
    check.timer = setTimeout(() => {
      check.timer = undefined
      if (this.disposed) return
      void this.inspect(sessionId)
    }, delay)
  }

  private failClosed(sessionId: string, reason: string): void {
    if (this.disposed) return
    const check = this.pending.get(sessionId)
    if (check?.timer) clearTimeout(check.timer)
    this.pending.delete(sessionId)
    this.db.run(
      "UPDATE team_member SET abort_recovery_state = 'consumed', abort_recovery_started_at = NULL WHERE session_id = ?",
      [sessionId],
    )
    log(`safe-abort:fail-closed session=${sessionId} reason=${reason}`)
    const alert = handleSessionErrorEvent(this.db, this.registry, sessionId, {
      name: ABORT_ERROR_NAME,
      data: { message: `Aborted; automatic recovery was not safe: ${reason}` },
    })
    if (alert) this.onTerminal(alert)
  }

  private async withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("session.messages timed out")), this.apiTimeoutMs)
    })
    try {
      return await Promise.race([promise, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

function inspectNewestTerminalTurn(messages: SessionMessage[] | undefined, previousAbortId: string | null):
  | { kind: "safe"; messageId: string }
  | { kind: "wait" }
  | { kind: "unsafe"; reason: string } {
  if (!messages?.length) return { kind: "wait" }
  const timeline = messages.flatMap(message => {
    if (!message.info || typeof message.info !== "object") return []
    const info = message.info as MessageInfo
    if (!info.id || (info.role !== "assistant" && info.role !== "user") || info.time?.created === undefined) return []
    return [{ info, parts: message.parts }]
  })
  if (timeline.length === 0) return { kind: "wait" }
  const ordered = timeline.toSorted((left, right) => {
    const time = (left.info.time?.created ?? 0) - (right.info.time?.created ?? 0)
    return time || (left.info.id ?? "").localeCompare(right.info.id ?? "")
  })
  const previousIndex = previousAbortId ? ordered.findIndex(message => message.info.id === previousAbortId) : -1
  const candidates = previousAbortId ? ordered.slice(previousIndex + 1) : ordered
  if (previousAbortId && previousIndex === -1) return { kind: "unsafe", reason: "the previously recovered abort is missing from session history" }
  if (candidates.length === 0 || candidates.at(-1)?.info.role === "user") return { kind: "wait" }
  const assistant = candidates.filter(message => message.info.role === "assistant")
  const newest = assistant.at(-1)
  const next = assistant.at(-2)
  if (!newest?.info.id) return { kind: "wait" }
  if (newest.info.time?.completed === undefined) return { kind: "wait" }
  if (next?.info.time?.completed === newest.info.time?.completed) {
    return { kind: "unsafe", reason: "multiple terminal assistant turns have the same completion time" }
  }
  if (newest.info.error?.name !== ABORT_ERROR_NAME) {
    return { kind: "unsafe", reason: "the newest terminal assistant turn is not the reported abort" }
  }
  if (newest.parts.some(part => !!part && typeof part === "object" && (part as { type?: string }).type === "tool")) {
    return { kind: "unsafe", reason: "the aborted turn contains a tool part" }
  }
  return { kind: "safe", messageId: newest.info.id }
}

/** Fail closed any abort inspection claims left behind by a crashed plugin instance. */
export function recoverStaleAbortChecks(db: Database, registry: MemberRegistry): SessionErrorAlert[] {
  const rows = db.query(
    `SELECT session_id FROM team_member tm
     JOIN team t ON t.id = tm.team_id
     WHERE t.status = 'active' AND tm.status IN ('ready', 'busy') AND tm.abort_recovery_state = 'checking'`,
  ).all() as Array<{ session_id: string }>
  return rows.flatMap(row => {
    const claimed = db.run(
      "UPDATE team_member SET abort_recovery_state = 'consumed', abort_recovery_started_at = NULL WHERE session_id = ? AND abort_recovery_state = 'checking'",
      [row.session_id],
    )
    if (claimed.changes !== 1) return []
    const alert = handleSessionErrorEvent(db, registry, row.session_id, {
      name: ABORT_ERROR_NAME,
      data: { message: "Aborted; automatic recovery inspection was interrupted by plugin restart" },
    })
    return alert ? [alert] : []
  })
}
