import type { ToolDeps } from "./types"
import { sendLeadAlert } from "./messaging"
import { log } from "./log"
import {
  getTeamResourceParts,
  preserveBranch,
  preservedBranchName,
  resolveWorktreeBranch,
  type PreserveBranchFn,
  type ResolveWorktreeBranchFn,
} from "./tools/merge-helper"
import { resolveAbortBranch, type AbortBranchResolution } from "./abort-preservation"
import { appendTeamEventBestEffort } from "./team-event"

const activeReaborts = new Map<string, Promise<boolean>>()

/** Re-aborts late runner activity without reactivating terminal teammates. */
export class TerminalLivenessGuard {
  constructor(
    private readonly deps: ToolDeps,
    private readonly preserve: PreserveBranchFn = preserveBranch,
    private readonly resolveBranch: ResolveWorktreeBranchFn = resolveWorktreeBranch,
  ) {}

  /** Return true when a terminal teammate owns the observed session. */
  async handle(sessionId: string, status: "busy" | "retry"): Promise<boolean> {
    const member = this.deps.db.query(
      `SELECT tm.team_id, tm.name, tm.status, tm.execution_status, tm.worktree_branch, tm.worktree_dir
       FROM team_member tm
       JOIN team t ON t.id = tm.team_id
       WHERE tm.session_id = ? AND t.status = 'active'
         AND (tm.status IN ('shutdown', 'error')
           OR tm.execution_status IN ('cancelled', 'completed', 'failed', 'timed_out'))`,
    ).get(sessionId) as {
      team_id: string
      name: string
      status: string
      execution_status: string
      worktree_branch: string | null
      worktree_dir: string | null
    } | null
    if (!member) return false
    appendTeamEventBestEffort(this.deps.db, {
      teamId: member.team_id,
      kind: "recovery.stage",
      payload: { member_name: member.name, mechanism: "late_terminal", stage: "detected" },
    })
    const current = activeReaborts.get(sessionId)
    if (current) return current

    const aborting = this.reabort(sessionId, status, member)
    activeReaborts.set(sessionId, aborting)
    try {
      return await aborting
    } finally {
      if (activeReaborts.get(sessionId) === aborting) activeReaborts.delete(sessionId)
    }
  }

  private async reabort(
    sessionId: string,
    status: "busy" | "retry",
    member: {
      team_id: string
      name: string
      status: string
      execution_status: string
      worktree_branch: string | null
      worktree_dir: string | null
    },
  ): Promise<boolean> {
    let resolution: AbortBranchResolution
    try {
      resolution = await resolveAbortBranch(member.worktree_branch, member.worktree_dir, this.resolveBranch)
    } catch {
      this.alertPreservationFailure(member, status, "its live source branch could not be resolved")
      return true
    }
    if (!resolution.ok) {
      this.alertPreservationFailure(member, status, resolution.reason)
      return true
    }
    const sourceBranch = resolution.sourceBranch
    if (sourceBranch) {
      const resource = getTeamResourceParts(this.deps.db, member.team_id)
      const safeBranch = preservedBranchName(resource.projectName, resource.teamName, resource.teamId, member.name)
      if (!await this.preserve(sourceBranch, safeBranch, this.deps.directory)) {
        this.alertPreservationFailure(member, status, `branch ${sourceBranch} could not be preserved`)
        return true
      }
      const recorded = this.deps.db.run(
        `UPDATE team_member SET worktree_branch = ?
         WHERE team_id = ? AND name = ? AND session_id = ?
           AND (status IN ('shutdown', 'error')
             OR execution_status IN ('cancelled', 'completed', 'failed', 'timed_out'))`,
        [safeBranch, member.team_id, member.name, sessionId],
      )
      if (recorded.changes !== 1) return true
    }
    try {
      await this.deps.client.session.abort({ sessionID: sessionId })
      appendTeamEventBestEffort(this.deps.db, {
        teamId: member.team_id,
        kind: "recovery.stage",
        payload: { member_name: member.name, mechanism: "late_terminal", stage: "reaborted" },
      })
      log(`terminal-liveness:reaborted member=${member.name} status=${status}`)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      sendLeadAlert(this.deps.db, this.deps.client, {
        teamId: member.team_id,
        content: `Terminal teammate "${member.name}" emitted a late ${status} event and could not be re-aborted (${detail}). Its ${member.status}/${member.execution_status} state was retained; a later event will retry termination.`,
        wakeText: `[System: Terminal teammate ${member.name} resumed unexpectedly; retry guidance is available in team messages]`,
      })
    }
    return true
  }

  private alertPreservationFailure(
    member: { team_id: string; name: string; status: string; execution_status: string },
    status: "busy" | "retry",
    reason: string,
  ): void {
    sendLeadAlert(this.deps.db, this.deps.client, {
      teamId: member.team_id,
      content: `Terminal teammate "${member.name}" emitted a late ${status} event, but ${reason}. No re-abort was attempted; its ${member.status}/${member.execution_status} state and branch reference were retained for a later retry.`,
      wakeText: `[System: Terminal teammate ${member.name} resumed but branch preservation blocked re-abort; guidance is available in team messages]`,
    })
  }
}
