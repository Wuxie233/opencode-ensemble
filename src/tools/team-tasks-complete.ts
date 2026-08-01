import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"
import { log } from "../log"
import { sendMessage, wakeTeamLead } from "../messaging"
import { immediateTransaction } from "../db"
import { serializeTaskResult } from "../result-parser"
import { recomputeCurrentPhase } from "../task-phase"
import { appendTeamEvent } from "../team-event"

interface TerminalResultInput {
  summary: string
  details: string
  branch?: string
}

interface CompleteTaskArgs {
  task_id: string
  result?: TerminalResultInput
}

interface CompleteTaskOutcome {
  changed: boolean
  content: string
  unblocked: number
}

/**
 * Execute the team_tasks_complete tool. Marks a task as completed
 * and unblocks any dependent tasks.
 */
export async function executeTeamTasksComplete(
  deps: ToolDeps,
  args: CompleteTaskArgs,
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)
  const now = Date.now()
  const outcome = immediateTransaction(deps.db, (): CompleteTaskOutcome => {
    const task = deps.db.query("SELECT content, status, assignee FROM team_task WHERE id = ? AND team_id = ?")
      .get(args.task_id, teamInfo.teamId) as { content: string; status: string; assignee: string | null } | null
    if (!task) throw new Error(`Task "${args.task_id}" not found`)

    const memberName = teamInfo.memberName
    let terminalContent: string | undefined
    if (args.result) {
      if (teamInfo.role !== "member" || !memberName) {
        throw new Error("Only a teammate can attach a terminal result to task completion")
      }
      if (task.assignee !== memberName) {
        const owner = task.assignee ?? "nobody"
        throw new Error(`Task "${args.task_id}" is owned by ${owner}, not ${memberName}`)
      }
      if (!args.result.summary.trim() || !args.result.details.trim()) {
        throw new Error("Terminal result summary and details must not be empty")
      }
      terminalContent = serializeTaskResult({
        kind: "result",
        taskId: args.task_id,
        status: "completed",
        summary: args.result.summary.trim(),
        details: args.result.details.trim(),
        branch: args.result.branch?.trim() || undefined,
      })
    }
    if (task.status === "completed") return { changed: false, content: task.content, unblocked: 0 }

    const completion = deps.db.run(
      "UPDATE team_task SET status = 'completed', time_updated = ? WHERE id = ? AND team_id = ? AND status != 'completed'",
      [now, args.task_id, teamInfo.teamId],
    )
    if (completion.changes !== 1) return { changed: false, content: task.content, unblocked: 0 }
    const completionEventId = appendTeamEvent(deps.db, {
      teamId: teamInfo.teamId,
      kind: "task.completed",
      payload: { task_id: args.task_id },
    })

    let unblocked = 0
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
      const ready = deps.db.run(
        "UPDATE team_task SET status = 'pending', time_updated = ? WHERE id = ? AND team_id = ? AND status = 'blocked'",
        [now, t.id, teamInfo.teamId],
      )
      if (ready.changes !== 1) continue
      appendTeamEvent(deps.db, {
        teamId: teamInfo.teamId,
        kind: "task.unblocked",
        payload: { task_id: t.id },
        causeEventId: completionEventId,
      })
      unblocked++
    }

    if (terminalContent && memberName) {
      sendMessage(deps.db, {
        teamId: teamInfo.teamId,
        from: memberName,
        to: "lead",
        content: terminalContent,
      })
      const reporting = deps.db.run(
        `UPDATE team_member
         SET execution_status = 'completed', reported_to_lead = 1, time_updated = ?
         WHERE team_id = ? AND name = ?`,
        [now, teamInfo.teamId, memberName],
      )
      if (reporting.changes !== 1) {
        throw new Error(`Teammate "${memberName}" not found while recording terminal result`)
      }
    } else {
      const who = memberName ?? "lead"
      sendMessage(deps.db, {
        teamId: teamInfo.teamId,
        from: "system",
        to: "lead",
        content: `Task ${args.task_id} was completed by ${who}.${unblocked > 0 ? ` ${unblocked} dependent task${unblocked === 1 ? " is" : "s are"} now ready.` : ""}`,
      })
    }
    recomputeCurrentPhase(deps.db, teamInfo.teamId, now)
    return { changed: true, content: task.content, unblocked }
  })
  if (!outcome.changed) return `Task already completed: ${outcome.content}`
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

  const unblockedMsg = outcome.unblocked > 0 ? ` Unblocked ${outcome.unblocked} dependent task${outcome.unblocked !== 1 ? "s" : ""}.` : ""
  return `Completed task: ${outcome.content}${unblockedMsg}`
}
