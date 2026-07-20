import type { Database } from "./db"
import type { PluginClient } from "./types"
import type { MemberRegistry } from "./state"
import {
  claimPeerMessageDelivery,
  getUndeliveredMessages,
  markDelivered,
  hasReportedCompletion,
  MESSAGE_DELIVERY_LEASE_MS,
  restoreFailedPeerMessageDelivery,
  sendLeadAlert,
  sendMessage,
  wakeTeamLead,
} from "./messaging"
import { preserveBranch, preservedBranchName, resolveWorktreeBranch, teamResourceSegment } from "./tools/merge-helper"
import { log } from "./log"
import { runCommand } from "./process"

/**
 * Scan for team members stuck in 'busy' status (stale from a crash)
 * Preserves worktree branches, aborts orphaned sessions, and only then marks
 * them as 'error' with execution_status 'idle'.
 * Only processes members in active teams.
 * Returns the count of interrupted members.
 */
export async function recoverStaleMembers(db: Database, client?: PluginClient, cwd?: string): Promise<{ interrupted: number }> {
  // Find stale members with branch info so we can preserve before aborting
  const stale = db.query(
    `SELECT tm.session_id, tm.worktree_branch, tm.worktree_dir, tm.name, tm.team_id,
            t.name as team_name, p.name as project_name
      FROM team_member tm
      JOIN team t ON tm.team_id = t.id
      JOIN project p ON t.project_id = p.id
      WHERE tm.status = 'busy'
        AND tm.execution_status IN ('idle', 'starting', 'running', 'cancel_requested')
        AND t.status = 'active'
        AND (? IS NULL OR t.project_id = ? OR t.project_id = 'default')`
  ).all(cwd ?? null, cwd ?? null) as Array<{ session_id: string; worktree_branch: string | null; worktree_dir: string | null; name: string; team_id: string; team_name: string; project_name: string }>

  let liveSessions: Record<string, { type: string }> = {}
  if (client) {
    try {
      liveSessions = (await client.session.status()).data ?? {}
    } catch {
      log("recovery:status:failed; skipping destructive stale-member recovery")
      return { interrupted: 0 }
    }
  }

  if (!client) return { interrupted: 0 }

  // Preserve branches then abort orphaned sessions
  let interrupted = 0
  for (const member of stale) {
    if (liveSessions[member.session_id]) continue
    // Preserve branch BEFORE abort — session.abort() may destroy the worktree + branch
    let preservedBranch: string | null = null
    let sourceBranch = member.worktree_branch
    if (sourceBranch?.startsWith("ensemble/preserved/") && member.worktree_dir) {
      sourceBranch = await resolveWorktreeBranch(member.worktree_dir)
      if (!sourceBranch || sourceBranch.startsWith("ensemble/preserved/")) {
        sendLeadAlert(db, client, {
          teamId: member.team_id,
          content: `Startup recovery found orphaned teammate "${member.name}", but its live branch could not be resolved from worktree ${member.worktree_dir}. No abort was attempted; inspect the worktree and retry.`,
          wakeText: `[System: Startup recovery could not resolve ${member.name}'s live worktree branch; guidance is available in team messages]`,
        })
        continue
      }
    }
    if (cwd && sourceBranch && !sourceBranch.startsWith("ensemble/preserved/")) {
      const safeBranch = preservedBranchName(member.project_name, member.team_name, member.team_id, member.name)
      const ok = await preserveBranch(sourceBranch, safeBranch, cwd)
      if (!ok) {
        sendLeadAlert(db, client, {
          teamId: member.team_id,
          content: `Teammate "${member.name}" appears orphaned, but branch "${sourceBranch}" could not be preserved. Startup recovery left the member and its task unchanged for a later retry.`,
          wakeText: `[System: Startup recovery could not preserve ${member.name}'s branch; guidance is available in team messages]`,
        })
        continue
      }
      preservedBranch = safeBranch
      log(`recovery:branch:preserved src=${sourceBranch} target=${safeBranch}`)
    }

    const claimed = db.run(
      `UPDATE team_member SET execution_status = 'cancelling', time_updated = ?
       WHERE team_id = ? AND name = ? AND status = 'busy'
         AND execution_status IN ('idle', 'starting', 'running', 'cancel_requested')`,
      [Date.now(), member.team_id, member.name],
    ).changes === 1
    if (!claimed) continue

    try {
      await client.session.abort({ sessionID: member.session_id })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      db.run(
        `UPDATE team_member SET status = 'busy', execution_status = 'cancel_requested', time_updated = ?
         WHERE team_id = ? AND name = ?
           AND (
             (status = 'busy' AND execution_status = 'cancelling')
             OR (status = 'ready' AND execution_status = 'idle' AND reported_to_lead = 0
               AND EXISTS (
                 SELECT 1 FROM team_task
                 WHERE team_id = ? AND assignee = ? AND status = 'in_progress'
               ))
           )`,
        [Date.now(), member.team_id, member.name, member.team_id, member.name],
      )
      sendLeadAlert(db, client, {
        teamId: member.team_id,
        content: `Startup recovery found orphaned teammate "${member.name}", but the session could not abort. The member and its in-progress task remain owned and retryable; retry startup recovery or use team_shutdown with force: true. Error: ${message}.`,
        wakeText: `[System: Startup recovery could not abort ${member.name}; retry guidance is available in team messages]`,
      })
      continue
    }

    if (preservedBranch) {
      db.run(
        "UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND name = ?",
        [preservedBranch, member.team_id, member.name],
      )
    }

    const transitioned = db.transaction(() => {
      const result = db.run(
        `UPDATE team_member SET status = 'error', execution_status = 'idle', time_updated = ?
         WHERE team_id = ? AND name = ?
           AND (status = 'ready' OR (status = 'busy' AND execution_status = 'cancelling'))`,
        [Date.now(), member.team_id, member.name],
      )
      if (result.changes !== 1) return false
      db.run(
        `UPDATE team_task SET status = 'pending', assignee = NULL, time_updated = ?
         WHERE team_id = ? AND assignee = ? AND status = 'in_progress'`,
        [Date.now(), member.team_id, member.name],
      )
      sendMessage(db, {
        teamId: member.team_id,
        from: "system",
        to: "lead",
        content: `Teammate "${member.name}" (${member.session_id}) was interrupted by startup recovery. Inspect its session and preserved branch, then replace it with team_spawn using resume_from: "${member.name}" if the task still needs work.`,
      })
      return true
    })()
    if (!transitioned) continue
    interrupted++

    wakeTeamLead(
      db,
      client,
      member.team_id,
      `[System: Teammate ${member.name} was interrupted during startup recovery; guidance is available in team messages]`,
    )
  }

  return { interrupted }
}

/**
 * Clean up orphaned worktrees from archived teams or members that no longer exist.
 * Compares worktrees on disk (via client.worktree.list) against active team members.
 */
export async function recoverOrphanedWorktrees(db: Database, client: PluginClient): Promise<{ removed: number }> {
  let removed = 0

  try {
    const worktrees = await client.worktree.list()
    if (!worktrees.data) return { removed: 0 }

    // Get all active worktree directories from the DB
    const activeWorktrees = new Set(
      (db.query(
        `SELECT tm.worktree_dir FROM team_member tm
         JOIN team t ON tm.team_id = t.id
         WHERE tm.worktree_dir IS NOT NULL AND t.status = 'active'`
      ).all() as Array<{ worktree_dir: string }>).map(r => r.worktree_dir)
    )

    for (const wt of worktrees.data) {
      // Only clean up worktrees created by ensemble (name starts with "ensemble-")
      if (!wt.name.startsWith("ensemble-")) continue
      if (activeWorktrees.has(wt.directory)) continue

      try {
        await client.worktree.remove({ worktreeRemoveInput: { directory: wt.directory } })
        removed++
      } catch { /* best effort */ }
    }
  } catch {
    // worktree.list may not be available — silently ignore
  }

  return { removed }
}

/**
 * Redeliver undelivered messages (delivered=0) via promptAsync.
 * Resolves recipient session IDs from the member registry or team lead.
 * Dispatches without awaiting transport completion and restores failed claims for retry.
 */
export async function recoverUndeliveredMessages(
  db: Database,
  client: PluginClient,
  registry: MemberRegistry,
): Promise<{ redelivered: number }> {
  // Get all active teams
  const teams = db.query("SELECT id, lead_session_id FROM team WHERE status = 'active'")
    .all() as Array<{ id: string; lead_session_id: string }>

  let redelivered = 0

  for (const team of teams) {
    const messages = getUndeliveredMessages(db, team.id)

    for (const msg of messages) {
      // Resolve recipient session ID
      let recipientSessionId: string | undefined

      if (msg.to_name === "lead") {
        // Skip lead-bound messages — the system prompt transform delivers them
        continue
      } else if (msg.to_name) {
        const entry = registry.getByName(team.id, msg.to_name)
        recipientSessionId = entry?.sessionId
      } else {
        // Broadcast — skip for now, broadcasts are best-effort
        continue
      }

      if (!recipientSessionId) continue

      // Skip delivery to teammates who have already reported completion (issue #3)
      if (hasReportedCompletion(db, team.id, msg.to_name!)) {
        markDelivered(db, msg.id)
        continue
      }

      if (!claimPeerMessageDelivery(db, msg.id, Date.now() - MESSAGE_DELIVERY_LEASE_MS)) continue

      client.session.promptAsync({
        sessionID: recipientSessionId,
        parts: [{ type: "text", text: `[Recovered team message from ${msg.from_name}]: ${msg.content}` }],
      }).then(() => {
        markDelivered(db, msg.id)
      }).catch((err) => {
        restoreFailedPeerMessageDelivery(db, msg.id, recipientSessionId, false)
        log(`recovery:message:failed message=${msg.id} err=${err instanceof Error ? err.message : String(err)}`)
      })
      redelivered++
    }
  }

  return { redelivered }
}

/**
 * Repopulate the in-memory MemberRegistry from SQLite for all active members.
 * MUST be called on every plugin init — the registry is in-memory only,
 * and without rehydration, every team_* tool call from an existing
 * teammate fails with "This session is not in a team." after a plugin restart.
 *
 * Skips members in terminal states (shutdown, error) — they should not
 * receive future messages.
 *
 * Returns the number of members rehydrated.
 */
export function rehydrateRegistry(db: Database, registry: MemberRegistry): number {
  const members = db.query(
    `SELECT tm.team_id, tm.name, tm.session_id
     FROM team_member tm
     JOIN team t ON tm.team_id = t.id
     WHERE t.status = 'active' AND tm.status NOT IN ('shutdown', 'error')`
  ).all() as Array<{ team_id: string; name: string; session_id: string }>
  for (const m of members) {
    registry.register(m.team_id, m.name, m.session_id)
  }
  return members.length
}

/**
 * Clean up orphaned ensemble/preserved/* branches that belong to archived teams
 * with no active members. Scoped carefully to avoid interfering with other
 * running OpenCode sessions that may have active teams.
 */
export async function recoverOrphanedBranches(db: Database, cwd: string): Promise<{ removed: number }> {
  let removed = 0

  // Get archived team namespaces for this project that have NO active members.
  // The team id namespace is current; team names are kept for legacy preserved branches.
  const archivedTeams = db.query(
    `SELECT t.id, t.name, p.name as project_name FROM team t
     JOIN project p ON t.project_id = p.id
     WHERE t.status = 'archived'
      AND t.project_id = ?
     AND NOT EXISTS (
        SELECT 1 FROM team_member tm
        WHERE tm.team_id = t.id AND tm.status NOT IN ('shutdown', 'error')
      )`
  ).all(cwd) as Array<{ id: string; name: string; project_name: string }>

  if (archivedTeams.length === 0) return { removed: 0 }

  const archivedPrefixes = archivedTeams.flatMap(t => [
    `ensemble/preserved/${t.project_name}/${teamResourceSegment(t.name, t.id)}/`,
    `ensemble/preserved/${t.name}/`,
  ])

  // List all local branches matching ensemble/preserved/*
  const result = await runCommand(["git", "branch", "--list", "ensemble/preserved/*"], { cwd })

  const branches = result.stdout.split("\n").map(b => b.trim().replace(/^\* /, "")).filter(Boolean)

  for (const branch of branches) {
    if (!archivedPrefixes.some(prefix => branch.startsWith(prefix))) continue

    try {
      const deleteResult = await runCommand(["git", "branch", "-D", branch], { cwd })
      if (deleteResult.exitCode === 0) {
        removed++
        log(`recovery:branch:deleted branch=${branch}`)
      }
    } catch { /* best effort */ }
  }

  return { removed }
}
