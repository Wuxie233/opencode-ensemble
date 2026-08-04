import { resolveAbortBranch } from "../abort-preservation"
import { log } from "../log"
import { sendLeadAlert } from "../messaging"
import { recomputeCurrentPhase } from "../task-phase"
import type { ToolDeps } from "../types"
import type { PreserveBranchFn, ResolveWorktreeBranchFn } from "./merge-helper"
import { getTeamResourceParts, preserveBranch, preservedBranchName, resolveWorktreeBranch } from "./merge-helper"
import type { CommitCountFn, IsDirtyFn } from "./shared"
import { checkWorktreeDirty, countBranchCommits, requireLead } from "./shared"
import { appendMemberTransition, releaseMemberTasks } from "../telemetry"
import { getMemberRepositoryBinding } from "../repository-binding"

const TERMINAL_EXECUTION_STATUSES = new Set(["completed", "cancelled", "failed", "timed_out"])

/**
 * Execute the team_shutdown tool. Requests a teammate to shut down.
 *
 * Before aborting, preserves the worktree branch to a safe ref so
 * session.abort() cannot destroy the agent's committed work.
 */
export async function executeTeamShutdown(
  deps: ToolDeps,
  args: { member: string; force?: boolean },
  sessionId: string,
  isDirty: IsDirtyFn = checkWorktreeDirty,
  preserve: PreserveBranchFn = preserveBranch,
  commitCount: CommitCountFn = countBranchCommits,
  resolveBranch: ResolveWorktreeBranchFn = resolveWorktreeBranch,
): Promise<string> {
  const teamInfo = requireLead(deps, sessionId)

  const member = deps.db.query(
    `SELECT session_id, status, execution_status, worktree_branch, worktree_dir,
            worktree_source_branch, worktree_baseline_oid
     FROM team_member WHERE team_id = ? AND name = ?`,
  ).get(teamInfo.teamId, args.member) as {
    session_id: string
    status: string
    execution_status: string
    worktree_branch: string | null
    worktree_dir: string | null
    worktree_source_branch: string | null
    worktree_baseline_oid: string | null
  } | null
  if (!member) throw new Error(`Teammate "${args.member}" not found in team "${teamInfo.teamName}"`)
  if (member.status === "shutdown") return `Teammate "${args.member}" is already shut down. No action was needed.`
  if (member.status === "error") {
    const hasImmutableWriterEvidence = member.worktree_baseline_oid !== null
      && member.worktree_source_branch !== null
    if (hasImmutableWriterEvidence) {
      return `Teammate "${args.member}" is already terminal (status: error). No abort was attempted. Use team_merge for evidence-based writer settlement; it will verify the persisted Git identity, baseline, and surviving branch or worktree before recording any no-op or merge.`
    }
    const hasIncompleteWriterEvidence = member.worktree_branch !== null
      || member.worktree_dir !== null
      || member.worktree_source_branch !== null
      || member.worktree_baseline_oid !== null
    if (hasIncompleteWriterEvidence) {
      return `Teammate "${args.member}" is already terminal (status: error). No abort was attempted, but its writer evidence is incomplete, so it cannot be classified as read-only or no-op. Recover immutable Git identity, baseline, and branch or worktree evidence before settlement.`
    }
    return `Teammate "${args.member}" is already terminal (status: error) with no immutable writer evidence. No abort or writer merge is needed.`
  }

  const force = args.force ?? false
  const repositoryRoot = getMemberRepositoryBinding(deps.db, teamInfo.teamId, args.member).repositoryRoot

  // Second call on an already-requested member → force abort
  if (member.status === "shutdown_requested") {
    await preserveAndAbort(deps, teamInfo.teamId, args.member, member.session_id, member.worktree_branch, member.worktree_dir, preserve, resolveBranch)
    const status = await getBranchStatus(deps, teamInfo.teamId, args.member, member.worktree_dir, isDirty, commitCount)
    return `Force shut down "${args.member}".${status}`
  }

  // A terminal result is already authoritative. Do not wake the teammate into
  // another turn even if OpenCode still reports its session as busy.
  if (TERMINAL_EXECUTION_STATUSES.has(member.execution_status)) {
    await preserveAndAbort(deps, teamInfo.teamId, args.member, member.session_id, member.worktree_branch, member.worktree_dir, preserve, resolveBranch)
    const status = await getBranchStatus(deps, teamInfo.teamId, args.member, member.worktree_dir, isDirty, commitCount)
    return `Teammate "${args.member}" has been shut down.${status}`
  }

  // Determine if member is idle or busy
  let isIdle = false
  try {
    const statuses = await deps.client.session.status()
    const sessionStatus = statuses.data?.[member.session_id]
    isIdle = !sessionStatus || sessionStatus.type === "idle"
  } catch {
    // Status poll failed — assume busy, fall through to graceful path
  }

  if (isIdle || force) {
    await preserveAndAbort(deps, teamInfo.teamId, args.member, member.session_id, member.worktree_branch, member.worktree_dir, preserve, resolveBranch)
    const status = await getBranchStatus(deps, teamInfo.teamId, args.member, member.worktree_dir, isDirty, commitCount)
    return `Teammate "${args.member}" has been shut down.${status}`
  }

  // Busy + not force → graceful: preserve branch first, then send shutdown message
  // Branch must be preserved NOW — if the session crashes during shutdown_requested,
  // the worktree and branch could be lost before force-abort ever runs.
  const resolution = await resolveAbortBranch(member.worktree_branch, member.worktree_dir, resolveBranch)
  if (!resolution.ok) {
    sendLeadAlert(deps.db, deps.client, {
      teamId: teamInfo.teamId,
      content: `Shutdown for "${args.member}" was not requested because ${resolution.reason}. The session remains running; inspect the worktree and retry.`,
      wakeText: `[System: Shutdown for ${args.member} was blocked because its live branch could not be verified; guidance is available in team messages]`,
    })
    throw new Error(`Cannot request shutdown for "${args.member}": ${resolution.reason}. The session was left running so you can retry.`)
  }
  if (resolution.sourceBranch) {
    const resource = getTeamResourceParts(deps.db, teamInfo.teamId)
    const safeBranch = preservedBranchName(resource.projectName, resource.teamName, resource.teamId, args.member)
    const ok = await preserve(resolution.sourceBranch, safeBranch, repositoryRoot)
    if (!ok) {
      sendLeadAlert(deps.db, deps.client, {
        teamId: teamInfo.teamId,
        content: `Shutdown for "${args.member}" was not requested because branch ${resolution.sourceBranch} could not be preserved. The session remains running; resolve the branch and retry.`,
        wakeText: `[System: Shutdown for ${args.member} was blocked by branch preservation failure; guidance is available in team messages]`,
      })
      throw new Error(`Cannot request shutdown for "${args.member}": failed to preserve branch ${resolution.sourceBranch}. The session was left running so you can retry.`)
    }
    // Keep the original branch in the DB while the teammate finishes. A later
    // force abort must refresh the preserved ref with commits made after this snapshot.
    log(`shutdown:branch:preserved-graceful src=${resolution.sourceBranch} target=${safeBranch}`)
  }

  const requested = deps.db.transaction(() => {
    const result = deps.db.run(
      `UPDATE team_member SET status = 'shutdown_requested', time_updated = ?
       WHERE team_id = ? AND name = ? AND status IN ('ready', 'busy')`,
      [Date.now(), teamInfo.teamId, args.member],
    )
    if (result.changes === 1) {
      appendMemberTransition(deps.db, teamInfo.teamId, args.member, member.status as "ready" | "busy", "shutdown_requested", member.execution_status as "idle" | "starting" | "running" | "cancel_requested", member.execution_status as "idle" | "starting" | "running" | "cancel_requested", "shutdown")
    }
    return result
  })()
  if (requested.changes !== 1) {
    throw new Error(`Cannot request shutdown for "${args.member}": the member state changed. Retry with current state.`)
  }

  try {
    deps.client.session.promptAsync({
      sessionID: member.session_id,
      parts: [{
        type: "text",
        text: `[Shutdown requested]: Finish the work that is already in progress, send your final findings to the lead via team_message, then end your current turn. The Team controller will settle and stop this session after it becomes idle.`,
      }],
    }).catch(() => { /* fire-and-forget */ })
  } catch {
    // promptAsync failed — the durable shutdown request remains recoverable.
  }

  return `Shutdown requested for ${args.member}. They will finish current work and shut down. Call team_shutdown with force: true to abort immediately.`
}

/** Re-abort a session that became busy after graceful shutdown was requested. */
export async function abortShutdownRequestedMember(
  deps: ToolDeps,
  teamId: string,
  memberName: string,
  sessionId: string,
  worktreeBranch: string | null,
  worktreeDir: string | null,
  preserve: PreserveBranchFn = preserveBranch,
  resolveBranch: ResolveWorktreeBranchFn = resolveWorktreeBranch,
): Promise<boolean> {
  const repositoryRoot = getMemberRepositoryBinding(deps.db, teamId, memberName).repositoryRoot
  const sourceBranch = await resolvePreservationSource(
    deps,
    teamId,
    memberName,
    worktreeBranch,
    worktreeDir,
    resolveBranch,
  )
  if (sourceBranch) {
    const resource = getTeamResourceParts(deps.db, teamId)
    const safeBranch = preservedBranchName(resource.projectName, resource.teamName, resource.teamId, memberName)
    const ok = await preserve(sourceBranch, safeBranch, repositoryRoot)
    if (!ok) {
      log(`busy_while_shutdown:branch:preserve-failed src=${sourceBranch} target=${safeBranch}`)
      sendLeadAlert(deps.db, deps.client, {
        teamId,
        content: `Re-abort for "${memberName}" was blocked because branch ${sourceBranch} could not be preserved. No abort was attempted; resolve the branch and retry shutdown.`,
        wakeText: `[System: Re-abort for ${memberName} was blocked by branch preservation failure; guidance is available in team messages]`,
      })
      return false
    }
    const recorded = deps.db.run(
      `UPDATE team_member SET worktree_branch = ?, time_updated = ?
       WHERE team_id = ? AND name = ? AND status = 'shutdown_requested'`,
      [safeBranch, Date.now(), teamId, memberName],
    )
    if (recorded.changes !== 1) return false
    log(`busy_while_shutdown:branch:preserved src=${sourceBranch} target=${safeBranch}`)
  }

  try {
    await deps.client.session.abort({ sessionID: sessionId })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    log(`busy_while_shutdown:abort-failed member=${memberName} err=${detail}`)
    sendLeadAlert(deps.db, deps.client, {
      teamId,
      content: `Teammate "${memberName}" became busy after shutdown was requested but could not be aborted (${detail}). The member remains shutdown_requested; retry shutdown.`,
      wakeText: `[System: Re-abort for ${memberName} failed; guidance is available in team messages]`,
    })
    return false
  }
  settleShutdown(deps, teamId, memberName)
  return true
}

/**
 * Preserve the worktree branch, then abort the session and mark shutdown.
 * The branch is copied to ensemble/preserved/{team_id}/{name} BEFORE abort,
 * so session.abort() cannot destroy the agent's committed work.
 */
async function preserveAndAbort(
  deps: ToolDeps,
  teamId: string,
  memberName: string,
  sessionId: string,
  worktreeBranch: string | null,
  worktreeDir: string | null,
  preserve: PreserveBranchFn,
  resolveBranch: ResolveWorktreeBranchFn,
): Promise<void> {
  const repositoryRoot = getMemberRepositoryBinding(deps.db, teamId, memberName).repositoryRoot
  const sourceBranch = await resolvePreservationSource(
    deps,
    teamId,
    memberName,
    worktreeBranch,
    worktreeDir,
    resolveBranch,
  )
  let preservedBranch: string | null = null
  // Preserve the branch BEFORE aborting — session.abort() may delete the worktree + branch
  if (sourceBranch) {
    const resource = getTeamResourceParts(deps.db, teamId)
    const safeBranch = preservedBranchName(resource.projectName, resource.teamName, resource.teamId, memberName)
    const ok = await preserve(sourceBranch, safeBranch, repositoryRoot)
    if (ok) {
      preservedBranch = safeBranch
      log(`shutdown:branch:preserved src=${sourceBranch} target=${safeBranch}`)
    } else {
      log(`shutdown:branch:preserve-failed src=${sourceBranch} target=${safeBranch}`)
      sendLeadAlert(deps.db, deps.client, {
        teamId,
        content: `Shutdown for "${memberName}" was blocked because branch ${sourceBranch} could not be preserved. No abort was attempted; resolve the branch and retry.`,
        wakeText: `[System: Shutdown for ${memberName} was blocked by branch preservation failure; guidance is available in team messages]`,
      })
      throw new Error(`Cannot shut down "${memberName}": failed to preserve branch ${sourceBranch}. The session was left running so you can retry.`)
    }
  }

  // Record shutdown intent only after preservation succeeds, but before abort
  // can emit MessageAbortedError.
  const recorded = deps.db.run(
    `UPDATE team_member SET status = 'shutdown_requested', worktree_branch = COALESCE(?, worktree_branch), time_updated = ?
     WHERE team_id = ? AND name = ? AND status != 'shutdown'`,
    [preservedBranch, Date.now(), teamId, memberName],
  )
  if (recorded.changes !== 1) {
    throw new Error(`Cannot shut down "${memberName}": the member state changed before abort. Retry with current state.`)
  }

  // Now safe to abort — the branch is preserved
  try {
    await deps.client.session.abort({ sessionID: sessionId })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    log(`shutdown:abort-failed member=${memberName} err=${detail}`)
    sendLeadAlert(deps.db, deps.client, {
      teamId,
      content: `Teammate "${memberName}" could not be aborted (${detail}). The member remains shutdown_requested; retry shutdown.`,
      wakeText: `[System: Shutdown abort for ${memberName} failed; guidance is available in team messages]`,
    })
    throw new Error(`Cannot shut down "${memberName}": failed to abort the session. The member remains shutdown_requested so you can retry.`)
  }

  settleShutdown(deps, teamId, memberName)
}

function settleShutdown(deps: ToolDeps, teamId: string, memberName: string): void {
  deps.db.transaction(() => {
    const now = Date.now()
    const previous = deps.db.query(
      "SELECT execution_status FROM team_member WHERE team_id = ? AND name = ? AND status = 'shutdown_requested'",
    ).get(teamId, memberName) as { execution_status: "idle" | "starting" | "running" | "cancel_requested" | "cancelling" | "cancelled" | "completing" | "completed" | "failed" | "timed_out" } | null
    const transitioned = deps.db.run(
      `UPDATE team_member
       SET status = 'shutdown',
           execution_status = CASE
             WHEN execution_status IN ('completed', 'cancelled', 'failed', 'timed_out') THEN execution_status
             ELSE 'idle'
           END,
           time_updated = ?
       WHERE team_id = ? AND name = ? AND status = 'shutdown_requested'`,
      [now, teamId, memberName],
    )
    if (transitioned.changes !== 1) return
    const nextExecution = previous && TERMINAL_EXECUTION_STATUSES.has(previous.execution_status) ? previous.execution_status : "idle"
    appendMemberTransition(deps.db, teamId, memberName, "shutdown_requested", "shutdown", previous?.execution_status ?? "idle", nextExecution as "idle" | "cancelled" | "completed" | "failed" | "timed_out", "shutdown")
    releaseMemberTasks(deps.db, teamId, memberName, "shutdown", now)
    recomputeCurrentPhase(deps.db, teamId, now)
  })()
}

async function resolvePreservationSource(
  deps: ToolDeps,
  teamId: string,
  memberName: string,
  worktreeBranch: string | null,
  worktreeDir: string | null,
  resolveBranch: ResolveWorktreeBranchFn,
): Promise<string | null> {
  const resolution = await resolveAbortBranch(worktreeBranch, worktreeDir, resolveBranch)
  if (resolution.ok) return resolution.sourceBranch
  sendLeadAlert(deps.db, deps.client, {
    teamId,
    content: `Shutdown for "${memberName}" was blocked because ${resolution.reason}. No abort was attempted; inspect the worktree and retry.`,
    wakeText: `[System: Shutdown for ${memberName} could not resolve its live worktree branch; guidance is available in team messages]`,
  })
  throw new Error(`Cannot shut down "${memberName}": ${resolution.reason}. The session was left running so you can retry.`)
}

/** Build a status line describing the teammate's work: commit count, dirty state, next step. */
async function getBranchStatus(
  deps: ToolDeps,
  teamId: string,
  memberName: string,
  worktreeDir: string | null,
  isDirty: IsDirtyFn,
  commitCount: CommitCountFn,
): Promise<string> {
  const row = deps.db.query("SELECT worktree_branch FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamId, memberName) as { worktree_branch: string | null } | null
  if (!row?.worktree_branch) return ""

  const branch = row.worktree_branch
  const repositoryRoot = getMemberRepositoryBinding(deps.db, teamId, memberName).repositoryRoot
  const parts: string[] = []

  const commits = await commitCount(branch, repositoryRoot)
  // Best-effort dirty check — worktree may already be deleted by session.abort() race
  const dirty = worktreeDir ? await isDirty(worktreeDir).catch(() => false) : false

  if (commits > 0 && dirty) {
    parts.push(`${memberName} committed ${commits} change${commits !== 1 ? "s" : ""} and has uncommitted work.`)
  } else if (commits > 0) {
    parts.push(`${memberName} committed ${commits} change${commits !== 1 ? "s" : ""}. Ready to merge.`)
  } else if (dirty) {
    parts.push(`${memberName} has uncommitted changes only — their work may be incomplete.`)
  } else if (commits < 0) {
    parts.push(`Could not determine ${memberName}'s commit status. Merge to check their work.`)
  } else {
    parts.push(`${memberName} made no changes.`)
  }

  parts.push(`Branch: ${branch}`)
  parts.push("Use team_merge to merge their work.")
  return `\n${parts.join("\n")}`
}
