import type { Database } from "./db"
import type { MemberRegistry, DescendantTracker } from "./state"
import { findTeamBySession } from "./types"
import { sendMessage } from "./messaging"
import { recomputeCurrentPhase } from "./task-phase"

const TEAM_TOOL_PREFIX = "team_"
/** @deprecated Prefer config.retryExhaustionAttempt; kept for tests and call sites. */
export const RETRY_WARNING_THRESHOLD = 6
const DEFAULT_FALLBACK_START = 4
const DEFAULT_EXHAUSTION_ATTEMPT = 6

/** Durable request returned when a teammate exhausts its retry allowance. */
export interface RetryExhaustion {
  kind: "exhaustion"
  leadSessionId: string
  memberName: string
  sessionId: string
  teamId: string
  reason: string
  attempts: number
  fallbackModel?: string
}

/** Soft signal when a teammate should be replaced with a fallback model. */
export interface RetryFallback {
  kind: "fallback"
  leadSessionId: string
  memberName: string
  sessionId: string
  teamId: string
  reason: string
  attempts: number
}

/** Either terminal exhaustion or mid-sequence model fallback. */
export type RetryAction = RetryExhaustion | RetryFallback

/** Thresholds controlling when fallback and exhaustion fire. */
export interface RetryPolicy {
  fallbackEnabled: boolean
  fallbackStartAttempt: number
  exhaustionAttempt: number
}

/** Tracks and reports consecutive retries for teammate sessions. */
export class RetryTracker {
  private readonly assistantMessages = new Map<string, Set<string>>()
  private readonly policy: RetryPolicy

  constructor(policy?: Partial<RetryPolicy>) {
    const exhaustion = policy?.exhaustionAttempt ?? DEFAULT_EXHAUSTION_ATTEMPT
    const fallbackStart = Math.min(policy?.fallbackStartAttempt ?? DEFAULT_FALLBACK_START, exhaustion)
    this.policy = {
      fallbackEnabled: policy?.fallbackEnabled ?? false,
      fallbackStartAttempt: fallbackStart,
      exhaustionAttempt: exhaustion,
    }
  }

  /** Observe a session status without treating retry-attempt busy transitions as progress. */
  observeStatus(
    db: Database,
    registry: MemberRegistry,
    sessionId: string,
    status: "idle" | "busy" | "retry",
    message?: string,
    attempt?: number,
  ): RetryAction | undefined {
    if (status === "busy") return
    if (status === "idle") {
      resetRetrySequence(db, sessionId)
      this.assistantMessages.delete(sessionId)
      return
    }

    const teamInfo = findTeamBySession(db, registry, sessionId)
    if (!teamInfo || teamInfo.role !== "member" || !teamInfo.memberName) return
    const memberName = teamInfo.memberName
    if (attempt === undefined) return

    return db.transaction((): RetryAction | undefined => {
      const row = db.query(
        `SELECT tm.retry_attempts, tm.retry_count, tm.retry_tripped, tm.status, tm.execution_status,
                tm.retry_fallback_used, t.lead_session_id
         FROM team_member tm
         JOIN team t ON t.id = tm.team_id
          WHERE tm.team_id = ? AND tm.name = ? AND tm.session_id = ?
            AND t.status = 'active'
            AND ((tm.status IN ('ready', 'busy')
                AND tm.execution_status IN ('idle', 'starting', 'running', 'cancel_requested'))
              OR (tm.status = 'shutdown_requested' AND tm.execution_status = 'cancelling'
                AND tm.retry_tripped = 1))`,
      ).get(teamInfo.teamId, memberName, sessionId) as {
        retry_attempts: string | null
        retry_count: number
        retry_tripped: number
        status: string
        execution_status: string
        retry_fallback_used: number
        lead_session_id: string
      } | null
      if (!row) return
      if (row.retry_tripped === 1) {
        if (row.status !== "shutdown_requested" || row.execution_status !== "cancelling") return
        return {
          kind: "exhaustion",
          leadSessionId: row.lead_session_id,
          memberName,
          sessionId,
          teamId: teamInfo.teamId,
          reason: message?.trim() || "unspecified retry reason",
          attempts: this.policy.exhaustionAttempt,
        }
      }
      const attempts = parseRetryAttempts(row.retry_attempts)
      if (attempts.has(attempt)) return
      attempts.add(attempt)
      const count = row.retry_count + 1
      const tripped = count >= this.policy.exhaustionAttempt ? 1 : 0
      const updated = db.run(
        `UPDATE team_member SET retry_attempts = ?, retry_count = ?, retry_tripped = ?, time_updated = ?
         WHERE team_id = ? AND name = ? AND session_id = ? AND retry_tripped = 0
           AND status IN ('ready', 'busy')
           AND execution_status IN ('idle', 'starting', 'running', 'cancel_requested')`,
        [JSON.stringify([...attempts]), count, tripped, Date.now(), teamInfo.teamId, memberName, sessionId],
      )
      if (updated.changes !== 1) return
      if (tripped === 1) {
        return {
          kind: "exhaustion",
          leadSessionId: row.lead_session_id,
          memberName,
          sessionId,
          teamId: teamInfo.teamId,
          reason: message?.trim() || "unspecified retry reason",
          attempts: count,
        }
      }
      // Mid-sequence model fallback: attempts in [fallbackStart, exhaustion).
      // Only fire once per member lineage until a successful reset (new session).
      if (
        this.policy.fallbackEnabled
        && count >= this.policy.fallbackStartAttempt
        && count < this.policy.exhaustionAttempt
        && row.retry_fallback_used === 0
      ) {
        return {
          kind: "fallback",
          leadSessionId: row.lead_session_id,
          memberName,
          sessionId,
          teamId: teamInfo.teamId,
          reason: message?.trim() || "unspecified retry reason",
          attempts: count,
        }
      }
      return
    })()
  }

  /** Record message ownership so only assistant output resets a retry sequence. */
  observeMessage(sessionId: string, messageId: string, role: string): void {
    if (role !== "assistant") return
    const messages = this.assistantMessages.get(sessionId) ?? new Set<string>()
    messages.add(messageId)
    this.assistantMessages.set(sessionId, messages)
  }

  /** Reset a session's retry sequence after meaningful model output. */
  observeOutput(db: Database, sessionId: string, part: unknown): void {
    if (!part || typeof part !== "object") return
    const messageId = (part as { messageID?: string }).messageID
    if (!messageId || !this.assistantMessages.get(sessionId)?.has(messageId)) return
    if (!isMeaningfulOutputPart(part)) return
    resetRetrySequence(db, sessionId)
  }

  /** Reset a session's retry sequence after a terminal session error. */
  observeSessionError(db: Database, sessionId: string | undefined): void {
    if (!sessionId) return
    resetRetrySequence(db, sessionId)
    this.assistantMessages.delete(sessionId)
  }
}

function parseRetryAttempts(value: string | null): Set<number> {
  if (!value) return new Set<number>()
  try {
    const parsed: unknown = JSON.parse(value)
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is number => typeof item === "number") : [])
  } catch {
    return new Set<number>()
  }
}

function resetRetrySequence(db: Database, sessionId: string, includeCancelling = false): void {
  db.run(
    `UPDATE team_member SET retry_attempts = NULL, retry_count = 0, retry_tripped = 0,
        retry_fallback_used = 0, retry_fallback_models = NULL
     WHERE session_id = ? AND retry_tripped = 0${includeCancelling ? "" : " AND execution_status != 'cancelling'"}`,
    [sessionId],
  )
}

function isMeaningfulOutputPart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false
  const value = part as { type?: string; text?: string; tool?: string; state?: unknown; tokens?: { output?: number } }
  if ((value.type === "text" || value.type === "reasoning") && value.text?.trim()) return true
  if (value.type === "tool" && (value.tool || value.state)) return true
  return value.type === "step-finish" && (value.tokens?.output ?? 0) > 0
}

/** Result of a session status event — tells the caller what transition happened. */
export interface StatusTransition {
  memberName: string
  teamId: string
  from: string
  to: string
}

/** Return whether shutdown is terminal enough to discard liveness tracking. */
export function shouldReleaseShutdownTracking(status: string): boolean {
  return status === "shutdown"
}

/**
 * Handle a session.status event. Updates member status and execution_status
 * in SQLite based on the new session status.
 * Ignores events for unknown sessions or archived teams.
 * Returns the transition if one occurred, for toast notifications.
 */
export function handleSessionStatusEvent(
  db: Database,
  registry: MemberRegistry,
  sessionId: string,
  status: "idle" | "busy" | "retry",
): StatusTransition | undefined {
  const entry = registry.getBySession(sessionId)
  if (!entry) return undefined

  // Check if team is archived — if so, silently ignore
  const team = db.query("SELECT status FROM team WHERE id = ?").get(entry.teamId) as { status: string } | null
  if (!team || team.status === "archived") return undefined

  const member = db.query("SELECT status, execution_status, abort_recovery_state, plan_approval FROM team_member WHERE team_id = ? AND name = ?")
    .get(entry.teamId, entry.memberName) as { status: string; execution_status: string; abort_recovery_state: string; plan_approval: string } | null
  if (!member) return undefined

  if (member.status === "error" || member.status === "shutdown") return undefined
  if (status === "idle" && member.abort_recovery_state === "checking") return undefined
  if (status === "idle" && member.execution_status === "cancelling") return undefined

  if (status === "idle") {
    if (member.status === "shutdown_requested") return undefined
    const newStatus = "ready"
    if (member.status === newStatus) return undefined
    db.run(
      "UPDATE team_member SET status = ?, execution_status = 'idle', time_updated = ? WHERE team_id = ? AND name = ?",
      [newStatus, Date.now(), entry.teamId, entry.memberName]
    )
    // Mark teammate as having reported if they sent at least one message to lead (issue #3).
    // Set on busy→ready transition so Q&A messages during work don't prematurely block delivery.
    if (member.status === "busy" && newStatus === "ready" && member.plan_approval !== "pending") {
      const leadMsgCount = (db.query(
        "SELECT COUNT(*) as c FROM team_message WHERE team_id = ? AND from_name = ? AND to_name = 'lead'"
      ).get(entry.teamId, entry.memberName) as { c: number }).c
      if (leadMsgCount > 0) {
        db.run(
          "UPDATE team_member SET reported_to_lead = 1 WHERE team_id = ? AND name = ?",
          [entry.teamId, entry.memberName]
        )
      }
    }
    return { memberName: entry.memberName, teamId: entry.teamId, from: member.status, to: newStatus }
  } else if (status === "busy") {
    if (member.status === "busy" && member.execution_status === "starting") {
      db.run(
        "UPDATE team_member SET execution_status = 'running', time_updated = ? WHERE team_id = ? AND name = ?",
        [Date.now(), entry.teamId, entry.memberName]
      )
      return undefined
    }
    if (member.status === "ready") {
      // Reset reported_to_lead so re-activated teammates can receive messages again (issue #3).
      // INVARIANT: every promptAsync delivery path must check hasReportedCompletion() to prevent loops.
      db.run(
        "UPDATE team_member SET status = 'busy', execution_status = 'running', reported_to_lead = 0, time_updated = ? WHERE team_id = ? AND name = ?",
        [Date.now(), entry.teamId, entry.memberName]
      )
      return { memberName: entry.memberName, teamId: entry.teamId, from: member.status, to: "busy" }
    }
    // Session went busy while shutdown was requested — signal for re-abort
    if (member.status === "shutdown_requested") {
      if (member.execution_status === "cancelling") return undefined
      return { memberName: entry.memberName, teamId: entry.teamId, from: "shutdown_requested", to: "busy_while_shutdown" }
    }
  }
  return undefined
}

/**
 * Handle a session.created event. Tracks the parent-child relationship
 * in the DescendantTracker for sub-agent isolation.
 */
export function handleSessionCreatedEvent(
  tracker: DescendantTracker,
  sessionId: string,
  parentId: string | undefined,
): void {
  if (parentId) {
    tracker.track(sessionId, parentId)
  }
}

/**
 * Check whether a tool call should be blocked for sub-agent isolation.
 * Throws if the tool is a team tool and the session is a descendant of a team member.
 * OQ-11: confirmed — throwing inside tool.execute.before fails the tool call gracefully (verified in live testing).
 *
 * The optional `db` parameter enables a SQLite fallback so the check works
 * across multi-Plugin-instance scenarios where the in-memory registry may
 * not have the parent teammate's session. SQLite is the canonical source.
 *
 * Order:
 *   1. Registry fast-path: if the caller is itself a registered teammate, allow.
 *   2. Otherwise enumerate active teammate session IDs from registry + SQLite.
 *   3. If the caller is among them, allow.
 *   4. If the caller is a descendant of any teammate, block.
 *
 * The fast-path skips the SQL query entirely when the registry already
 * has the caller. Lead sessions are NOT in the MemberRegistry by design
 * (only teammates are), so a lead's team_* call always misses the
 * fast-path and does the SQLite enumeration. That's acceptable — the
 * scan is bounded by total active members and runs once per tool call.
 */
export function checkToolIsolation(
  registry: MemberRegistry,
  tracker: DescendantTracker,
  toolName: string,
  sessionId: string,
  db?: Database,
): void {
  if (!toolName.startsWith(TEAM_TOOL_PREFIX)) return

  // Fast path: registry hit on the caller — skip SQL altogether.
  if (registry.isTeamSession(sessionId)) return

  // Collect every session ID that is a teammate, from the registry first
  // (fast path) and SQLite second (covers multi-instance / cross-plugin state).
  const teammateSessionIds = new Set(registry.allSessionIds())
  if (db) {
    const dbRows = db.query(
      `SELECT tm.session_id FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       WHERE t.status = 'active' AND tm.status NOT IN ('shutdown', 'error')`
    ).all() as Array<{ session_id: string }>
    for (const row of dbRows) teammateSessionIds.add(row.session_id)
  }

  // The caller may be a teammate registered in another Plugin instance — allow.
  if (teammateSessionIds.has(sessionId)) return

  if (teammateSessionIds.size > 0 && tracker.isDescendantOf(sessionId, teammateSessionIds)) {
    throw new Error("Team tools are not available to sub-agents. Report findings to your parent teammate via your normal output.")
  }
}

/**
 * Check if a member went idle without ever sending a message to the lead.
 * Returns true if the member is idle/ready and has no outbound messages.
 */
export function shouldNudgeIdleMember(db: Database, teamId: string, memberName: string): boolean {
  const member = db.query("SELECT status FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamId, memberName) as { status: string } | null
  if (!member || member.status !== "ready") return false

  const msg = db.query("SELECT id FROM team_message WHERE team_id = ? AND from_name = ? AND (to_name = 'lead' OR to_name IS NULL) LIMIT 1")
    .get(teamId, memberName) as { id: string } | null
  return !msg
}

/** Shape of an error attached to a session.error event. Subset of the SDK's union. */
export interface SessionErrorPayload {
  name?: string
  data?: { message?: string }
}

/** Lead wake target returned when a teammate first enters the error state. */
export interface SessionErrorAlert {
  leadSessionId: string
  memberName: string
}

/**
 * Handle a session.error event. Surfaces tool/model failures from a teammate
 * as a system message to the lead, so otherwise-silent failures are visible.
 *
 * Ignored when:
 * - sessionID is undefined
 * - the session is not an active teammate
 * - the teammate is already terminal or shutting down
 */
export function handleSessionErrorEvent(
  db: Database,
  registry: MemberRegistry,
  sessionId: string | undefined,
  error: SessionErrorPayload | undefined,
): SessionErrorAlert | undefined {
  if (!sessionId) return

  const member = db.query(
    `SELECT tm.team_id, tm.name, t.lead_session_id
     FROM team_member tm
     JOIN team t ON t.id = tm.team_id
     WHERE tm.session_id = ? AND t.status = 'active'`,
  ).get(sessionId) as { team_id: string; name: string; lead_session_id: string } | null
  if (!member) return

  const errMsg = error?.data?.message ?? error?.name ?? "unknown error"
  const alert = db.transaction((): SessionErrorAlert | undefined => {
    const now = Date.now()
    const claimed = db.run(
      `UPDATE team_member
       SET status = 'error', execution_status = 'failed', time_updated = ?
       WHERE team_id = ? AND name = ? AND session_id = ? AND status IN ('ready', 'busy')
         AND execution_status IN ('idle', 'starting', 'running', 'cancel_requested')`,
      [now, member.team_id, member.name, sessionId],
    )
    if (claimed.changes !== 1) return undefined

    const releasedTasks = db.run(
      `UPDATE team_task
       SET status = 'pending', assignee = NULL, time_updated = ?
       WHERE team_id = ? AND assignee = ? AND status = 'in_progress'`,
      [now, member.team_id, member.name],
    ).changes
    recomputeCurrentPhase(db, member.team_id, now)
    const taskNotice = releasedTasks > 0
      ? ` ${releasedTasks} assigned task${releasedTasks === 1 ? " was" : "s were"} returned to pending so a replacement can claim ${releasedTasks === 1 ? "it" : "them"}.`
      : ""

    sendMessage(db, {
      teamId: member.team_id,
      from: "system",
      to: "lead",
      content: `Teammate "${member.name}" (${sessionId}) failed with a session error: ${errMsg}.${taskNotice} Inspect the session and preserved branch, then replace it with team_spawn using resume_from: "${member.name}" if the task still needs work.`,
    })
    return { leadSessionId: member.lead_session_id, memberName: member.name }
  })()

  if (alert) registry.unregister(sessionId)
  return alert
}
