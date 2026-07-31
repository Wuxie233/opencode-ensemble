import type { ToolDeps } from "../types"
import { resolveRecipientSession } from "../types"
import { requireTeamMember } from "./shared"
import { sendMessage, markDelivered, hasReportedCompletion, isMemberPromptEligible } from "../messaging"
import { log } from "../log"
import { immediateTransaction } from "../db"
import { appendTeamEvent } from "../team-event"

function isPlanSubmission(content: string): boolean {
  const match = content.match(
    /^\s*<plan-submission>\s*<summary>([\s\S]*?)<\/summary>\s*<details>([\s\S]*?)<\/details>\s*<\/plan-submission>\s*$/,
  )
  return Boolean(match?.[1]?.trim() && match[2]?.trim())
}

/**
 * Execute the team_message tool. Sends a direct message to a teammate or lead.
 * Optionally approves or rejects a teammate's plan (lead only).
 */
export async function executeTeamMessage(
  deps: ToolDeps,
  args: { to: string; text: string; approve?: boolean; reject?: string },
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)

  const senderName = teamInfo.role === "lead" ? "lead" : (teamInfo.memberName ?? "unknown")

  const recipientSessionId = resolveRecipientSession(deps.db, deps.registry, teamInfo.teamId, args.to)

  // If recipient not found, store the message for later delivery (they may not be spawned yet)
  // Reject approve/reject flags for unspawned recipients — plan approval requires the member to exist
  if (!recipientSessionId && args.to !== "lead") {
    if (args.approve || args.reject) {
      throw new Error(`Cannot approve/reject plan for "${args.to}" — they haven't been spawned yet.`)
    }
    sendMessage(deps.db, {
      teamId: teamInfo.teamId,
      from: senderName,
      to: args.to,
      content: args.text,
    })
    log(`team_message:queued from=${senderName} to=${args.to} (recipient not yet spawned)`)
    return `Message queued for ${args.to} — they haven't been spawned yet. It will be delivered when they join the team.`
  }
  if (!recipientSessionId) throw new Error(`Recipient "${args.to}" not found in team "${teamInfo.teamName}"`)

  let messageText = args.text
  let msgId: string
  let shouldDeliver = true
  if (args.approve || args.reject) {
    if (args.approve && args.reject) {
      throw new Error("Cannot both approve and reject a plan.")
    }
    if (teamInfo.role !== "lead") {
      throw new Error("Only the lead can approve or reject plans.")
    }
    messageText = args.approve
      ? `[Plan Approved] ${args.text}`
      : `[Plan Rejected: ${args.reject}] ${args.text}`
    const decision = immediateTransaction(deps.db, () => {
      const planApproval = args.approve ? "approved" : "rejected"
      const updated = deps.db.run(
        `UPDATE team_member
         SET plan_approval = ?, reported_to_lead = 0, time_updated = ?
         WHERE team_id = ? AND name = ? AND plan_approval = 'pending'`,
        [planApproval, Date.now(), teamInfo.teamId, args.to],
      )
      if (updated.changes === 1) {
        appendTeamEvent(deps.db, {
          teamId: teamInfo.teamId,
          kind: args.approve ? "plan.approved" : "plan.rejected",
          payload: { member_name: args.to },
        })
        return {
          messageId: sendMessage(deps.db, {
            teamId: teamInfo.teamId,
            from: senderName,
            to: args.to,
            content: messageText,
          }),
          shouldDeliver: true,
        }
      }
      const existing = deps.db.query(
        `SELECT tm.plan_approval, msg.id
         FROM team_member tm
         LEFT JOIN team_message msg
           ON msg.team_id = tm.team_id
          AND msg.from_name = ?
          AND msg.to_name = tm.name
          AND msg.content = ?
         WHERE tm.team_id = ? AND tm.name = ?
         ORDER BY msg.time_created ASC, msg.id ASC
         LIMIT 1`,
      ).get(senderName, messageText, teamInfo.teamId, args.to) as { plan_approval: string; id: string | null } | null
      if (existing?.plan_approval === planApproval && existing.id) {
        return { messageId: existing.id, shouldDeliver: false }
      }
      throw new Error(`Recipient "${args.to}" is not in plan approval mode (plan_approval is not pending).`)
    })
    msgId = decision.messageId
    shouldDeliver = decision.shouldDeliver
  } else if (args.to === "lead" && teamInfo.role === "member" && isPlanSubmission(messageText)) {
    const submission = immediateTransaction(deps.db, () => {
      const member = deps.db.query(
        "SELECT plan_approval FROM team_member WHERE team_id = ? AND name = ?",
      ).get(teamInfo.teamId, senderName) as { plan_approval: string } | null

      if (member?.plan_approval === "rejected") {
        const updated = deps.db.run(
          `UPDATE team_member
           SET plan_approval = 'pending', reported_to_lead = 0, time_updated = ?
           WHERE team_id = ? AND name = ? AND plan_approval = 'rejected'`,
          [Date.now(), teamInfo.teamId, senderName],
        )
        if (updated.changes !== 1) {
          throw new Error(`Plan submission race for teammate "${senderName}".`)
        }
        return {
          messageId: sendMessage(deps.db, {
            teamId: teamInfo.teamId,
            from: senderName,
            to: args.to,
            content: messageText,
          }),
          shouldDeliver: true,
        }
      }

      if (member?.plan_approval === "pending") {
        const existing = deps.db.query(
          `SELECT id FROM team_message
           WHERE team_id = ? AND from_name = ? AND to_name = 'lead' AND content = ?
           ORDER BY time_created DESC, id DESC
           LIMIT 1`,
        ).get(teamInfo.teamId, senderName, messageText) as { id: string } | null
        if (existing) return { messageId: existing.id, shouldDeliver: false }
      }

      return {
        messageId: sendMessage(deps.db, {
          teamId: teamInfo.teamId,
          from: senderName,
          to: args.to,
          content: messageText,
        }),
        shouldDeliver: true,
      }
    })
    msgId = submission.messageId
    shouldDeliver = submission.shouldDeliver
  } else {
    msgId = sendMessage(deps.db, {
      teamId: teamInfo.teamId,
      from: senderName,
      to: args.to,
      content: messageText,
    })
  }

  if (!shouldDeliver) return `Message sent to ${args.to}.`

  const isToLead = args.to === "lead"

  // Lead-bound messages: store in DB, then wake the lead with a minimal promptAsync.
  // The system prompt transform delivers the actual message content on the lead's next turn.
  // This runs in the teammate's worktree instance — the event hook can't wake the lead
  // because session.idle events are scoped per-instance.
  if (isToLead) {
    log(`team_message:wake-lead from=${senderName} recipientSession=${recipientSessionId}`)
    deps.client.session.promptAsync({
      sessionID: recipientSessionId,
      parts: [{ type: "text", text: `[System: New team message from ${senderName}]` }],
    }).catch((err) => {
      log(`team_message:wake-lead:failed from=${senderName} err=${err instanceof Error ? err.message : String(err)}`)
    })
    return `Message sent to ${args.to}.`
  }

  // Guard: skip promptAsync delivery to teammates who have already reported completion (issue #3)
  if (hasReportedCompletion(deps.db, teamInfo.teamId, args.to)) {
    return `Message stored for ${args.to} (teammate has completed their task — message will not wake them).`
  }
  if (!isMemberPromptEligible(deps.db, teamInfo.teamId, args.to)) {
    return `Message stored for ${args.to} (their current lifecycle state does not allow a wake-up).`
  }

  // For member-to-member messages, fire-and-forget delivery is safe.
  const deliveryText = `[Team message from ${senderName}]: ${messageText}`
  deps.client.session.promptAsync({
    sessionID: recipientSessionId,
    parts: [{ type: "text", text: deliveryText }],
  }).then(() => {
    markDelivered(deps.db, msgId)
  }).catch((err) => {
    log(`team_message:deliver:failed to=${args.to} err=${err instanceof Error ? err.message : String(err)}`)
  })

  return `Message sent to ${args.to}.`
}
