import { createHash } from "node:crypto"
import type { EnsembleConfig } from "./config"
import type { Database } from "./db"
import { immediateTransaction } from "./db"
import { generateId } from "./util"

/** Artifact kinds supported by the Team control plane. */
export type ArtifactKind = "contract" | "task_result"

/** Text media types supported by Team artifacts. */
export type ArtifactMediaType = "text/plain" | "text/markdown"

/** Identity resolved from the calling Team session. */
export interface ArtifactActor {
  teamId: string
  role: "lead" | "member"
  memberName?: string
}

/** Inputs used to publish one immutable Team artifact. */
export interface PublishArtifactInput {
  kind: ArtifactKind
  content: string
  mediaType?: ArtifactMediaType
  taskId?: string
}

/** Metadata returned after a successful artifact publish. */
export interface ArtifactMetadata {
  artifactId: string
  kind: ArtifactKind
  taskId: string | null
  createdBy: string
  sha256: string
  mediaType: ArtifactMediaType
  byteCount: number
  timeCreated: number
}

/** Exact artifact content and its provenance metadata. */
export interface ArtifactRecord extends ArtifactMetadata {
  content: string
}

/** Filters for bounded artifact metadata listing. */
export interface ListArtifactsInput {
  kind?: ArtifactKind
  taskId?: string
  limit?: number
}

const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 100

function validatePublishInput(input: PublishArtifactInput, byteCount: number, maxBytes: number): ArtifactMediaType {
  if (input.kind !== "contract" && input.kind !== "task_result") throw new Error("Unsupported artifact kind.")
  const mediaType = input.mediaType ?? "text/plain"
  if (mediaType !== "text/plain" && mediaType !== "text/markdown") throw new Error("Unsupported artifact media type.")
  if (byteCount === 0) throw new Error("Artifact content cannot be empty.")
  if (byteCount > maxBytes) throw new Error(`Artifact content exceeds the ${maxBytes}-byte limit.`)
  if (input.kind === "contract" && input.taskId !== undefined) throw new Error("task_id is forbidden for contract artifacts.")
  if (input.kind === "task_result" && !input.taskId) throw new Error("task_id is required for task_result artifacts.")
  return mediaType
}

function actorName(actor: ArtifactActor): string {
  return actor.role === "lead" ? "lead" : (actor.memberName ?? "")
}

function authorizePublish(db: Database, actor: ArtifactActor, input: PublishArtifactInput): string {
  if (input.kind === "contract") {
    if (actor.role !== "lead") throw new Error("Only the team lead can publish contract artifacts.")
    return "lead"
  }

  const createdBy = actorName(actor)
  const task = db.query(
    "SELECT status, assignee FROM team_task WHERE id = ? AND team_id = ?",
  ).get(input.taskId, actor.teamId) as { status: string; assignee: string | null } | null
  if (!task || task.status !== "in_progress" || task.assignee !== createdBy) {
    throw new Error("task_result requires an in-progress same-Team task assigned to the caller.")
  }
  return createdBy
}

/** Publish one immutable artifact with authorization and quota reservation in one write transaction. */
export function publishArtifact(
  db: Database,
  config: Required<EnsembleConfig>,
  actor: ArtifactActor,
  input: PublishArtifactInput,
  now = Date.now(),
): ArtifactMetadata {
  const bytes = new TextEncoder().encode(input.content)
  const byteCount = bytes.byteLength
  const mediaType = validatePublishInput(input, byteCount, config.artifactMaxBytes)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const artifactId = generateId("artifact")

  return immediateTransaction(db, () => {
    const createdBy = authorizePublish(db, actor, input)
    const teamUsage = db.query(
      "SELECT COUNT(*) AS artifact_count, COALESCE(SUM(byte_count), 0) AS byte_count FROM team_artifact WHERE team_id = ?",
    ).get(actor.teamId) as { artifact_count: number; byte_count: number }
    if (teamUsage.artifact_count >= config.artifactTeamMaxCount) {
      throw new Error(`Team artifact count limit of ${config.artifactTeamMaxCount} has been reached.`)
    }
    if (teamUsage.byte_count + byteCount > config.artifactTeamMaxBytes) {
      throw new Error(`Team artifact byte limit of ${config.artifactTeamMaxBytes} would be exceeded.`)
    }
    const globalUsage = db.query(
      "SELECT COALESCE(SUM(byte_count), 0) AS byte_count FROM team_artifact",
    ).get() as { byte_count: number }
    if (globalUsage.byte_count + byteCount > config.artifactGlobalMaxBytes) {
      throw new Error(`Global artifact byte limit of ${config.artifactGlobalMaxBytes} would be exceeded.`)
    }

    db.run(
      `INSERT INTO team_artifact
       (id, team_id, kind, task_id, created_by, sha256, media_type, byte_count, content, time_created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [artifactId, actor.teamId, input.kind, input.taskId ?? null, createdBy, sha256, mediaType, byteCount, input.content, now],
    )
    return { artifactId, kind: input.kind, taskId: input.taskId ?? null, createdBy, sha256, mediaType, byteCount, timeCreated: now }
  })
}

/** List bounded metadata for artifacts owned by one exact Team. */
export function listArtifacts(db: Database, teamId: string, input: ListArtifactsInput): ArtifactMetadata[] {
  if (input.kind !== undefined && input.kind !== "contract" && input.kind !== "task_result") {
    throw new Error("Unsupported artifact kind.")
  }
  const limit = input.limit ?? DEFAULT_LIST_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new Error(`Artifact list limit must be an integer from 1 to ${MAX_LIST_LIMIT}.`)
  }
  const clauses = ["team_id = ?"]
  const params: Array<string | number> = [teamId]
  if (input.kind) {
    clauses.push("kind = ?")
    params.push(input.kind)
  }
  if (input.taskId) {
    clauses.push("task_id = ?")
    params.push(input.taskId)
  }
  params.push(limit)
  const rows = db.query(
    `SELECT id, kind, task_id, created_by, sha256, media_type, byte_count, time_created
     FROM team_artifact WHERE ${clauses.join(" AND ")}
     ORDER BY time_created DESC, id DESC LIMIT ?`,
  ).all(...params) as Array<{
    id: string
    kind: ArtifactKind
    task_id: string | null
    created_by: string
    sha256: string
    media_type: ArtifactMediaType
    byte_count: number
    time_created: number
  }>
  return rows.map(row => ({
    artifactId: row.id,
    kind: row.kind,
    taskId: row.task_id,
    createdBy: row.created_by,
    sha256: row.sha256,
    mediaType: row.media_type,
    byteCount: row.byte_count,
    timeCreated: row.time_created,
  }))
}

/** Read one exact artifact from one Team, hiding unknown and cross-Team IDs alike. */
export function readArtifact(db: Database, teamId: string, artifactId: string): ArtifactRecord {
  const row = db.query(
    `SELECT id, kind, task_id, created_by, sha256, media_type, byte_count, content, time_created
     FROM team_artifact WHERE id = ? AND team_id = ?`,
  ).get(artifactId, teamId) as {
    id: string
    kind: ArtifactKind
    task_id: string | null
    created_by: string
    sha256: string
    media_type: ArtifactMediaType
    byte_count: number
    content: string
    time_created: number
  } | null
  if (!row) {
    throw new Error(`Artifact "${artifactId}" was not found in the caller's active Team. Check the exact artifact ID and Team scope.`)
  }
  const bytes = new TextEncoder().encode(row.content)
  const digest = createHash("sha256").update(bytes).digest("hex")
  if (bytes.byteLength !== row.byte_count || digest !== row.sha256) {
    throw new Error("Artifact integrity check failed.")
  }
  return {
    artifactId: row.id,
    kind: row.kind,
    taskId: row.task_id,
    createdBy: row.created_by,
    sha256: row.sha256,
    mediaType: row.media_type,
    byteCount: row.byte_count,
    timeCreated: row.time_created,
    content: row.content,
  }
}
