import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"
import { sendMessage, markDelivered, hasReportedCompletion } from "../messaging"
import { log } from "../log"

/**
 * Execute the team_broadcast tool. Sends a message to all team members + lead (excluding sender).
 */
export async function executeTeamBroadcast(
  deps: ToolDeps,
  args: { text: string },
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)

  const senderName = teamInfo.role === "lead" ? "lead" : (teamInfo.memberName ?? "unknown")

  // Collect all recipient session IDs (excluding sender)
  const recipients: Array<{ name: string; sessionId: string }> = []

  // Add lead if sender is not lead
  if (teamInfo.role !== "lead") {
    const leadSession = deps.db.query("SELECT lead_session_id FROM team WHERE id = ?")
      .get(teamInfo.teamId) as { lead_session_id: string } | null
    if (leadSession) recipients.push({ name: "lead", sessionId: leadSession.lead_session_id })
  }

  // Add all members except sender
  const members = deps.registry.listByTeam(teamInfo.teamId)
  for (const member of members) {
    if (member.sessionId !== sessionId) {
      recipients.push({ name: member.memberName, sessionId: member.sessionId })
    }
  }

  // Persist and deliver independently per recipient so one successful transport
  // cannot hide another recipient's failed delivery.
  let skipped = 0
  for (const recipient of recipients) {
    if (recipient.name !== "lead" && hasReportedCompletion(deps.db, teamInfo.teamId, recipient.name)) {
      skipped++
      continue
    }
    const msgId = sendMessage(deps.db, {
      teamId: teamInfo.teamId,
      from: senderName,
      to: recipient.name,
      content: args.text,
    })
    const text = recipient.name === "lead"
      ? `[System: New team broadcast from ${senderName}]`
      : `[Team broadcast from ${senderName}]: ${args.text}`
    deps.client.session.promptAsync({
      sessionID: recipient.sessionId,
      parts: [{ type: "text", text }],
    }).then(() => {
      if (recipient.name !== "lead") markDelivered(deps.db, msgId)
    }).catch((err) => {
      log(`team_broadcast:deliver:failed to=${recipient.name} err=${err instanceof Error ? err.message : String(err)}`)
    })
  }

  const sent = recipients.length - skipped
  return `Broadcast sent to ${sent} recipient${sent !== 1 ? "s" : ""}.`
}
