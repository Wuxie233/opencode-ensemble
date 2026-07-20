import type { Database } from "./db"
import type { PluginClient } from "./types"
import type { MemberRegistry } from "./state"
import type { ProgressTracker } from "./progress"
import type { ActivityBuffer } from "./activity"
import { preserveBranch, preservedBranchName } from "./tools/merge-helper"
import { sendLeadAlert, sendMessage, wakeTeamLead } from "./messaging"
import { log } from "./log"

interface WatchdogOpts {
  db: Database
  client: PluginClient
  registry: MemberRegistry
  /** Maximum time a member can stay busy before being timed out. 0 disables. */
  ttlMs: number
  /** How often to run the check. Defaults to 60s. */
  checkIntervalMs?: number
  /** Progress tracker for stall detection. */
  progressTracker?: ProgressTracker
  /** Recent session activity used to recognize tool progress. */
  activityBuffer?: ActivityBuffer
  /** Stall detection threshold in ms. 0 disables. */
  stallThresholdMs?: number
  /** Min steps before token-based stall check. */
  stallMinSteps?: number
  /** Output token threshold for stall detection. */
  stallTokenThreshold?: number
  /** Project directory for git operations. */
  cwd?: string
  /** Max peer messages per agent per window before nudge. 0 disables. */
  peerMessageLimit?: number
  /** Time window for peer message rate limiting in ms. */
  peerMessageWindowMs?: number
}

/**
 * Periodic watchdog that times out teammates stuck in busy state.
 * Transitions them to error/timed_out, aborts their session, and fires a toast.
 */
export class Watchdog {
  private readonly db: Database
  private readonly client: PluginClient
  private readonly registry: MemberRegistry
  private readonly ttlMs: number
  private readonly checkIntervalMs: number
  private readonly progressTracker?: ProgressTracker
  private readonly activityBuffer?: ActivityBuffer
  private readonly stallThresholdMs: number
  private readonly stallMinSteps: number
  private readonly stallTokenThreshold: number
  private readonly cwd?: string
  private readonly peerMessageLimit: number
  private readonly peerMessageWindowMs: number
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(opts: WatchdogOpts) {
    this.db = opts.db
    this.client = opts.client
    this.registry = opts.registry
    this.ttlMs = opts.ttlMs
    this.checkIntervalMs = opts.checkIntervalMs ?? 60_000
    this.progressTracker = opts.progressTracker
    this.activityBuffer = opts.activityBuffer
    this.stallThresholdMs = opts.stallThresholdMs ?? 0
    this.stallMinSteps = opts.stallMinSteps ?? 3
    this.stallTokenThreshold = opts.stallTokenThreshold ?? 500
    this.cwd = opts.cwd
    this.peerMessageLimit = opts.peerMessageLimit ?? 0
    this.peerMessageWindowMs = opts.peerMessageWindowMs ?? 300_000
  }

  private static STALE_THRESHOLD_MS = Number(process.env.STALE_WORKTREE_THRESHOLD_MS) || 300_000

  /** Clean up worktrees and workspaces for shutdown/error members past the stale threshold. */
  async cleanupStaleWorktrees(): Promise<void> {
    const cutoff = Date.now() - Watchdog.STALE_THRESHOLD_MS
    const stale = this.db.query(
      `SELECT tm.team_id, tm.name, tm.worktree_dir, tm.workspace_id
       FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       WHERE t.status = 'active'
         AND tm.status IN ('shutdown', 'error')
          AND tm.worktree_dir IS NOT NULL
          AND tm.time_updated < ?
          AND (? IS NULL OR t.project_id = ?)`
    ).all(cutoff, this.cwd ?? null, this.cwd ?? null) as Array<{ team_id: string; name: string; worktree_dir: string; workspace_id: string | null }>

    for (const m of stale) {
      try {
        if (m.workspace_id) {
          await this.client.workspace.remove({ id: m.workspace_id })
        }
        await this.client.worktree.remove({ worktreeRemoveInput: { directory: m.worktree_dir } })
        this.db.run(
          "UPDATE team_member SET worktree_dir = NULL, worktree_branch = NULL, workspace_id = NULL WHERE team_id = ? AND name = ?",
          [m.team_id, m.name]
        )
      } catch { /* best effort */ }
    }
  }

  /** Check for stalled busy members and escalate to lead + nudge teammate. */
  async checkStalled(): Promise<void> {
    if (!this.progressTracker || this.stallThresholdMs === 0) return

    const busy = this.db.query(
      `SELECT tm.team_id, tm.name, tm.session_id
       FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       WHERE t.status = 'active' AND tm.status = 'busy'
         AND (? IS NULL OR t.project_id = ?)`
    ).all(this.cwd ?? null, this.cwd ?? null) as Array<{ team_id: string; name: string; session_id: string }>

    for (const member of busy) {
      const toolResult = this.activityBuffer
        ?.getActivity(member.session_id)
        .findLast(entry => entry.type === "tool_result")
      if (toolResult) {
        this.progressTracker.recordActivity(member.session_id, toolResult.timestamp)
      }
      if (this.progressTracker.isReported(member.session_id)) continue

      const tokenStalled = this.progressTracker.isTokenStalled(member.session_id, this.stallMinSteps, this.stallTokenThreshold)
      const timeStalled = this.progressTracker.isTimeStalled(member.session_id, this.stallThresholdMs)

      if (!tokenStalled && !timeStalled) continue

      this.progressTracker.markReported(member.session_id)
      const reason = tokenStalled ? "low output tokens" : "no communication"

      // Nudge the teammate directly
      this.client.session.promptAsync({
        sessionID: member.session_id,
        parts: [{ type: "text", text: "[System]: You appear stalled — no progress detected. Report your current status to the lead via team_message, or wrap up your work." }],
      }).catch(() => { /* best effort */ })

      // Notify the lead
      sendLeadAlert(this.db, this.client, {
        teamId: member.team_id,
        content: `Teammate "${member.name}" appears stalled (${reason}). Consider checking on them via team_message or shutting them down.`,
        wakeText: `[System: Teammate ${member.name} appears stalled; guidance is available in team messages]`,
      })

      // Toast for the user
      try {
        await this.client.tui.showToast({
          title: "Team",
          message: `${member.name} appears stalled`,
          variant: "warning",
          duration: 5000,
        })
      } catch { /* TUI may not be available */ }
    }
  }

  /** Check for chatty agents sending too many peer messages. */
  async checkChatty(): Promise<void> {
    if (!this.progressTracker || this.peerMessageLimit === 0) return

    const busy = this.db.query(
      `SELECT tm.team_id, tm.name, tm.session_id
       FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       WHERE t.status = 'active' AND tm.status = 'busy'
         AND (? IS NULL OR t.project_id = ?)`
    ).all(this.cwd ?? null, this.cwd ?? null) as Array<{ team_id: string; name: string; session_id: string }>

    for (const member of busy) {
      if (this.progressTracker.isChattyReported(member.session_id)) continue
      if (!this.progressTracker.isChatty(member.session_id, this.peerMessageLimit, this.peerMessageWindowMs)) continue

      this.progressTracker.markChattyReported(member.session_id)

      // Nudge the agent
      this.client.session.promptAsync({
        sessionID: member.session_id,
        parts: [{ type: "text", text: "[System]: You've sent several messages to teammates. Focus on completing your task and send your results to the lead via team_message." }],
      }).catch(() => { /* best effort */ })

      // Notify the lead
      sendLeadAlert(this.db, this.client, {
        teamId: member.team_id,
        content: `Agent "${member.name}" is sending many peer messages and may be over-coordinating. Consider checking on them.`,
        wakeText: `[System: Teammate ${member.name} may be over-coordinating; guidance is available in team messages]`,
      })

      log(`watchdog:chatty member=${member.name} limit=${this.peerMessageLimit}`)
    }
  }

  /** Run a single check for stale busy members. */
  async check(): Promise<void> {
    await this.cleanupStaleWorktrees()
    await this.checkStalled()
    await this.checkChatty()
    if (this.ttlMs === 0) return

    const cutoff = Date.now() - this.ttlMs
    const stale = this.db.query(
      `SELECT tm.team_id, tm.name, tm.session_id, tm.time_updated, tm.worktree_branch,
              t.name as team_name, p.name as project_name
       FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       JOIN project p ON t.project_id = p.id
       WHERE t.status = 'active'
          AND tm.status = 'busy'
          AND tm.time_updated < ?
          AND (? IS NULL OR t.project_id = ?)`
    ).all(cutoff, this.cwd ?? null, this.cwd ?? null) as Array<{
      team_id: string
      name: string
      session_id: string
      time_updated: number
      worktree_branch: string | null
      team_name: string
      project_name: string
    }>

    for (const member of stale) {
      const hasRecentActivity = () => this.activityBuffer
        ?.getActivity(member.session_id)
        .some(entry => entry.timestamp >= cutoff) ?? false
      if (hasRecentActivity()) continue

      // Preserve branch BEFORE abort — session.abort() may destroy the worktree + branch
      if (this.cwd && member.worktree_branch) {
        const safeBranch = preservedBranchName(member.project_name, member.team_name, member.team_id, member.name)
        const ok = await preserveBranch(member.worktree_branch, safeBranch, this.cwd)
        if (!ok) {
          sendLeadAlert(this.db, this.client, {
            teamId: member.team_id,
            content: `Teammate "${member.name}" exceeded its timeout, but branch "${member.worktree_branch}" could not be preserved. The member and its task were left unchanged for a later retry.`,
            wakeText: `[System: Watchdog could not preserve ${member.name}'s branch; guidance is available in team messages]`,
          })
          continue
        }
        this.db.run("UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND name = ?",
          [safeBranch, member.team_id, member.name])
        log(`watchdog:branch:preserved src=${member.worktree_branch} target=${safeBranch}`)
      }

      // Claim the terminal transition so concurrent error/cleanup paths cannot
      // abort or alert for the same member twice.
      if (hasRecentActivity()) continue
      const claimed = this.db.transaction(() => {
        const result = this.db.run(
          "UPDATE team_member SET status = 'error', execution_status = 'timed_out', time_updated = ? WHERE team_id = ? AND name = ? AND status = 'busy'",
          [Date.now(), member.team_id, member.name]
        )
        if (result.changes !== 1) return false
        this.db.run(
          `UPDATE team_task SET status = 'pending', assignee = NULL, time_updated = ?
           WHERE team_id = ? AND assignee = ? AND status = 'in_progress'`,
          [Date.now(), member.team_id, member.name],
        )
        sendMessage(this.db, {
          teamId: member.team_id,
          from: "system",
          to: "lead",
          content: `Teammate "${member.name}" (${member.session_id}) timed out and was stopped. Inspect its session and preserved branch, then replace it with team_spawn using resume_from: "${member.name}" if needed.`,
        })
        return true
      })()
      if (!claimed) continue

      wakeTeamLead(
        this.db,
        this.client,
        member.team_id,
        `[System: Teammate ${member.name} timed out; recovery guidance is available in team messages]`,
      )

      // Abort session (best effort)
      try {
        await this.client.session.abort({ sessionID: member.session_id })
      } catch { /* best effort */ }

      // Notify
      try {
        await this.client.tui.showToast({
          title: "Team",
          message: `${member.name} timed out`,
          variant: "warning",
          duration: 5000,
        })
      } catch { /* TUI may not be available */ }
    }
  }

  /** Start the periodic check. Runs stale worktree GC regardless of TTL setting. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.check(), this.checkIntervalMs)
  }

  /** Stop the periodic check. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** Whether the watchdog is currently running. */
  isRunning(): boolean {
    return this.timer !== undefined
  }
}
