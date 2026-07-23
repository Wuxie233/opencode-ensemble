import type { Database } from "./db"
import { generateId } from "./util"

interface TeamEventPayloads {
  "team.created": Record<string, never>
  "task.created": { task_id: string; status: "pending" | "blocked" }
  "task.claimed": { task_id: string; assignee: string }
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
    operationId?: string
    causeEventId?: string
  }
}[TeamEventKind]

const PAYLOAD_KEYS: { [K in TeamEventKind]: readonly (keyof TeamEventPayloads[K])[] } = {
  "team.created": [],
  "task.created": ["task_id", "status"],
  "task.claimed": ["task_id", "assignee"],
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

function serializePayload(event: TeamEventInput): string {
  const allowed = PAYLOAD_KEYS[event.kind] as readonly string[] | undefined
  if (!allowed) throw new Error(`Unsupported team event kind: ${String(event.kind)}`)
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    throw new Error(`Invalid payload for team event kind ${event.kind}`)
  }
  const keys = Object.keys(event.payload)
  if (keys.length !== allowed.length || keys.some(key => !allowed.includes(key))) {
    throw new Error(`Invalid payload fields for team event kind ${event.kind}`)
  }
  const serialized = JSON.stringify(event.payload)
  if (new TextEncoder().encode(serialized).length > MAX_PAYLOAD_BYTES) {
    throw new Error("Team event payload exceeds 2 KiB")
  }
  for (const key of allowed) {
    const value = (event.payload as Record<string, unknown>)[key]
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Invalid payload value for team event kind ${event.kind}`)
    }
    if (key === "task_id" && !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(value)) {
      throw new Error(`Invalid payload value for team event kind ${event.kind}`)
    }
    if ((key === "member_name" || key === "assignee") && value !== "lead" && !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)) {
      throw new Error(`Invalid payload value for team event kind ${event.kind}`)
    }
  }
  if (event.kind === "task.created" && event.payload.status !== "pending" && event.payload.status !== "blocked") {
    throw new Error("Invalid task.created status")
  }
  return serialized
}

/** Append one privacy-safe lifecycle event inside the caller's SQLite transaction. */
export function appendTeamEvent(db: Database, event: TeamEventInput): string {
  for (const value of [event.teamId, event.operationId, event.causeEventId]) {
    if (value !== undefined && !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(value)) {
      throw new Error("Invalid team event identifier")
    }
  }
  const payload = serializePayload(event)
  const id = generateId("event")
  db.run(
    `INSERT INTO team_event (id, team_id, kind, payload, operation_id, cause_event_id, time_created)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, event.teamId, event.kind, payload, event.operationId ?? null, event.causeEventId ?? null, Date.now()],
  )
  return id
}
