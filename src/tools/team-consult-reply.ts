import type { ToolDeps } from "../types"
import { immediateTransaction } from "../db"
import { sendMessage, wakeTeamLead } from "../messaging"
import { requireTeamMember } from "./shared"
import { log } from "../log"
import { appendTeamEvent } from "../team-event"

export interface TeamConsultReplyArgs {
  consult_id: string
  reply: string
  escalate_to_lead?: boolean
}

/** Resolve or escalate a pending technical consultation. */
export async function executeTeamConsultReply(
  deps: ToolDeps,
  args: TeamConsultReplyArgs,
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)
  if (teamInfo.role !== "member" || !teamInfo.memberName) {
    throw new Error("Only a Planner teammate can reply to a consultation")
  }
  if (!args.reply.trim()) throw new Error("Consultation reply must not be empty")
  const planner = teamInfo.memberName
  const outcome = immediateTransaction(deps.db, () => {
    const requester = deps.db.query(
      `SELECT name, session_id, consult_task_id, consult_question, consult_state
       FROM team_member
       WHERE team_id = ? AND consult_id = ? AND consult_state IN ('waiting', 'escalated') AND consult_planner = ?`,
    ).get(teamInfo.teamId, args.consult_id, planner) as {
      name: string
      session_id: string
      consult_task_id: string
      consult_question: string
      consult_state: "waiting" | "escalated"
    } | null
    if (!requester) {
      throw new Error(`Pending consultation "${args.consult_id}" assigned to ${planner} was not found`)
    }
    if (args.escalate_to_lead && requester.consult_state !== "waiting") {
      throw new Error(`Consultation "${args.consult_id}" was already escalated to the Lead`)
    }
    const state = args.escalate_to_lead ? "escalated" : "answered"
    const updated = deps.db.run(
      `UPDATE team_member SET consult_state = ?, consult_reply = ?, time_updated = ?
       WHERE team_id = ? AND name = ? AND consult_id = ? AND consult_state = ?`,
      [state, args.reply.trim(), Date.now(), teamInfo.teamId, requester.name, args.consult_id, requester.consult_state],
    )
    if (updated.changes !== 1) throw new Error(`Consultation "${args.consult_id}" was already resolved`)
    appendTeamEvent(deps.db, {
      teamId: teamInfo.teamId,
      kind: args.escalate_to_lead ? "consultation.escalated" : "consultation.resolved",
      payload: {
        consultation_id: args.consult_id,
        task_id: requester.consult_task_id,
        requester: requester.name,
        planner,
      },
    })
    const content = [
      `<team-consult-reply id="${args.consult_id}" task_id="${requester.consult_task_id}" from="${planner}" state="${state}">`,
      args.reply.trim(),
      "</team-consult-reply>",
    ].join("\n")
    sendMessage(deps.db, {
      teamId: teamInfo.teamId,
      from: planner,
      to: args.escalate_to_lead ? "lead" : requester.name,
      content,
    })
    return { requester, content, state }
  })
  if (args.escalate_to_lead) {
    wakeTeamLead(
      deps.db,
      deps.client,
      teamInfo.teamId,
      `[System: Planner ${planner} escalated consultation ${args.consult_id}; a business decision may be required]`,
    )
    return `Consultation ${args.consult_id} escalated to the Lead; the requester remains waiting.`
  }
  deps.client.session.promptAsync({
    sessionID: outcome.requester.session_id,
    parts: [{ type: "text", text: `[Technical consultation resolved by ${planner}]: ${outcome.content}` }],
  }).catch(error => {
    log(`team-consult-reply:wake:failed consult=${args.consult_id} err=${error instanceof Error ? error.message : String(error)}`)
  })
  return `Consultation ${args.consult_id} resolved; ${outcome.requester.name} may resume task ${outcome.requester.consult_task_id}.`
}
