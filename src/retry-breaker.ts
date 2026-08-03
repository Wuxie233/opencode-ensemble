import type { ToolDeps } from "./types"
import type { RetryExhaustion, RetryFallback } from "./hooks"
import type { RetryTracker } from "./hooks"
import { resolveFallbackModel } from "./config"
import { getTeamResourceParts, preserveBranch, preservedBranchName, resolveWorktreeBranch } from "./tools/merge-helper"
import type { PreserveBranchFn, ResolveWorktreeBranchFn } from "./tools/merge-helper"
import { sendLeadAlert, sendMessage, wakeTeamLead } from "./messaging"
import { log } from "./log"
import { resolveAbortBranch } from "./abort-preservation"
import { recomputeCurrentPhase } from "./task-phase"
import { appendTeamEvent } from "./team-event"
import { appendMemberTransition, releaseMemberTasks } from "./telemetry"

const activeTerminations = new Map<string, Promise<RetryExhaustion | undefined>>()
const MAX_RECOVERY_ERROR_BYTES = 2 * 1024
const MAX_RECOVERY_MODEL_BYTES = 256

interface RetryRecoveryMetadata {
  kind: "provider_retry_exhausted"
  member: string
  provider: string | null
  model: string | null
  attempts: number
  error: string
  fallback_model: string | null
  action: {
    tool: "team_spawn"
    resume_from: string
    inspect_actual_state: true
    automatic_replay: false
    mutate_active_session_model: false
  }
}

/** Observe a retry status and synchronously finish any required breaker attempt. */
export async function handleRetryStatus(
  deps: ToolDeps,
  tracker: RetryTracker,
  sessionId: string,
  status: "idle" | "busy" | "retry",
  message?: string,
  attempt?: number,
  terminate: (deps: ToolDeps, request: RetryExhaustion) => Promise<boolean> = breakRetryLoop,
): Promise<RetryExhaustion | undefined> {
  const existing = activeTerminations.get(sessionId)
  if (existing) return existing
  const action = tracker.observeStatus(
    deps.db,
    deps.registry,
    sessionId,
    status,
    message,
    attempt,
  )
  if (!action) return
  const exhaustion = action.kind === "fallback" ? claimFallbackHandoff(deps, action) : action
  if (!exhaustion) return
  const termination = terminate(deps, exhaustion).then(() => exhaustion)
  activeTerminations.set(sessionId, termination)
  try {
    return await termination
  } finally {
    if (activeTerminations.get(sessionId) === termination) activeTerminations.delete(sessionId)
  }
}

/** Stop a teammate whose provider retry sequence has been exhausted. */
export async function breakRetryLoop(
  deps: ToolDeps,
  request: RetryExhaustion,
  preserve: PreserveBranchFn = preserveBranch,
  resolveBranch: ResolveWorktreeBranchFn = resolveWorktreeBranch,
): Promise<boolean> {
  const member = deps.db.query(
    `SELECT worktree_branch, worktree_dir, model FROM team_member
     WHERE team_id = ? AND name = ? AND session_id = ?`,
  ).get(request.teamId, request.memberName, request.sessionId) as {
    worktree_branch: string | null
    worktree_dir: string | null
    model: string | null
  } | null
  if (!member) return false

  const pending = deps.db.query(
    `SELECT 1 AS found FROM team_member
     WHERE team_id = ? AND name = ? AND session_id = ? AND retry_tripped = 1
       AND status = 'shutdown_requested' AND execution_status = 'cancelling'`,
  ).get(request.teamId, request.memberName, request.sessionId)
  const claimed = !!pending || deps.db.run(
    `UPDATE team_member SET status = 'shutdown_requested', execution_status = 'cancelling', time_updated = ?
     WHERE team_id = ? AND name = ? AND session_id = ? AND retry_tripped = 1
       AND status IN ('ready', 'busy')
       AND execution_status IN ('idle', 'starting', 'running', 'cancel_requested')`,
    [Date.now(), request.teamId, request.memberName, request.sessionId],
  ).changes === 1
  if (!claimed) return false

  let preservedBranch: string | null = null
  try {
    const resolution = await resolveAbortBranch(member.worktree_branch, member.worktree_dir, resolveBranch)
    if (!resolution.ok) {
      restoreRetryOwnership(deps, request)
      sendLeadAlert(deps.db, deps.client, {
        teamId: request.teamId,
        content: `Teammate "${request.memberName}" exhausted ${request.attempts} consecutive retries, but ${resolution.reason}. No abort was attempted; the member and task remain owned.`,
        wakeText: `[System: Retry breaker could not resolve ${request.memberName}'s live branch; guidance is available in team messages]`,
      })
      return false
    }
    const sourceBranch = resolution.sourceBranch
    if (sourceBranch) {
      const resource = getTeamResourceParts(deps.db, request.teamId)
      const safeBranch = preservedBranchName(resource.projectName, resource.teamName, resource.teamId, request.memberName)
      if (!await preserve(sourceBranch, safeBranch, deps.directory)) {
        restoreRetryOwnership(deps, request)
        sendLeadAlert(deps.db, deps.client, {
          teamId: request.teamId,
          content: `Teammate "${request.memberName}" exhausted ${request.attempts} consecutive retries, but branch ${sourceBranch} could not be preserved. No abort was attempted; the member and task remain owned.`,
          wakeText: `[System: Retry breaker could not preserve ${request.memberName}'s branch; guidance is available in team messages]`,
        })
        return false
      }
      preservedBranch = safeBranch
      const recorded = deps.db.run(
        `UPDATE team_member SET worktree_branch = ?, time_updated = ?
         WHERE team_id = ? AND name = ? AND session_id = ?
           AND status = 'shutdown_requested' AND execution_status = 'cancelling' AND retry_tripped = 1`,
        [safeBranch, Date.now(), request.teamId, request.memberName, request.sessionId],
      )
      if (recorded.changes !== 1) return false
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    restoreRetryOwnership(deps, request)
    try {
      sendLeadAlert(deps.db, deps.client, {
        teamId: request.teamId,
        content: `Teammate "${request.memberName}" exhausted ${request.attempts} consecutive retries, but retry termination preparation failed (${detail}). No abort was attempted; the member and task remain owned.`,
        wakeText: `[System: Retry breaker preparation failed for ${request.memberName}; guidance is available in team messages]`,
      })
    } catch {
      log(`retry-breaker:prepare-alert:failed member=${request.memberName}`)
    }
    return false
  }

  try {
    await deps.client.session.abort({ sessionID: request.sessionId })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    sendLeadAlert(deps.db, deps.client, {
      teamId: request.teamId,
      content: `Teammate "${request.memberName}" exhausted ${request.attempts} consecutive retries, but its session could not be aborted (${detail}). The member and in-progress task remain owned; retry force shutdown before replacing it.`,
      wakeText: `[System: Retry breaker could not abort ${request.memberName}; recovery guidance is available in team messages]`,
    })
    return false
  }

  let transitioned = false
  try {
    const taskRows = deps.db.query(
      "SELECT id FROM team_task WHERE team_id = ? AND assignee = ? AND status = 'in_progress' ORDER BY time_created, id",
    ).all(request.teamId, request.memberName) as Array<{ id: string }>
    transitioned = deps.db.transaction(() => {
      const now = Date.now()
      const result = deps.db.run(
        `UPDATE team_member SET status = 'error', execution_status = 'failed',
            worktree_branch = COALESCE(?, worktree_branch), time_updated = ?
         WHERE team_id = ? AND name = ? AND session_id = ?
            AND status = 'shutdown_requested' AND execution_status = 'cancelling'`,
        [preservedBranch, now, request.teamId, request.memberName, request.sessionId],
      )
      if (result.changes !== 1) return false
      appendMemberTransition(deps.db, request.teamId, request.memberName, "shutdown_requested", "error", "cancelling", "failed", "retry_exhausted")
      const releasedTasks = releaseMemberTasks(deps.db, request.teamId, request.memberName, "retry_exhausted", now)
      recomputeCurrentPhase(deps.db, request.teamId, now)
      const taskNotice = releasedTasks > 0
        ? ` Released task${releasedTasks === 1 ? "" : "s"}: ${taskRows.map(task => task.id).join(", ")}.`
        : ""
      const recoveryGuidance = request.fallbackModel
        ? ` Start a fresh teammate with team_spawn, resume_from: "${request.memberName}", and model: "${request.fallbackModel}"; have it inspect actual state before continuing so completed tool side effects are not replayed.`
        : ` Start a fresh teammate with team_spawn and resume_from: "${request.memberName}"; have it inspect actual state before continuing so completed tool side effects are not replayed.`
      const recoveryMetadata = buildRetryRecoveryMetadata(member.model, request)
      sendMessage(deps.db, {
        teamId: request.teamId,
        from: "system",
        to: "lead",
        content: `Teammate "${request.memberName}" (${request.sessionId}) was stopped after ${request.attempts} consecutive retries.${taskNotice}${recoveryGuidance}\n\nRecovery metadata:\n${JSON.stringify(recoveryMetadata)}`,
      })
      return true
    })()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    try {
      sendLeadAlert(deps.db, deps.client, {
        teamId: request.teamId,
        content: `Teammate "${request.memberName}" was aborted after exhausting retries, but terminal state persistence failed (${detail}). Its task remains owned until team_shutdown or startup recovery safely settles the durable cancelling claim. Do not start a replacement yet.`,
        wakeText: `[System: Retry breaker persistence failed for ${request.memberName}; recovery guidance is available in team messages]`,
      })
    } catch {
      log(`retry-breaker:persist-alert:failed member=${request.memberName}`)
    }
    return false
  }
  if (!transitioned) return false

  deps.registry.unregister(request.sessionId)
  wakeTeamLead(
    deps.db,
    deps.client,
    request.teamId,
    `[System: Teammate ${request.memberName} was stopped after exhausting retries; recovery guidance is available in team messages]`,
  )
  log(`retry-breaker:stopped member=${request.memberName} session=${request.sessionId} attempts=${request.attempts}`)
  return true
}

function claimFallbackHandoff(deps: ToolDeps, request: RetryFallback): RetryExhaustion | undefined {
  const member = deps.db.query(
    `SELECT agent, model, retry_fallback_models FROM team_member
     WHERE team_id = ? AND name = ? AND session_id = ?
       AND retry_tripped = 0 AND retry_fallback_used = 0
       AND status IN ('ready', 'busy')`,
  ).get(request.teamId, request.memberName, request.sessionId) as {
    agent: string
    model: string | null
    retry_fallback_models: string | null
  } | null
  if (!member) return

  const tried = parseFallbackModels(member.retry_fallback_models)
  const fallbackModel = resolveFallbackModel(member.agent, member.model, deps.config, tried)
  if (!fallbackModel) {
    deps.db.run(
      `UPDATE team_member SET retry_fallback_used = 1, time_updated = ?
       WHERE team_id = ? AND name = ? AND session_id = ?
         AND retry_tripped = 0 AND retry_fallback_used = 0`,
      [Date.now(), request.teamId, request.memberName, request.sessionId],
    )
    return
  }

  const changed = deps.db.transaction(() => {
    const updated = deps.db.run(
      `UPDATE team_member SET retry_fallback_used = 1, retry_fallback_models = ?,
          retry_tripped = 1, time_updated = ?
       WHERE team_id = ? AND name = ? AND session_id = ?
         AND retry_tripped = 0 AND retry_fallback_used = 0
         AND status IN ('ready', 'busy')`,
      [JSON.stringify([...tried, fallbackModel]), Date.now(), request.teamId, request.memberName, request.sessionId],
    )
    if (updated.changes !== 1) return false
    appendTeamEvent(deps.db, {
      teamId: request.teamId,
      kind: "retry.fallback",
      payload: { member_name: request.memberName, attempt: request.attempts },
    })
    return true
  })()
  if (!changed) return

  return { ...request, kind: "exhaustion", fallbackModel }
}

function parseFallbackModels(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

function buildRetryRecoveryMetadata(model: string | null, request: RetryExhaustion): RetryRecoveryMetadata {
  const boundedModel = model ? truncateUtf8(model, MAX_RECOVERY_MODEL_BYTES) : null
  const provider = boundedModel?.includes("/") ? boundedModel.slice(0, boundedModel.indexOf("/")) : null
  return {
    kind: "provider_retry_exhausted",
    member: request.memberName,
    provider,
    model: boundedModel,
    attempts: request.attempts,
    error: truncateUtf8(request.reason, MAX_RECOVERY_ERROR_BYTES),
    fallback_model: request.fallbackModel
      ? truncateUtf8(request.fallbackModel, MAX_RECOVERY_MODEL_BYTES)
      : null,
    action: {
      tool: "team_spawn",
      resume_from: request.memberName,
      inspect_actual_state: true,
      automatic_replay: false,
      mutate_active_session_model: false,
    },
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(value)
  if (bytes.length <= maxBytes) return value
  const suffix = "..."
  const limit = maxBytes - encoder.encode(suffix).length
  const decoder = new TextDecoder("utf-8", { fatal: true })
  for (let end = limit; end > 0; end--) {
    try {
      return `${decoder.decode(bytes.slice(0, end))}${suffix}`
    } catch {
      // Continue to the previous complete UTF-8 boundary.
    }
  }
  return suffix
}

function restoreRetryOwnership(deps: ToolDeps, request: RetryExhaustion): void {
  deps.db.run(
    `UPDATE team_member SET time_updated = ?
     WHERE team_id = ? AND name = ? AND session_id = ?
       AND status = 'shutdown_requested' AND execution_status = 'cancelling' AND retry_tripped = 1`,
    [Date.now(), request.teamId, request.memberName, request.sessionId],
  )
}
