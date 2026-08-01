import type { Database } from "./db"
import { generateId } from "./util"

export const TELEMETRY_VERSION = 1

interface TeamEventPayloads {
  "team.created": Record<string, never>
  "task.created": { task_id: string; status: "pending" | "blocked" }
  "task.claimed": { task_id: string; assignee: string }
  "task.released": { task_id: string; reason: TaskReleaseReason }
  "task.completed": { task_id: string }
  "task.unblocked": { task_id: string }
  "member.registered": { member_name: string }
  "member.transitioned": {
    member_name: string
    from_status: MemberStatus
    to_status: MemberStatus
    from_execution: ExecutionStatus
    to_execution: ExecutionStatus
    reason: MemberTransitionReason
  }
  "plan.approved": { member_name: string }
  "plan.rejected": { member_name: string }
  "merge.started": { member_name: string }
  "merge.completed": { member_name: string }
  "merge.failed": { member_name: string }
  "consultation.requested": { consultation_id: string; task_id: string; requester: string; planner: string }
  "consultation.resolved": { consultation_id: string; task_id: string; requester: string; planner: string }
  "consultation.escalated": { consultation_id: string; task_id: string; requester: string; planner: string }
  "retry.observed": { member_name: string; attempt: number }
  "retry.fallback": { member_name: string; attempt: number }
  "retry.exhausted": { member_name: string; attempts: number }
  "recovery.stage": { member_name: string; mechanism: RecoveryMechanism; stage: RecoveryStage }
  "resume.linked": { member_name: string; predecessor_name: string; context_truncated: boolean }
  "team.archived": Record<string, never>
}

export type MemberStatus = "ready" | "busy" | "shutdown_requested" | "shutdown" | "error"
export type ExecutionStatus = "idle" | "starting" | "running" | "cancel_requested" | "cancelling" | "cancelled" | "completing" | "completed" | "failed" | "timed_out"
export type TaskReleaseReason = "spawn_rollback" | "session_error" | "retry_exhausted" | "timeout" | "startup_recovery" | "shutdown" | "force_cleanup"
export type MemberTransitionReason = "session_status" | "session_error" | "retry_exhausted" | "timeout" | "startup_recovery" | "shutdown" | "force_cleanup" | "task_completed"
export type RecoveryMechanism = "startup" | "safe_abort" | "watchdog" | "late_terminal"
export type RecoveryStage = "detected" | "claimed" | "preserved" | "settled" | "failed" | "prompted" | "reaborted"

export type TeamEventKind = keyof TeamEventPayloads

export type TeamEventInput = {
  [K in TeamEventKind]: {
    teamId: string
    kind: K
    payload: TeamEventPayloads[K]
    causeEventId?: string
  }
}[TeamEventKind]

const PAYLOAD_KEYS: { [K in TeamEventKind]: readonly (keyof TeamEventPayloads[K])[] } = {
  "team.created": [],
  "task.created": ["task_id", "status"],
  "task.claimed": ["task_id", "assignee"],
  "task.released": ["task_id", "reason"],
  "task.completed": ["task_id"],
  "task.unblocked": ["task_id"],
  "member.registered": ["member_name"],
  "member.transitioned": ["member_name", "from_status", "to_status", "from_execution", "to_execution", "reason"],
  "plan.approved": ["member_name"],
  "plan.rejected": ["member_name"],
  "merge.started": ["member_name"],
  "merge.completed": ["member_name"],
  "merge.failed": ["member_name"],
  "consultation.requested": ["consultation_id", "task_id", "requester", "planner"],
  "consultation.resolved": ["consultation_id", "task_id", "requester", "planner"],
  "consultation.escalated": ["consultation_id", "task_id", "requester", "planner"],
  "retry.observed": ["member_name", "attempt"],
  "retry.fallback": ["member_name", "attempt"],
  "retry.exhausted": ["member_name", "attempts"],
  "recovery.stage": ["member_name", "mechanism", "stage"],
  "resume.linked": ["member_name", "predecessor_name", "context_truncated"],
  "team.archived": [],
}

const MAX_PAYLOAD_BYTES = 2 * 1024

const TEAM_EVENT_NO_DELETE_TRIGGER = `CREATE TRIGGER team_event_no_delete
  BEFORE DELETE ON team_event
  BEGIN
    SELECT RAISE(ABORT, 'team_event rows are immutable');
  END;`

const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,127}$/
const MEMBER_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
const MEMBER_STATUSES = new Set<MemberStatus>(["ready", "busy", "shutdown_requested", "shutdown", "error"])
const EXECUTION_STATUSES = new Set<ExecutionStatus>(["idle", "starting", "running", "cancel_requested", "cancelling", "cancelled", "completing", "completed", "failed", "timed_out"])
const TASK_RELEASE_REASONS = new Set<TaskReleaseReason>(["spawn_rollback", "session_error", "retry_exhausted", "timeout", "startup_recovery", "shutdown", "force_cleanup"])
const MEMBER_TRANSITION_REASONS = new Set<MemberTransitionReason>(["session_status", "session_error", "retry_exhausted", "timeout", "startup_recovery", "shutdown", "force_cleanup", "task_completed"])
const RECOVERY_MECHANISMS = new Set<RecoveryMechanism>(["startup", "safe_abort", "watchdog", "late_terminal"])
const RECOVERY_STAGES = new Set<RecoveryStage>(["detected", "claimed", "preserved", "settled", "failed", "prompted", "reaborted"])

function isMemberName(value: unknown): value is string {
  return typeof value === "string" && (value === "lead" || MEMBER_NAME.test(value))
}

function validatePayloadValue(kind: TeamEventKind, key: string, value: unknown): string | number | boolean {
  if (key === "task_id" || key === "consultation_id") {
    if (typeof value === "string" && IDENTIFIER.test(value)) return value
  } else if (key === "member_name" || key === "assignee" || key === "requester" || key === "planner" || key === "predecessor_name") {
    if (isMemberName(value)) return value
  } else if (key === "status") {
    if (value === "pending" || value === "blocked") return value
  } else if (key === "from_status" || key === "to_status") {
    if (typeof value === "string" && MEMBER_STATUSES.has(value as MemberStatus)) return value
  } else if (key === "from_execution" || key === "to_execution") {
    if (typeof value === "string" && EXECUTION_STATUSES.has(value as ExecutionStatus)) return value
  } else if (key === "reason") {
    if (kind === "task.released" && typeof value === "string" && TASK_RELEASE_REASONS.has(value as TaskReleaseReason)) return value
    if (kind === "member.transitioned" && typeof value === "string" && MEMBER_TRANSITION_REASONS.has(value as MemberTransitionReason)) return value
  } else if (key === "attempt" || key === "attempts") {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000) return value
  } else if (key === "mechanism") {
    if (typeof value === "string" && RECOVERY_MECHANISMS.has(value as RecoveryMechanism)) return value
  } else if (key === "stage") {
    if (typeof value === "string" && RECOVERY_STAGES.has(value as RecoveryStage)) return value
  } else if (key === "context_truncated" && typeof value === "boolean") {
    return value
  }
  throw new Error(`Invalid payload value for team event kind ${kind}`)
}

function serializePayload(kind: TeamEventKind, payload: object): string {
  const allowed = PAYLOAD_KEYS[kind] as readonly string[] | undefined
  if (!allowed) throw new Error(`Unsupported team event kind: ${String(kind)}`)
  if (Array.isArray(payload)) {
    throw new Error(`Invalid payload for team event kind ${kind}`)
  }
  const keys = Object.keys(payload)
  if (keys.length !== allowed.length || keys.some(key => !allowed.includes(key))) {
    throw new Error(`Invalid payload fields for team event kind ${kind}`)
  }
  const safePayload = Object.create(null) as Record<string, string | number | boolean>
  for (const key of allowed) {
    const value = (payload as Record<string, unknown>)[key]
    safePayload[key] = validatePayloadValue(kind, key, value)
  }
  const serialized = JSON.stringify(safePayload)
  if (new TextEncoder().encode(serialized).length > MAX_PAYLOAD_BYTES) {
    throw new Error("Team event payload exceeds 2 KiB")
  }
  return serialized
}

/** Insert one privacy-safe immutable event row retained until explicit Team purge. */
export function appendTeamEvent(db: Database, event: TeamEventInput): string {
  if (!event.payload || typeof event.payload !== "object") {
    throw new Error(`Invalid payload for team event kind ${event.kind}`)
  }
  const eventKeys = Object.keys(event)
  if (eventKeys.some(key => key !== "teamId" && key !== "kind" && key !== "payload" && key !== "causeEventId")) {
    throw new Error("Invalid team event fields")
  }
  const { teamId, kind, payload, causeEventId } = event
  for (const value of [teamId, causeEventId]) {
    if (value !== undefined && !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(value)) {
      throw new Error("Invalid team event identifier")
    }
  }
  const serializedPayload = serializePayload(kind, payload)
  const id = generateId("event")
  db.run(
     `INSERT INTO team_event (id, team_id, kind, payload, cause_event_id, time_created, instrumentation_version)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, teamId, kind, serializedPayload, causeEventId ?? null, Date.now(), TELEMETRY_VERSION],
  )
  return id
}

/** Append non-authoritative observation telemetry without affecting runtime behavior. */
export function appendTeamEventBestEffort(db: Database, event: TeamEventInput): string | undefined {
  try {
    return appendTeamEvent(db, event)
  } catch {
    return undefined
  }
}

/** Delete one archived Team through the explicit purge path while restoring event immutability. */
export function deleteArchivedTeamForExplicitPurge(db: Database, teamId: string): number {
  db.exec("DROP TRIGGER team_event_no_delete")
  try {
    return db.run("DELETE FROM team WHERE id = ? AND status = 'archived'", [teamId]).changes
  } finally {
    db.exec(TEAM_EVENT_NO_DELETE_TRIGGER)
  }
}
