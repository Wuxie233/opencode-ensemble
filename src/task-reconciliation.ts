import type { Database } from "./db"
import { sendMessage } from "./messaging"
import { parseTaskResult } from "./result-parser"

const MAX_ALERT_TASKS = 10

/** Return whether message content contains a structured terminal task result. */
export function isTerminalTaskResult(content: string): boolean {
  const result = parseTaskResult(content)
  if (!result) return false
  return result.kind === "result" || result.status === "completed" || result.status === "failed"
}

/**
 * Persist one actionable Lead alert when a member still owns in-progress work
 * after reporting a terminal result or becoming idle. This is observation only:
 * task completion remains exclusive to team_tasks_complete.
 */
export function recordTaskReconciliationAlert(
  db: Database,
  teamId: string,
  memberName: string,
): string | undefined {
  const tasks = db.query(
    `SELECT tt.id, tt.time_updated
     FROM team_task tt
     JOIN team t ON t.id = tt.team_id
     JOIN team_member tm ON tm.team_id = tt.team_id AND tm.name = tt.assignee
     WHERE tt.team_id = ? AND tt.assignee = ? AND tt.status = 'in_progress'
       AND t.status = 'active' AND tm.status IN ('ready', 'busy')
     ORDER BY tt.time_updated ASC, tt.id ASC
     LIMIT ?`,
  ).all(teamId, memberName, MAX_ALERT_TASKS + 1) as Array<{ id: string; time_updated: number }>
  if (tasks.length === 0) return undefined

  const visible = tasks.slice(0, MAX_ALERT_TASKS).map(task => task.id)
  const remaining = tasks.length > MAX_ALERT_TASKS ? ` and at least ${tasks.length - MAX_ALERT_TASKS} more` : ""
  const content = `Task reconciliation required: Teammate "${memberName}" reported a terminal result or became idle while still owning in_progress task(s): ${visible.join(", ")}${remaining}. The task board was not changed automatically. Verify the reported result, then use team_tasks_complete only for successful work; for failed work, follow the normal shutdown/recovery flow and reassign after the task is released.`
  const taskVersion = Math.max(...tasks.map(task => task.time_updated))
  const existing = db.query(
    `SELECT id FROM team_message
     WHERE team_id = ? AND from_name = 'system' AND to_name = 'lead' AND content = ? AND time_created >= ?
     LIMIT 1`,
  ).get(teamId, content, taskVersion) as { id: string } | null
  if (existing) return undefined

  return sendMessage(db, {
    teamId,
    from: "system",
    to: "lead",
    content,
  })
}
