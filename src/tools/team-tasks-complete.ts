import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"
import { log } from "../log"
import { sendMessage, wakeTeamLead } from "../messaging"

/**
 * Execute the team_tasks_complete tool. Marks a task as completed
 * and unblocks any dependent tasks.
 */
export async function executeTeamTasksComplete(
  deps: ToolDeps,
  args: { task_id: string },
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)

  const task = deps.db.query("SELECT * FROM team_task WHERE id = ? AND team_id = ?")
    .get(args.task_id, teamInfo.teamId) as Record<string, unknown> | null
  if (!task) throw new Error(`Task "${args.task_id}" not found`)

  const now = Date.now()
  let unblocked = 0
  const changed = deps.db.transaction(() => {
    const completion = deps.db.run(
      "UPDATE team_task SET status = 'completed', time_updated = ? WHERE id = ? AND team_id = ? AND status != 'completed'",
      [now, args.task_id, teamInfo.teamId],
    )
    if (completion.changes !== 1) return false

    const allTasks = deps.db.query("SELECT id, depends_on, status FROM team_task WHERE team_id = ?")
      .all(teamInfo.teamId) as Array<{ id: string; depends_on: string | null; status: string }>
    for (const t of allTasks) {
      if (t.status !== "blocked" || !t.depends_on) continue
      const depIds: string[] = JSON.parse(t.depends_on)
      if (!depIds.includes(args.task_id)) continue
      const allResolved = depIds.every(depId => {
        if (depId === args.task_id) return true
        const dep = allTasks.find(d => d.id === depId)
        return dep && (dep.status === "completed" || dep.status === "cancelled")
      })
      if (!allResolved) continue
      deps.db.run("UPDATE team_task SET status = 'pending', time_updated = ? WHERE id = ?", [now, t.id])
      unblocked++
    }

    const who = teamInfo.memberName ?? "lead"
    sendMessage(deps.db, {
      teamId: teamInfo.teamId,
      from: "system",
      to: "lead",
      content: `Task ${args.task_id} was completed by ${who}.${unblocked > 0 ? ` ${unblocked} dependent task${unblocked === 1 ? " is" : "s are"} now ready.` : ""}`,
    })
    return true
  })()
  if (!changed) return `Task already completed: ${task.content}`
  wakeTeamLead(deps.db, deps.client, teamInfo.teamId, `[System: Task ${args.task_id} completed; updated Team state is available]`)

  // Fire progress toast so the lead has visibility
  const counts = deps.db.query(
    "SELECT status, COUNT(*) as c FROM team_task WHERE team_id = ? GROUP BY status"
  ).all(teamInfo.teamId) as Array<{ status: string; c: number }>
  const completed = counts.find(r => r.status === "completed")?.c ?? 0
  const total = counts.reduce((sum, r) => sum + r.c, 0)
  const who = teamInfo.memberName ?? "teammate"
  try {
    deps.client.tui.showToast({
      title: "Team",
      message: `${who}: ${completed}/${total} tasks complete`,
      variant: "info",
      duration: 3000,
    }).catch(() => { /* TUI may not be available */ })
  } catch { log(`tasks-complete:toast:failed`) }

  const unblockedMsg = unblocked > 0 ? ` Unblocked ${unblocked} dependent task${unblocked !== 1 ? "s" : ""}.` : ""
  return `Completed task: ${task.content}${unblockedMsg}`
}
