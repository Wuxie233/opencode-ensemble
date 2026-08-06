import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"

/**
 * Execute the team_tasks_list tool. Shows all tasks on the shared board.
 */
export async function executeTeamTasksList(
  deps: ToolDeps,
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)

  const tasks = deps.db.query(
    "SELECT * FROM team_task WHERE team_id = ? ORDER BY time_created ASC"
  ).all(teamInfo.teamId) as Array<Record<string, unknown>>

  if (tasks.length === 0) return "No tasks on the board."

  return tasks.map(t => {
    const status = t.status === "blocked" ? "waiting" : t.status
    const contract = t.contract_artifact_id
      ? ` [contract: ${t.contract_artifact_id} sha256:${t.contract_artifact_sha256}]`
      : ""
    let capabilities = ""
    if (typeof t.required_capabilities === "string" && t.required_capabilities) {
      try {
        const parsed = JSON.parse(t.required_capabilities) as unknown
        if (Array.isArray(parsed) && parsed.every(value => typeof value === "string")) {
          capabilities = ` [requires: ${(parsed as string[]).join(", ")}]`
        }
      } catch {
        capabilities = " [requires: invalid-contract]"
      }
    }
    return `[${status}] ${t.content} (${t.id})${t.assignee ? ` → ${t.assignee}` : ""}${t.priority !== "medium" ? ` [${t.priority}]` : ""}${t.phase ? ` [phase: ${t.phase}]` : ""}${capabilities}${contract}`
  }).join("\n")
}
