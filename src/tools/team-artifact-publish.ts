import { publishArtifact } from "../artifact"
import type { ArtifactKind, ArtifactMediaType } from "../artifact"
import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"

/** Arguments accepted by team_artifact_publish. */
export interface TeamArtifactPublishArgs {
  kind: ArtifactKind
  content: string
  media_type?: ArtifactMediaType
  task_id?: string
}

/** Publish an immutable contract or task result for the caller's active Team. */
export function executeTeamArtifactPublish(deps: ToolDeps, args: TeamArtifactPublishArgs, sessionId: string): string {
  const actor = requireTeamMember(deps, sessionId)
  const result = publishArtifact(deps.db, deps.config, actor, {
    kind: args.kind,
    content: args.content,
    mediaType: args.media_type,
    taskId: args.task_id,
  })
  return [
    `Published ${result.kind} artifact ${result.artifactId}.`,
    `SHA-256: ${result.sha256}`,
    `Media type: ${result.mediaType}`,
    `UTF-8 bytes: ${result.byteCount}`,
  ].join("\n")
}
