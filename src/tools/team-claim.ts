import type { ToolDeps } from "../types"
import { immediateTransaction } from "../db"
import { recomputeCurrentPhase } from "../task-phase"
import { requireTeamMember } from "./shared"

/**
 * Execute the team_claim tool. Atomically claims a pending task.
 * Rejects if the task is already claimed, waiting on dependencies, or not pending.
 */
export async function executeTeamClaim(
  deps: ToolDeps,
  args: { task_id: string },
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)

  const claimerName = teamInfo.role === "lead" ? "lead" : (teamInfo.memberName ?? "unknown")

  const now = Date.now()
  const content = immediateTransaction(deps.db, () => {
    const task = deps.db.query("SELECT * FROM team_task WHERE id = ? AND team_id = ?")
      .get(args.task_id, teamInfo.teamId) as Record<string, unknown> | null
    if (!task) throw new Error(`Task "${args.task_id}" not found`)
    if (task.status === "blocked") throw new Error(`Task "${args.task_id}" is waiting for unresolved dependencies`)
    if (task.status !== "pending") throw new Error(`Task "${args.task_id}" is not pending (status: ${task.status})`)
    if (task.assignee) throw new Error(`Task "${args.task_id}" is already claimed by ${task.assignee}`)

    const result = deps.db.run(
      "UPDATE team_task SET status = 'in_progress', assignee = ?, time_updated = ? WHERE id = ? AND team_id = ? AND status = 'pending' AND assignee IS NULL",
      [claimerName, now, args.task_id, teamInfo.teamId],
    )
    if (result.changes === 0) throw new Error(`Task "${args.task_id}" is already claimed (race condition)`)
    recomputeCurrentPhase(deps.db, teamInfo.teamId, now)
    return String(task.content)
  })

  return `Claimed task: ${content}`
}
