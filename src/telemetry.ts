import { createHash } from "node:crypto"
import type { Database } from "./db"
import type { MemberRegistry } from "./state"
import { TELEMETRY_VERSION } from "./team-event"
import { appendTeamEvent, type ExecutionStatus, type MemberStatus, type MemberTransitionReason, type TaskReleaseReason } from "./team-event"

interface UsageEvent {
  id?: string
  type: string
  properties: {
    sessionID?: string
    timestamp?: number
    cost?: number
    tokens?: { input?: number; output?: number }
  }
}

function validTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function validTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function validCost(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}

/** Aggregate numeric SDK usage for an active teammate without retaining Session or message data. */
export function recordUsageFromV2Event(db: Database, registry: MemberRegistry, event: UsageEvent): void {
  if (event.type !== "session.next.step.ended") return
  if (typeof event.id !== "string" || event.id.length === 0) return
  const sessionId = event.properties.sessionID
  if (!sessionId) return
  const timestamp = validTimestamp(event.properties.timestamp)
  if (timestamp === undefined) return
  const member = registry.getBySession(sessionId)
  if (!member) return
  const inputTokens = validTokenCount(event.properties.tokens?.input)
  const outputTokens = validTokenCount(event.properties.tokens?.output)
  const cost = validCost(event.properties.cost)
  if (inputTokens === 0 && outputTokens === 0 && cost === 0) return
  const eventDigest = createHash("sha256").update(event.id).digest("hex")
  try {
    db.transaction(() => {
      const inserted = db.run(
        `INSERT OR IGNORE INTO team_usage_event (event_digest, team_id, instrumentation_version)
         SELECT ?, tm.team_id, ?
         FROM team_member tm JOIN team t ON t.id = tm.team_id
         WHERE tm.team_id = ? AND tm.name = ? AND tm.session_id = ? AND t.status = 'active'`,
        [eventDigest, TELEMETRY_VERSION, member.teamId, member.memberName, sessionId],
      ).changes
      if (inserted === 0) return
      db.run(
        `INSERT INTO team_usage_aggregate
           (team_id, member_name, input_tokens, output_tokens, cost, event_count, coverage_start, coverage_end, instrumentation_version)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(team_id, member_name) DO UPDATE SET
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           cost = cost + excluded.cost,
           event_count = event_count + 1,
           coverage_start = MIN(coverage_start, excluded.coverage_start),
           coverage_end = MAX(coverage_end, excluded.coverage_end)`,
        [member.teamId, member.memberName, inputTokens, outputTokens, cost, timestamp, timestamp, TELEMETRY_VERSION],
      )
    })()
  } catch {
    // Observational usage must never affect the SDK event path.
  }
}

/** Append the immutable evidence for one authoritative Member state transition. */
export function appendMemberTransition(
  db: Database,
  teamId: string,
  memberName: string,
  fromStatus: MemberStatus,
  toStatus: MemberStatus,
  fromExecution: ExecutionStatus,
  toExecution: ExecutionStatus,
  reason: MemberTransitionReason,
): void {
  appendTeamEvent(db, {
    teamId,
    kind: "member.transitioned",
    payload: {
      member_name: memberName,
      from_status: fromStatus,
      to_status: toStatus,
      from_execution: fromExecution,
      to_execution: toExecution,
      reason,
    },
  })
}

/** Release all currently owned tasks and append one privacy-safe event per changed task. */
export function releaseMemberTasks(
  db: Database,
  teamId: string,
  memberName: string,
  reason: TaskReleaseReason,
  now: number,
): number {
  const tasks = db.query(
    "SELECT id FROM team_task WHERE team_id = ? AND assignee = ? AND status = 'in_progress' ORDER BY time_created, id",
  ).all(teamId, memberName) as Array<{ id: string }>
  if (tasks.length === 0) return 0
  const released = db.run(
    `UPDATE team_task SET status = 'pending', assignee = NULL, time_updated = ?
     WHERE team_id = ? AND assignee = ? AND status = 'in_progress'`,
    [now, teamId, memberName],
  ).changes
  for (const task of tasks) {
    appendTeamEvent(db, { teamId, kind: "task.released", payload: { task_id: task.id, reason } })
  }
  return released
}
