import { listArtifacts } from "../artifact"
import type { ArtifactKind } from "../artifact"
import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"

/** Arguments accepted by team_artifact_list. */
export interface TeamArtifactListArgs {
  kind?: ArtifactKind
  task_id?: string
  limit?: number
}

/** List bounded artifact provenance metadata without returning content. */
export function executeTeamArtifactList(deps: ToolDeps, args: TeamArtifactListArgs, sessionId: string): string {
  const actor = requireTeamMember(deps, sessionId)
  const artifacts = listArtifacts(deps.db, actor.teamId, {
    kind: args.kind,
    taskId: args.task_id,
    limit: args.limit,
  })
  if (artifacts.length === 0) return "No Team artifacts found."
  return artifacts.map(artifact => [
    `${artifact.artifactId} [${artifact.kind}]`,
    `task=${artifact.taskId ?? "none"}`,
    `author=${artifact.createdBy}`,
    `sha256=${artifact.sha256}`,
    `media=${artifact.mediaType}`,
    `bytes=${artifact.byteCount}`,
    `created=${new Date(artifact.timeCreated).toISOString()}`,
  ].join(" ")).join("\n")
}
