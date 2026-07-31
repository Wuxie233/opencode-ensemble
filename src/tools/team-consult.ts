import type { ToolDeps } from "../types"
import { immediateTransaction } from "../db"
import { isMemberPromptEligible, sendMessage } from "../messaging"
import { generateId } from "../util"
import { requireTeamMember } from "./shared"
import { log } from "../log"

export interface TeamConsultArgs {
  task_id: string
  question: string
  planner?: string
}

/** Ask a Planner to resolve a technical contract while the requesting member waits. */
export async function executeTeamConsult(
  deps: ToolDeps,
  args: TeamConsultArgs,
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)
  if (teamInfo.role !== "member" || !teamInfo.memberName) {
    throw new Error("Only a teammate can wait on a Planner consultation")
  }
  if (!args.question.trim()) throw new Error("Consultation question must not be empty")
  const requester = teamInfo.memberName
  const planner = args.planner
    ? deps.db.query(
        "SELECT name, session_id, status, execution_status, profile FROM team_member WHERE team_id = ? AND name = ?",
      ).get(teamInfo.teamId, args.planner)
    : deps.db.query(
        `SELECT name, session_id, status, execution_status, profile FROM team_member
         WHERE team_id = ? AND profile = 'planner' AND status IN ('ready', 'busy')
         ORDER BY time_created ASC LIMIT 1`,
      ).get(teamInfo.teamId)
  const selected = planner as {
    name: string
    session_id: string
    status: string
    execution_status: string
    profile: string
  } | null
  if (!selected || selected.profile !== "planner") {
    throw new Error(args.planner ? `Planner "${args.planner}" is not available` : "No active Planner is available")
  }
  if (!isMemberPromptEligible(deps.db, teamInfo.teamId, selected.name)) {
    throw new Error(`Planner "${selected.name}" cannot receive a consultation in its current lifecycle state`)
  }
  const consultId = generateId("consult")
  const message = [
    `<team-consult id="${consultId}" task_id="${args.task_id}" from="${requester}">`,
    args.question.trim(),
    "</team-consult>",
  ].join("\n")
  immediateTransaction(deps.db, () => {
    const task = deps.db.query("SELECT status, assignee FROM team_task WHERE id = ? AND team_id = ?")
      .get(args.task_id, teamInfo.teamId) as { status: string; assignee: string | null } | null
    if (!task) throw new Error(`Task "${args.task_id}" not found`)
    if (task.assignee !== requester) {
      throw new Error(`Task "${args.task_id}" is owned by ${task.assignee ?? "nobody"}, not ${requester}`)
    }
    if (task.status !== "in_progress") {
      throw new Error(`Task "${args.task_id}" is not in progress`)
    }
    const waiting = deps.db.run(
      `UPDATE team_member
       SET consult_id = ?, consult_state = 'waiting', consult_task_id = ?, consult_planner = ?,
           consult_question = ?, consult_reply = NULL, time_updated = ?
       WHERE team_id = ? AND name = ? AND consult_state IN ('none', 'answered')`,
      [consultId, args.task_id, selected.name, args.question.trim(), Date.now(), teamInfo.teamId, requester],
    )
    if (waiting.changes !== 1) {
      throw new Error(`Teammate "${requester}" already has a pending consultation`)
    }
    sendMessage(deps.db, {
      teamId: teamInfo.teamId,
      from: requester,
      to: selected.name,
      content: message,
    })
  })
  deps.client.session.promptAsync({
    sessionID: selected.session_id,
    parts: [{ type: "text", text: `[Technical consultation from ${requester}]: ${message}` }],
  }).catch(error => {
    log(`team-consult:wake:failed consult=${consultId} err=${error instanceof Error ? error.message : String(error)}`)
  })
  return `Consultation ${consultId} sent to ${selected.name}; task ${args.task_id} is waiting for a technical reply.`
}
