import type { Database } from "./db"
import { generateId } from "./util"

interface TeamEventPayloads {
  "team.created": Record<string, never>
  "task.created": { task_id: string; status: "pending" | "blocked" }
  "task.claimed": { task_id: string; assignee: string }
  "task.released": { task_id: string; reason: "spawn_rollback" }
  "task.completed": { task_id: string }
  "task.unblocked": { task_id: string }
  "member.registered": { member_name: string }
  "plan.approved": { member_name: string }
  "plan.rejected": { member_name: string }
  "merge.started": { member_name: string }
  "merge.completed": { member_name: string }
  "merge.failed": { member_name: string }
  "team.archived": Record<string, never>
}

export type TeamEventKind = keyof TeamEventPayloads

type TeamEventInput = {
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
  "plan.approved": ["member_name"],
  "plan.rejected": ["member_name"],
  "merge.started": ["member_name"],
  "merge.completed": ["member_name"],
  "merge.failed": ["member_name"],
  "team.archived": [],
}

const MAX_PAYLOAD_BYTES = 2 * 1024

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
  const safePayload = Object.create(null) as Record<string, string>
  for (const key of allowed) {
    const value = (payload as Record<string, unknown>)[key]
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Invalid payload value for team event kind ${kind}`)
    }
    if (key === "task_id" && !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(value)) {
      throw new Error(`Invalid payload value for team event kind ${kind}`)
    }
    if ((key === "member_name" || key === "assignee") && value !== "lead" && !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)) {
      throw new Error(`Invalid payload value for team event kind ${kind}`)
    }
    safePayload[key] = value
  }
  if (kind === "task.created" && safePayload.status !== "pending" && safePayload.status !== "blocked") {
    throw new Error("Invalid task.created status")
  }
  if (kind === "task.released" && safePayload.reason !== "spawn_rollback") {
    throw new Error("Invalid task.released reason")
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
    `INSERT INTO team_event (id, team_id, kind, payload, cause_event_id, time_created)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, teamId, kind, serializedPayload, causeEventId ?? null, Date.now()],
  )
  return id
}
