import path from "node:path"
import type { ToolDeps, PermissionRule } from "../types"
import { validateMemberName } from "../util"
import { requireLead } from "./shared"
import { sendLeadAlert } from "../messaging"
import { log } from "../log"
import type { EnsembleConfig } from "../config"
import { getTeamResourceParts, matchesCreatedWorktreeName, normalizeWorktreeName, preserveBranch, preservedBranchName, teamWorktreeName } from "./merge-helper"
import type { PreserveBranchFn } from "./merge-helper"
import { recomputeCurrentPhase } from "../task-phase"
import { appendTeamEvent } from "../team-event"
import { immediateTransaction } from "../db"
import { resolveProfile } from "../profiles"
import { getTeamRepositoryBinding, recoverTeamRepositoryBinding, repositoryBindingOps } from "../repository-binding"
import { parseTaskResult } from "../result-parser"
import { renderError } from "../error"

/** Tracks consecutive spawn failures per team for circuit breaker. */
export const spawnFailures = new Map<string, { count: number; lastError: string }>()
const spawnsInFlight = new Set<string>()
/** Maximum UTF-8 bytes copied from a predecessor session into a replacement prompt. */
export const RESUME_CONTEXT_BYTE_LIMIT = 32 * 1024
const RESUME_SAFETY_INSTRUCTION = "Inspect actual repository, task, and runtime state before continuing. Do not replay tool side effects merely because they appear in the predecessor transcript."

interface SpawnArgs {
  name: string
  profile?: string
  agent?: string
  prompt: string
  model?: string
  claim_task?: string
  repository_root?: string
  worktree?: boolean
  plan_approval?: boolean
  resume_from?: string
}

interface ResumeContext {
  predecessor: string
  text: string
  truncated: boolean
}

interface ClaimedTask {
  claimEventId: string
  contractArtifactId: string | null
  contractArtifactSha256: string | null
}

interface SpawnRepository {
  repositoryRoot: string
  gitIdentity: string
}

interface SpawnWorktree {
  directory: string
  branch: string
  sourceBranch: string
  baselineOid: string
}

/** Parse "provider/model" string into { providerID, modelID } for the SDK. */
function parseModelId(model: string): { providerID: string; modelID: string } | undefined {
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) return undefined
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
}

/**
 * Resolve which model to use for a spawned agent.
 * Priority: explicit arg > modelsByAgent > rotation/random > defaultModel > undefined.
 */
export function resolveModel(
  explicitModel: string | undefined,
  agentType: string,
  teamMemberCount: number,
  config: Required<EnsembleConfig>,
): string | undefined {
  if (explicitModel) return explicitModel
  if (config.modelsByAgent[agentType]) return config.modelsByAgent[agentType]
  if (config.modelAssignment === "rotate" && config.modelPool.length > 0) {
    return config.modelPool[teamMemberCount % config.modelPool.length]
  }
  if (config.modelAssignment === "random" && config.modelPool.length > 0) {
    return config.modelPool[Math.floor(Math.random() * config.modelPool.length)]
  }
  if (config.defaultModel) return config.defaultModel
  return undefined
}

/** Timeout for worktree.create and session.create to prevent hanging on git lock contention. */
function getSpawnTimeout(): number {
  return Number(process.env.SPAWN_TIMEOUT_MS) || 120_000
}

/** Returns true if the directory is already inside an OpenCode worktree. */
function isWorktreeDirectory(dir: string): boolean {
  return dir.includes("/opencode/worktree/")
}

/** Race a promise against a timeout. Throws if the timeout fires first. Cleans up timer on resolution. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    }),
  ])
}

function claimSpawnTask(deps: ToolDeps, teamId: string, taskId: string, assignee: string): ClaimedTask {
  return deps.db.transaction(() => {
    const task = deps.db.query(
      "SELECT status, assignee, contract_artifact_id, contract_artifact_sha256 FROM team_task WHERE id = ? AND team_id = ?",
    ).get(taskId, teamId) as {
      status: string
      assignee: string | null
      contract_artifact_id: string | null
      contract_artifact_sha256: string | null
    } | null
    if (!task) throw new Error(`Task "${taskId}" not found`)
    if (task.status === "blocked") throw new Error(`Task "${taskId}" is waiting for unresolved dependencies`)
    if (task.status !== "pending") throw new Error(`Task "${taskId}" is not pending (status: ${task.status})`)
    if (task.assignee) throw new Error(`Task "${taskId}" is already claimed by ${task.assignee}`)

    const now = Date.now()
    const result = deps.db.run(
      "UPDATE team_task SET status = 'in_progress', assignee = ?, time_updated = ? WHERE id = ? AND team_id = ? AND status = 'pending' AND assignee IS NULL",
      [assignee, now, taskId, teamId],
    )
    if (result.changes === 0) {
      throw new Error(`Task "${taskId}" is already claimed (race condition)`)
    }
    const claimEventId = appendTeamEvent(deps.db, {
      teamId,
      kind: "task.claimed",
      payload: { task_id: taskId, assignee },
    })
    recomputeCurrentPhase(deps.db, teamId, now)
    return {
      claimEventId,
      contractArtifactId: task.contract_artifact_id,
      contractArtifactSha256: task.contract_artifact_sha256,
    }
  })()
}

function rollbackSpawnTask(
  deps: ToolDeps,
  teamId: string,
  taskId: string | undefined,
  assignee: string,
  claimEventId: string | undefined,
): void {
  if (!taskId) return
  if (!claimEventId) throw new Error(`Task "${taskId}" rollback is missing its claim event`)
  deps.db.transaction(() => rollbackSpawnTaskMutation(deps, teamId, taskId, assignee, claimEventId))()
}

function rollbackSpawnTaskMutation(
  deps: ToolDeps,
  teamId: string,
  taskId: string,
  assignee: string,
  claimEventId: string,
): void {
  const now = Date.now()
  const result = deps.db.run(
    "UPDATE team_task SET status = 'pending', assignee = NULL, time_updated = ? WHERE id = ? AND team_id = ? AND status = 'in_progress' AND assignee = ?",
    [now, taskId, teamId, assignee],
  )
  if (result.changes === 1) {
    appendTeamEvent(deps.db, {
      teamId,
      kind: "task.released",
      payload: { task_id: taskId, reason: "spawn_rollback" },
      causeEventId: claimEventId,
    })
    recomputeCurrentPhase(deps.db, teamId, now)
    return
  }
  const task = deps.db.query(
    "SELECT status, assignee FROM team_task WHERE id = ? AND team_id = ?",
  ).get(taskId, teamId) as { status: string; assignee: string | null } | null
  if (task?.status === "in_progress" && task.assignee === assignee) {
    throw new Error(`Task "${taskId}" is still owned by ${assignee} after rollback`)
  }
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
}

function isSpawnTimeout(detail: string): boolean {
  return detail.includes(" timed out after ")
}

async function resolveSpawnRepository(
  deps: ToolDeps,
  teamInfo: ReturnType<typeof requireLead>,
  explicitRoot: string | undefined,
  isReadOnly: boolean,
): Promise<SpawnRepository> {
  const team = getTeamRepositoryBinding(deps.db, teamInfo.teamId)
  if (explicitRoot && isReadOnly) {
    throw new Error("repository_root is only supported for isolated writer profiles")
  }
  if (!explicitRoot) {
    if (!team.gitIdentity && !isReadOnly) {
      const repositoryOps = deps.repositoryBindingOps ?? repositoryBindingOps
      try {
        const recovered = await recoverTeamRepositoryBinding(deps.db, teamInfo.teamId, repositoryOps)
        if (!recovered.gitIdentity) throw new Error("verified repository did not produce a Git identity")
        return { repositoryRoot: recovered.repositoryRoot, gitIdentity: recovered.gitIdentity }
      } catch (error) {
        const detail = renderError(error)
        throw new Error(
          `Team "${teamInfo.teamName}" has no verified Git identity and its persisted root could not be recovered (${detail}). `
          + "For a multi-repository workspace, retry team_spawn with repository_root set to the exact child Git repository root. "
          + "If the persisted Team root should itself be a Git repository, restore that repository and retry the same team_spawn call.",
        )
      }
    }
    return { repositoryRoot: team.repositoryRoot, gitIdentity: team.gitIdentity ?? "" }
  }
  const repositoryOps = deps.repositoryBindingOps ?? repositoryBindingOps
  const selected = await repositoryOps.verifyRepositoryRoot(explicitRoot, true)
  if (selected.repositoryRoot !== team.repositoryRoot && !isPathWithin(team.controllerDirectory, selected.repositoryRoot)) {
    throw new Error(`repository_root must be the Team repository or an exact Git repository root under the Team controller directory: ${team.controllerDirectory}`)
  }
  return selected
}

function createSpawnAttempt(
  deps: ToolDeps,
  teamId: string,
  name: string,
  repository: SpawnRepository,
  worktreeName: string,
  taskId: string | undefined,
  claimEventId: string | undefined,
): void {
  const now = Date.now()
  deps.db.run(
    `INSERT INTO team_spawn_attempt
       (team_id, name, repository_root, repository_git_identity, worktree_name,
        claim_task_id, claim_event_id, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [teamId, name, repository.repositoryRoot, repository.gitIdentity, worktreeName, taskId ?? null, claimEventId ?? null, now, now],
  )
}

function updateSpawnAttempt(
  deps: ToolDeps,
  teamId: string,
  name: string,
  fields: Partial<{
    stage: "worktree_creating" | "workspace_creating" | "session_creating" | "registered"
    worktree_dir: string
    worktree_branch: string
    worktree_source_branch: string
    worktree_baseline_oid: string
    worktree_name: string
    workspace_id: string
    session_id: string
    safe_branch: string
  }>,
): void {
  const entries = Object.entries(fields)
  if (entries.length === 0) return
  const assignments = entries.map(([column]) => `${column} = ?`).join(", ")
  const result = deps.db.run(
    `UPDATE team_spawn_attempt SET ${assignments}, time_updated = ? WHERE team_id = ? AND name = ?`,
    [...entries.map(([, value]) => value), Date.now(), teamId, name],
  )
  if (result.changes !== 1) throw new Error(`Spawn attempt owner for teammate "${name}" is missing`)
}

function settleSpawnAttempt(
  deps: ToolDeps,
  teamId: string,
  name: string,
  taskId: string | undefined,
  claimEventId: string | undefined,
): void {
  immediateTransaction(deps.db, () => {
    if (taskId) {
      if (!claimEventId) throw new Error(`Task "${taskId}" settlement is missing its claim event`)
      rollbackSpawnTaskMutation(deps, teamId, taskId, name, claimEventId)
    }
    const deleted = deps.db.run("DELETE FROM team_spawn_attempt WHERE team_id = ? AND name = ?", [teamId, name])
    if (deleted.changes !== 1) throw new Error(`Spawn attempt owner for teammate "${name}" could not be settled`)
  })
}

function alertSpawnAttemptFailure(
  deps: ToolDeps,
  teamId: string,
  name: string,
  detail: string,
  taskId?: string,
): void {
  sendLeadAlert(deps.db, deps.client, {
    teamId,
    content: `Spawn cleanup for teammate "${name}" could not be proven complete. Its durable spawn attempt and claimed task ${taskId ?? "none"} remain owned for recovery. ${detail}`,
    wakeText: `[System: Teammate ${name} spawn cleanup requires recovery; guidance is available in team messages]`,
  })
}

async function identifyWorktree(
  deps: ToolDeps,
  repository: SpawnRepository,
  worktreeName: string,
  result: { name: string; branch: string; directory: string },
): Promise<SpawnWorktree> {
  if (!matchesCreatedWorktreeName(worktreeName, result.name) || !result.directory || !result.branch.trim()) {
    throw new Error("worktree.create returned incomplete or mismatched resource identity")
  }
  const repositoryOps = deps.repositoryBindingOps ?? repositoryBindingOps
  const identity = await repositoryOps.resolveWorktreeIdentity(result.directory)
  if (identity.gitIdentity !== repository.gitIdentity) {
    throw new Error("created worktree belongs to a different Git repository")
  }
  const sourceOid = await repositoryOps.resolveGitRefOid(repository.repositoryRoot, `refs/heads/${result.branch}`)
  if (!sourceOid) throw new Error(`created worktree source branch ${result.branch} could not be verified`)
  if (sourceOid !== identity.headOid) throw new Error(`created worktree branch ${result.branch} does not match its HEAD`)
  return { directory: result.directory, branch: result.branch, sourceBranch: result.branch, baselineOid: sourceOid }
}

async function reconcileWorktree(
  deps: ToolDeps,
  repository: SpawnRepository,
  worktreeName: string,
): Promise<SpawnWorktree | null> {
  const listed = await deps.client.worktree.list({ directory: repository.repositoryRoot })
  const normalizedName = normalizeWorktreeName(worktreeName)
  const matches = (listed.data ?? []).filter(worktree => worktree.name === normalizedName)
  if (matches.length > 1) throw new Error(`worktree.list returned multiple resources named ${worktreeName}`)
  return matches[0] ? identifyWorktree(deps, repository, worktreeName, matches[0]) : null
}

async function reconcileWorkspace(deps: ToolDeps, repositoryRoot: string, branch: string): Promise<string | null> {
  const listed = await deps.client.workspace.list({ directory: repositoryRoot })
  const matches = (listed.data ?? []).filter(workspace => workspace.branch === branch)
  if (matches.length > 1) throw new Error(`workspace.list returned multiple resources for branch ${branch}`)
  return matches[0]?.id ?? null
}

/**
 * Execute the team_spawn tool. Creates a child session and starts a teammate.
 * By default, each teammate gets their own git worktree for file isolation.
 * Pass worktree: false for read-only agents that don't need isolation.
 * Pass plan_approval: true to require the teammate to send a plan before writing.
 */
export async function executeTeamSpawn(
  deps: ToolDeps,
  args: SpawnArgs,
  sessionId: string,
  preserve: PreserveBranchFn = preserveBranch,
): Promise<string> {
  const nameError = validateMemberName(args.name)
  if (nameError) throw new Error(nameError)

  const teamInfo = requireLead(deps, sessionId)
  const spawnKey = `${teamInfo.teamId}:${args.name}`
  if (spawnsInFlight.has(spawnKey)) {
    throw new Error(`Teammate "${args.name}" is already being spawned in team "${teamInfo.teamName}"`)
  }
  spawnsInFlight.add(spawnKey)

  try {
    return await executeTeamSpawnLocked(deps, args, sessionId, teamInfo, preserve)
  } finally {
    spawnsInFlight.delete(spawnKey)
  }
}

async function executeTeamSpawnLocked(
  deps: ToolDeps,
  args: SpawnArgs,
  sessionId: string,
  teamInfo: ReturnType<typeof requireLead>,
  preserve: PreserveBranchFn,
): Promise<string> {
  // Circuit breaker — stop retrying after 3 consecutive failures
  const failures = spawnFailures.get(teamInfo.teamId)
  if (failures && failures.count >= 3) {
    throw new Error(`Spawn circuit breaker tripped for team "${teamInfo.teamName}": 3 consecutive failures. Last error: ${failures.lastError}. Investigate before retrying — the circuit breaker resets on the next successful spawn.`)
  }

  // Check duplicate name
  const existing = deps.db.query("SELECT name FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamInfo.teamId, args.name)
  if (existing) throw new Error(`Teammate "${args.name}" already exists in team "${teamInfo.teamName}"`)

  const profile = resolveProfile(args.profile, args.agent)
  const runtimeAgent = profile.agent
  const isReadOnly = profile.access === "read"
  if (!isReadOnly && args.worktree === false) {
    throw new Error(`Ensemble profile "${profile.name}" is a writer and requires an isolated worktree`)
  }
  const repository = await resolveSpawnRepository(deps, teamInfo, args.repository_root, isReadOnly)
  if (!isReadOnly && isWorktreeDirectory(repository.repositoryRoot)) {
    throw new Error(`Ensemble profile "${profile.name}" cannot create an isolated writer worktree from ${repository.repositoryRoot}`)
  }
  const memberCount = (deps.db.query("SELECT COUNT(*) as c FROM team_member WHERE team_id = ?").get(teamInfo.teamId) as { c: number }).c
  const resolvedModel = resolveModel(args.model, runtimeAgent, memberCount, deps.config)
  const modelParam = resolvedModel ? parseModelId(resolvedModel) : undefined
  if (resolvedModel && !modelParam) {
    throw new Error(`Invalid model "${resolvedModel}" for Ensemble profile "${profile.name}"; expected provider/model format`)
  }

  const resumeContext = args.resume_from
    ? await buildResumeContext(deps, teamInfo.teamId, args.resume_from)
    : undefined

  const claimedTask = args.claim_task
    ? claimSpawnTask(deps, teamInfo.teamId, args.claim_task, args.name)
    : undefined
  const claimEventId = claimedTask?.claimEventId

  const useWorktree = args.worktree !== false && !isReadOnly && !isWorktreeDirectory(repository.repositoryRoot)
  const usePlanApproval = args.plan_approval === true
  const resource = getTeamResourceParts(deps.db, teamInfo.teamId)
  const worktreeName = teamWorktreeName(resource.projectName, resource.teamName, resource.teamId, args.name)

  if (useWorktree) {
    try {
      createSpawnAttempt(deps, teamInfo.teamId, args.name, repository, worktreeName, args.claim_task, claimEventId)
    } catch (error) {
      rollbackSpawnTask(deps, teamInfo.teamId, args.claim_task, args.name, claimEventId)
      throw error
    }
  }

  log(`spawn:start name=${args.name} profile=${profile.name} agent=${runtimeAgent} worktree=${useWorktree}`)

  // Create worktree if enabled
  let worktreeDir: string | null = null
  let worktreeBranch: string | null = null
  let worktreeSourceBranch: string | null = null
  let worktreeBaselineOid: string | null = null

  if (useWorktree) {
    try {
      log(`spawn:worktree:start name=${args.name}`)
      const worktreeCreate = deps.client.worktree.create({
        directory: repository.repositoryRoot,
        worktreeCreateInput: { name: worktreeName },
      })
      worktreeCreate.then(result => {
        const late = result.data
        if (!late?.directory || !late.branch.trim()) return
        try {
          updateSpawnAttempt(deps, teamInfo.teamId, args.name, {
            worktree_name: late.name,
            worktree_dir: late.directory,
            worktree_branch: late.branch,
          })
        } catch {
          // Ownership already transferred or settled before the late response.
        }
      }).catch(() => { /* the normal await path renders the error */ })
      const result = await withTimeout(
        worktreeCreate,
        getSpawnTimeout(), `worktree.create for "${args.name}"`
      )
      if (!result.data) throw new Error("worktree.create returned no worktree")
      if (result.data.directory && result.data.branch.trim()) {
        worktreeDir = result.data.directory
        worktreeBranch = result.data.branch
        updateSpawnAttempt(deps, teamInfo.teamId, args.name, {
          worktree_name: result.data.name,
          worktree_dir: worktreeDir,
          worktree_branch: worktreeBranch,
        })
      }
      const identified = await identifyWorktree(deps, repository, worktreeName, result.data)
      worktreeDir = identified.directory
      worktreeBranch = identified.branch
      worktreeSourceBranch = identified.sourceBranch
      worktreeBaselineOid = identified.baselineOid
      updateSpawnAttempt(deps, teamInfo.teamId, args.name, {
        worktree_dir: worktreeDir,
        worktree_branch: worktreeBranch,
        worktree_source_branch: worktreeSourceBranch,
        worktree_baseline_oid: worktreeBaselineOid,
      })
      log(`spawn:worktree:done name=${args.name} dir=${worktreeDir}`)
    } catch (err) {
      const detail = renderError(err)
      log(`spawn:worktree:failed name=${args.name} err=${detail}`)
      if (isSpawnTimeout(detail)) {
        alertSpawnAttemptFailure(deps, teamInfo.teamId, args.name, `Worktree creation timed out, so absence cannot be proven while the SDK request may still complete. Repository: ${repository.repositoryRoot}. Worktree name: ${worktreeName}.`, args.claim_task)
        throw new Error(`Failed to create isolated worktree for teammate "${args.name}": ${detail}. The durable attempt and claimed task were retained because the request may still complete.`)
      }
      try {
        const reconciled = worktreeDir && worktreeBranch
          ? { directory: worktreeDir, branch: worktreeBranch, sourceBranch: worktreeSourceBranch ?? worktreeBranch, baselineOid: worktreeBaselineOid ?? "" }
          : await reconcileWorktree(deps, repository, worktreeName)
        if (reconciled) {
          worktreeDir = reconciled.directory
          worktreeBranch = reconciled.branch
          worktreeSourceBranch = reconciled.sourceBranch
          worktreeBaselineOid = reconciled.baselineOid
          updateSpawnAttempt(deps, teamInfo.teamId, args.name, {
            worktree_dir: reconciled.directory,
            worktree_branch: reconciled.branch,
            worktree_source_branch: reconciled.sourceBranch,
            worktree_baseline_oid: reconciled.baselineOid,
          })
          await deps.client.worktree.remove({
            directory: repository.repositoryRoot,
            worktreeRemoveInput: { directory: reconciled.directory },
          })
        }
        settleSpawnAttempt(deps, teamInfo.teamId, args.name, args.claim_task, claimEventId)
      } catch (cleanupError) {
        const cleanupDetail = renderError(cleanupError)
        alertSpawnAttemptFailure(deps, teamInfo.teamId, args.name, `Worktree setup error: ${detail}. Cleanup error: ${cleanupDetail}. Repository: ${repository.repositoryRoot}. Worktree name: ${worktreeName}.`, args.claim_task)
        throw new Error(`Failed to create isolated worktree for teammate "${args.name}": ${detail}. Cleanup could not be proven complete: ${cleanupDetail}. The durable attempt and claimed task were retained.`)
      }
      try {
        await deps.client.tui.showToast({
          title: "Team",
          message: `Worktree creation failed for ${args.name}; spawn was cancelled`,
          variant: "error",
          duration: 4000,
        })
      } catch { /* TUI may not be available */ }
      throw new Error(`Failed to create isolated worktree for teammate "${args.name}": ${detail}. Writer profiles require an isolated worktree; inspect the reported Git/worktree failure before retrying.`)
    }
  }

  // Create workspace from worktree branch — links session to worktree directory.
  // OQ-workspace: assumes workspace.create({ branch }) auto-links to the worktree at that branch.
  let workspaceId: string | null = null
  if (worktreeDir && worktreeBranch) {
    try {
      updateSpawnAttempt(deps, teamInfo.teamId, args.name, { stage: "workspace_creating" })
      log(`spawn:workspace:start name=${args.name}`)
      const workspaceCreate = deps.client.workspace.create({ directory: repository.repositoryRoot, branch: worktreeBranch })
      workspaceCreate.then(result => {
        const lateWorkspaceId = result.data?.id
        if (!lateWorkspaceId) return
        try {
          updateSpawnAttempt(deps, teamInfo.teamId, args.name, { workspace_id: lateWorkspaceId })
        } catch {
          // Ownership already transferred or settled before the late response.
        }
      }).catch(() => { /* the normal await path renders the error */ })
      const wsResult = await withTimeout(
        workspaceCreate,
        getSpawnTimeout(), `workspace.create for "${args.name}"`
      )
      if (wsResult.data) {
        workspaceId = wsResult.data.id
        updateSpawnAttempt(deps, teamInfo.teamId, args.name, { workspace_id: workspaceId })
      } else {
        workspaceId = await reconcileWorkspace(deps, repository.repositoryRoot, worktreeBranch)
        if (workspaceId) updateSpawnAttempt(deps, teamInfo.teamId, args.name, { workspace_id: workspaceId })
      }
      log(`spawn:workspace:done name=${args.name} id=${workspaceId}`)
    } catch (err) {
      const workspaceDetail = renderError(err)
      log(`spawn:workspace:failed name=${args.name} err=${workspaceDetail}`)
      if (isSpawnTimeout(workspaceDetail)) {
        alertSpawnAttemptFailure(deps, teamInfo.teamId, args.name, `Workspace creation timed out, so absence cannot be proven while the SDK request may still complete. Repository: ${repository.repositoryRoot}. Branch: ${worktreeBranch}.`, args.claim_task)
        throw new Error(`Failed to create workspace for teammate "${args.name}": ${workspaceDetail}. The durable attempt and claimed task were retained because the request may still complete.`)
      }
      try {
        workspaceId = await reconcileWorkspace(deps, repository.repositoryRoot, worktreeBranch)
        if (workspaceId) updateSpawnAttempt(deps, teamInfo.teamId, args.name, { workspace_id: workspaceId })
      } catch (reconcileError) {
        const detail = renderError(reconcileError)
        alertSpawnAttemptFailure(deps, teamInfo.teamId, args.name, `Workspace setup could not be reconciled: ${detail}. Repository: ${repository.repositoryRoot}. Branch: ${worktreeBranch}.`, args.claim_task)
        throw new Error(`Failed to reconcile workspace setup for teammate "${args.name}": ${detail}. The durable attempt and claimed task were retained.`)
      }
    }
  }

  // Permission rules on session.create are the hard gate (server-enforced).
  // For read-only agents, deny write tools and explicitly allow team tools.
  // For all agents with worktrees, allowlist the worktree path for edit/bash.
  const TEAM_TOOLS = [
    "team_message",
    "team_broadcast",
    "team_tasks_list",
    "team_tasks_add",
    "team_tasks_complete",
    "team_claim",
    "team_consult",
    "team_consult_reply",
    "team_metrics",
    "team_artifact_publish",
    "team_artifact_list",
    "team_artifact_read",
  ] as const
  // Read-only profiles still need the host's evidence tools to inspect source
  // and read files written by OpenCode's native output truncation.
  const READ_ONLY_TOOLS = ["read", "glob", "grep", "list"] as const
  const permission: PermissionRule[] = []

  if (worktreeDir) {
    permission.push(
      { permission: "edit", pattern: `${worktreeDir}/**`, action: "allow" },
    )
    if (!isReadOnly) {
      permission.push({ permission: "bash", pattern: "*", action: "allow" })
    }
  }

  if (isReadOnly) {
    permission.push(
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" },
      ...READ_ONLY_TOOLS.map(t => ({ permission: t, pattern: "*", action: "allow" as const })),
    )
  }

  permission.push(
    ...TEAM_TOOLS.map(t => ({ permission: t, pattern: "*", action: "allow" as const })),
  )

  // Create child session — bind to workspace if available (server-enforced CWD isolation).
  // Falls back to no workspace binding if workspace.create failed.
  let childSessionId: string | undefined
  try {
    if (useWorktree) updateSpawnAttempt(deps, teamInfo.teamId, args.name, { stage: "session_creating" })
    log(`spawn:session:start name=${args.name}`)
    const sessionCreate = deps.client.session.create({
        parentID: sessionId,
        title: `${args.name} (@${profile.name} teammate)`,
        permission,
        directory: workspaceId ? repository.repositoryRoot : (worktreeDir ?? repository.repositoryRoot),
        ...(workspaceId ? { workspaceID: workspaceId } : {}),
      })
    if (useWorktree) {
      sessionCreate.then(result => {
        const lateSessionId = result.data?.id
        if (!lateSessionId) return
        try {
          updateSpawnAttempt(deps, teamInfo.teamId, args.name, { session_id: lateSessionId })
        } catch {
          // Ownership already transferred or settled before the late response.
        }
      }).catch(() => { /* the normal await path renders the error */ })
    }
    const createResult = await withTimeout(
      sessionCreate,
      getSpawnTimeout(), `session.create for "${args.name}"`
    )
    childSessionId = createResult.data?.id
    if (childSessionId && useWorktree) {
      updateSpawnAttempt(deps, teamInfo.teamId, args.name, { session_id: childSessionId })
    }
    log(`spawn:session:done name=${args.name} sessionId=${childSessionId}`)
  } catch (err) {
    log(`spawn:session:failed name=${args.name} err=${renderError(err)}`)
    // Track failure for circuit breaker
    const errMsg = renderError(err)
    const prev = spawnFailures.get(teamInfo.teamId)
    spawnFailures.set(teamInfo.teamId, { count: (prev?.count ?? 0) + 1, lastError: errMsg })
    if (isSpawnTimeout(errMsg)) {
      alertSpawnAttemptFailure(deps, teamInfo.teamId, args.name, `Session creation timed out, so no abort or resource removal was attempted while the SDK request may still complete. Repository: ${repository.repositoryRoot}. Worktree: ${worktreeDir ?? "none"}. Workspace: ${workspaceId ?? "none"}.`, args.claim_task)
      throw new Error(`Failed to create session for teammate "${args.name}": ${errMsg}. The durable attempt and claimed task were retained because the request may still complete.`)
    }
    try {
      if (childSessionId && worktreeBranch) {
        const safeBranch = preservedBranchName(resource.projectName, resource.teamName, resource.teamId, args.name)
        if (!await preserve(worktreeBranch, safeBranch, repository.repositoryRoot)) {
          throw new Error(`branch ${worktreeBranch} could not be preserved before aborting session ${childSessionId}`)
        }
        updateSpawnAttempt(deps, teamInfo.teamId, args.name, { safe_branch: safeBranch })
        await deps.client.session.abort({ sessionID: childSessionId })
      }
      if (workspaceId) await deps.client.workspace.remove({ directory: repository.repositoryRoot, id: workspaceId })
      if (worktreeDir) await deps.client.worktree.remove({ directory: repository.repositoryRoot, worktreeRemoveInput: { directory: worktreeDir } })
      if (useWorktree) settleSpawnAttempt(deps, teamInfo.teamId, args.name, args.claim_task, claimEventId)
      else rollbackSpawnTask(deps, teamInfo.teamId, args.claim_task, args.name, claimEventId)
    } catch (cleanupError) {
      const cleanupDetail = renderError(cleanupError)
      alertSpawnAttemptFailure(deps, teamInfo.teamId, args.name, `Session setup error: ${errMsg}. Cleanup error: ${cleanupDetail}. Repository: ${repository.repositoryRoot}.`, args.claim_task)
      throw new Error(`Failed to create session for teammate "${args.name}": ${errMsg}. Cleanup could not be proven complete: ${cleanupDetail}. The durable attempt and claimed task were retained.`)
    }
    throw new Error(`Failed to create session for teammate "${args.name}": ${errMsg}`)
  }

  if (!childSessionId) {
    try {
      if (workspaceId) await deps.client.workspace.remove({ directory: repository.repositoryRoot, id: workspaceId })
      if (worktreeDir) await deps.client.worktree.remove({ directory: repository.repositoryRoot, worktreeRemoveInput: { directory: worktreeDir } })
      if (useWorktree) settleSpawnAttempt(deps, teamInfo.teamId, args.name, args.claim_task, claimEventId)
      else rollbackSpawnTask(deps, teamInfo.teamId, args.claim_task, args.name, claimEventId)
    } catch (cleanupError) {
      const detail = renderError(cleanupError)
      alertSpawnAttemptFailure(deps, teamInfo.teamId, args.name, `Session creation returned no ID and cleanup failed: ${detail}. Repository: ${repository.repositoryRoot}.`, args.claim_task)
      throw new Error(`Failed to create teammate session. Cleanup could not be proven complete: ${detail}. The durable attempt and claimed task were retained.`)
    }
    throw new Error("Failed to create teammate session")
  }

  // Register in DB
  const planApproval = usePlanApproval ? "pending" : "none"
  const now = Date.now()
  // The model was validated before task claims or external resource creation.
  if (resolvedModel) log(`spawn:model name=${args.name} model=${resolvedModel}`)

  try {
    immediateTransaction(deps.db, () => {
      deps.db.run(
        `INSERT INTO team_member (team_id, name, session_id, agent, profile, status, execution_status, model, prompt, worktree_dir, worktree_branch, worktree_source_branch, worktree_baseline_oid, workspace_id, repository_root, repository_git_identity, plan_approval, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, 'busy', 'starting', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [teamInfo.teamId, args.name, childSessionId, runtimeAgent, profile.name, resolvedModel ?? null, args.prompt, worktreeDir, worktreeBranch, worktreeSourceBranch, worktreeBaselineOid, workspaceId, isReadOnly ? null : repository.repositoryRoot, isReadOnly ? null : repository.gitIdentity, planApproval, now, now]
      )
      if (useWorktree) {
        const deleted = deps.db.run("DELETE FROM team_spawn_attempt WHERE team_id = ? AND name = ?", [teamInfo.teamId, args.name])
        if (deleted.changes !== 1) throw new Error("durable spawn attempt could not be transferred to member ownership")
      }
      appendTeamEvent(deps.db, {
        teamId: teamInfo.teamId,
        kind: "member.registered",
        payload: { member_name: args.name },
      })
      if (resumeContext) {
        appendTeamEvent(deps.db, {
          teamId: teamInfo.teamId,
          kind: "resume.linked",
          payload: {
            member_name: args.name,
            predecessor_name: resumeContext.predecessor,
            context_truncated: resumeContext.truncated,
          },
        })
      }
    })
  } catch (err) {
    const registrationError = renderError(err)
    if (!useWorktree) {
      try {
        sendLeadAlert(deps.db, deps.client, {
          teamId: teamInfo.teamId,
          content: `Teammate "${args.name}" could not be registered, so its unowned read-only session was not aborted. Manual recovery is required for session ${childSessionId}. Claimed task: ${args.claim_task ?? "none"}. Registration error: ${registrationError}.`,
          wakeText: `[System: Teammate ${args.name} registration failed; unowned read-only session requires manual recovery]`,
        })
        rollbackSpawnTask(deps, teamInfo.teamId, args.claim_task, args.name, claimEventId)
      } catch (recoveryError) {
        throw new Error(`${registrationError}; read-only recovery failed: ${renderError(recoveryError)}`)
      }
      throw err
    }
    let safeBranch: string | null = null
    if (worktreeBranch) {
      safeBranch = preservedBranchName(resource.projectName, resource.teamName, resource.teamId, args.name)
      const ok = await preserve(worktreeBranch, safeBranch, repository.repositoryRoot)
      if (!ok) {
        try {
          sendLeadAlert(deps.db, deps.client, {
            teamId: teamInfo.teamId,
            content: `Teammate "${args.name}" could not be registered and branch ${worktreeBranch} could not be preserved. Its session and worktree remain intact for manual recovery. Session: ${childSessionId}. Worktree: ${worktreeDir ?? "none"}. Workspace: ${workspaceId ?? "none"}. Claimed task: ${args.claim_task ?? "none"}. Error: ${registrationError}.`,
            wakeText: `[System: Teammate ${args.name} registration and branch preservation failed; recovery guidance is available in team messages]`,
          })
        } catch (alertError) {
          const message = renderError(alertError)
          throw new Error(`${registrationError}; branch preservation failed and recovery alert also failed: ${message}. Session ${childSessionId}, live branch ${worktreeBranch}, worktree ${worktreeDir ?? "none"}, workspace ${workspaceId ?? "none"}, and claimed task ${args.claim_task ?? "none"} were left intact.`)
        }
        throw new Error(`${registrationError}. Cleanup stopped because branch ${worktreeBranch} could not be preserved; the session and worktree were left intact for retry.`)
      }
    }
    try {
      if (safeBranch) updateSpawnAttempt(deps, teamInfo.teamId, args.name, { safe_branch: safeBranch })
      await deps.client.session.abort({ sessionID: childSessionId })
      if (workspaceId) await deps.client.workspace.remove({ directory: repository.repositoryRoot, id: workspaceId })
      if (worktreeDir) await deps.client.worktree.remove({ directory: repository.repositoryRoot, worktreeRemoveInput: { directory: worktreeDir } })
      settleSpawnAttempt(deps, teamInfo.teamId, args.name, args.claim_task, claimEventId)
    } catch (cleanupError) {
      const detail = renderError(cleanupError)
      alertSpawnAttemptFailure(deps, teamInfo.teamId, args.name, `Registration error: ${registrationError}. Branch: ${worktreeBranch ?? "none"}. Preserved branch: ${safeBranch ?? "none"}. Session: ${childSessionId}. Cleanup error: ${detail}.`, args.claim_task)
      throw new Error(`${registrationError}. Pre-prompt cleanup could not be proven complete: ${detail}. The durable attempt and claimed task were retained.`)
    }
    throw err
  }

  // Register in memory
  deps.registry.register(teamInfo.teamId, args.name, childSessionId)

  // Build teammate context message
  const context = [
    `You are "${args.name}", a teammate in team "${teamInfo.teamName}".`,
    `Your Ensemble profile is "${profile.name}" using runtime agent "${runtimeAgent}".`,
    `Mission: ${profile.mission}`,
    `Capabilities: ${profile.capabilities.join(", ")}.`,
  ]

  // Show other teammates so this agent knows who to message
  const otherMembers = deps.db.query(
    "SELECT name FROM team_member WHERE team_id = ? AND name != ? AND status NOT IN ('shutdown', 'error')"
  ).all(teamInfo.teamId, args.name) as Array<{ name: string }>
  if (otherMembers.length > 0) {
    context.push(`Other teammates: ${otherMembers.map(m => m.name).join(", ")}`)
  }

  if (worktreeBranch && worktreeDir && !workspaceId) {
    // Workspace binding failed — fallback to prompt-based CWD instruction
    context.push(
      `You are working on branch "${worktreeBranch}" in your own worktree at: ${worktreeDir}`,
      `Your changes are isolated from other teammates.`,
      `IMPORTANT: All file operations and shell commands MUST target your worktree directory.`,
      `Before running shell commands, cd to: ${worktreeDir}`,
    )
  } else if (worktreeBranch && worktreeDir) {
    // Workspace binding active — server handles CWD
    context.push(
      `You are working on branch "${worktreeBranch}" in your own isolated worktree.`,
      `Your changes are isolated from other teammates.`,
    )
  } else if (worktreeBranch) {
    context.push(`You are working on branch "${worktreeBranch}". Your changes are isolated from other teammates.`)
  }

  // Plan approval mode — teammate must send plan before writing
  if (usePlanApproval) {
    context.push(
      "",
      "IMPORTANT: You are in PLAN MODE.",
      "Read and explore the codebase, then send your implementation plan to the lead via team_message using this exact format:",
      "<plan-submission>",
      "<summary>One-line implementation plan summary</summary>",
      "<details>Ordered implementation and verification steps</details>",
      "</plan-submission>",
      "Do NOT write or modify any files until the lead approves your plan.",
      "Wait for the lead's approval message before proceeding with implementation.",
      "If the lead rejects your plan, submit the revision using the same format and wait for a new approval.",
    )
  }

  context.push(
    "", "Tools available to you:",
    ...(isReadOnly
      ? [
          "- read: read source files and saved tool output by path, using offset/limit for large files",
          "- glob: find files by glob pattern",
          "- grep: search file contents by regular expression",
          "- list: inspect directory entries",
        ]
      : []),
    "- team_message: send a message to the lead or another teammate",
    "- team_broadcast: send a message to all team members",
    "- team_tasks_list: view the shared team task board",
    "- team_tasks_add: add tasks to the shared board",
    "- team_tasks_complete: atomically complete a claimed task and report its terminal result to the Lead",
    "- team_claim: claim a pending task from the shared board",
    "- team_consult: ask a Planner to resolve a technical contract for your owned task boundary",
    "- team_consult_reply: Planner-only reply or escalation for a pending consultation",
    "- team_metrics: read bounded privacy-safe telemetry across projects and conversations",
    "- team_artifact_publish: publish an immutable Team contract or owned task result",
    "- team_artifact_list: list bounded artifact metadata without content",
    "- team_artifact_read: read one exact Team artifact by opaque ID",
  )

  // Collaboration guidance for peer-to-peer communication
  if (otherMembers.length > 0) {
    context.push(
      "",
      "Collaboration:",
      "- Check team_tasks_list to see what other teammates are working on.",
      "- If you need information another teammate has, message them directly via team_message.",
      "- If you discover something relevant to another teammate's task, share it with them.",
      "- Use team_broadcast for updates that affect the whole team.",
      "- Keep peer messages focused and actionable — coordinate, don't chat.",
    )
  }

  context.push("", "When you finish your task:")
  if (!isReadOnly && worktreeBranch) {
    context.push(`1. Commit your changes: git add -A && git commit -m "your summary"`)
    context.push(args.claim_task
      ? "2. Call team_tasks_complete once with task_id and result: { summary, details, branch }. This atomically completes the claimed task and reports the terminal result to the Lead."
      : "2. Send ONE message to the lead using team_message with the result format below.")
  } else {
    context.push(args.claim_task
      ? "1. Call team_tasks_complete once with task_id and result: { summary, details }. This atomically completes the claimed task and reports the terminal result to the Lead."
      : "1. Send ONE message to the lead using team_message with the result format below.")
  }
  context.push("For progress, blockers, or an unclaimed terminal result sent with team_message, use:")
  context.push(
    "<task-result>",
    "<kind>progress, result, or blocker</kind>",
    "<task_id>assigned task ID when applicable</task_id>",
    "<status>pending, in_progress, completed, or failed</status>",
    "<summary>One-line summary of what you did</summary>",
    "<details>Full findings or changes made</details>",
  )
  if (worktreeBranch) {
    context.push(`<branch>${worktreeBranch}</branch>`)
  }
  context.push("</task-result>")
  const lastStep = !isReadOnly && worktreeBranch ? "3" : "2"
  context.push(
    `${lastStep}. STOP. Do not send follow-up confirmations, status updates, or 'standing by' messages.`,
    "",
    "If you are blocked:",
    "- Send ONE structured blocker message to the lead via team_message describing the specific blocker.",
    "- Do NOT attempt workarounds or make assumptions. Wait for the lead's response.",
    "",
    "Your plain text output is NOT visible to the team. You MUST use team_message to communicate.",
    ...(isReadOnly
      ? [
          "When a tool reports that full output was saved to a path, use read, grep, or glob on that path to inspect the actual evidence before reporting.",
          "Send concise incremental progress summaries only at meaningful milestones or phase transitions; keep raw logs and long evidence in your session unless the lead asks for them.",
        ]
      : ["Send concise incremental progress summaries only at meaningful milestones or phase transitions; keep raw logs and long evidence in your session unless the lead asks for them."]),
  )

  if (resumeContext) {
    context.push(
      "",
      `Resumed context from teammate "${resumeContext.predecessor}" (reference only; your current task follows):`,
      resumeContext.text,
      RESUME_SAFETY_INSTRUCTION,
    )
  }

  context.push(
    "",
    "Your task:",
    args.prompt,
  )

  if (args.claim_task) {
    context.push("", `You have been assigned task ${args.claim_task}. Complete it with one team_tasks_complete call carrying the terminal result.`)
    if (claimedTask?.contractArtifactId) {
      context.push(
        `Bound contract artifact: ${claimedTask.contractArtifactId}`,
        `Bound contract SHA-256: ${claimedTask.contractArtifactSha256}`,
        "Read that exact artifact with team_artifact_read; do not substitute another contract.",
      )
    }
    const scoutContext = buildScoutDependencyContext(deps, teamInfo.teamId, args.claim_task)
    if (scoutContext) context.push("", scoutContext)
  }

  const contextStr = context.join("\n")

  // Fire-and-forget: send prompt to teammate session.
  log(`spawn:promptAsync:fire name=${args.name} sessionId=${childSessionId}`)
  deps.client.session.promptAsync({
    sessionID: childSessionId,
    parts: [{ type: "text", text: contextStr }],
    agent: runtimeAgent,
    ...(modelParam ? { model: modelParam } : {}),
  }).catch((err) => {
    const errMsg = renderError(err)
    log(`spawn:promptAsync:failed name=${args.name} err=${errMsg} — rolling back`)
    try {
      const preserveThenAbort = async () => {
        let safeBranch: string | null = null
        if (worktreeBranch) {
          const resource = getTeamResourceParts(deps.db, teamInfo.teamId)
          safeBranch = preservedBranchName(resource.projectName, resource.teamName, resource.teamId, args.name)
          const ok = await preserve(worktreeBranch, safeBranch, repository.repositoryRoot)
          if (!ok) {
            sendLeadAlert(deps.db, deps.client, {
              teamId: teamInfo.teamId,
              content: `Teammate "${args.name}" failed to start and branch preservation also failed. Its live session, task ownership, and worktree were left intact at ${worktreeBranch} so recovery remains retryable. Error: ${errMsg}.`,
              wakeText: `[System: Teammate ${args.name} failed to start and branch preservation failed; recovery guidance is available in team messages]`,
            })
            return
          }
        }
        try {
          const recorded = deps.db.run(
            `UPDATE team_member
             SET status = 'shutdown_requested', worktree_branch = COALESCE(?, worktree_branch), time_updated = ?
             WHERE team_id = ? AND session_id = ? AND status NOT IN ('shutdown', 'error')`,
            [safeBranch, Date.now(), teamInfo.teamId, childSessionId],
          )
          if (recorded.changes !== 1) {
            throw new Error("member state changed before the safe branch reference was recorded")
          }
        } catch (recordError) {
          const message = renderError(recordError)
          sendLeadAlert(deps.db, deps.client, {
            teamId: teamInfo.teamId,
            content: `Teammate "${args.name}" failed to start and its safe branch reference could not be recorded, so its session was not aborted. Its member, task ownership, session, and resources remain intact for manual recovery. Preserved branch: ${safeBranch ?? "none"}. Error: ${message}.`,
            wakeText: `[System: Teammate ${args.name} failed to start; safe branch ownership could not be recorded and abort was suppressed]`,
          })
          return
        }
        try {
          await deps.client.session.abort({ sessionID: childSessionId })
        } catch (abortError) {
          const message = renderError(abortError)
          sendLeadAlert(deps.db, deps.client, {
            teamId: teamInfo.teamId,
            content: `Teammate "${args.name}" failed to start and its branch was preserved, but abort failed. Its member, task ownership, live source branch, and registry entry remain available for retry. Error: ${message}.`,
            wakeText: `[System: Teammate ${args.name} failed to start and could not be aborted; recovery guidance is available in team messages]`,
          })
          return
        }
        let checkpointId: string
        try {
          checkpointId = sendLeadAlert(deps.db, deps.client, {
            teamId: teamInfo.teamId,
            content: `Prompt rollback cleanup checkpoint for teammate "${args.name}". Session abort succeeded; cleanup is about to run and may be partially or fully complete when this message is read. Inspect actual state before retrying any step. The shutdown_requested member currently owns the recovery state. Preserved branch: ${safeBranch ?? "none"}. Session: ${childSessionId}. Worktree: ${worktreeDir ?? "none"}. Workspace: ${workspaceId ?? "none"}. Claimed task: ${args.claim_task ?? "none"}. Cleanup order: remove workspace, remove worktree, then atomically release the task and delete the member before unregistering the session.`,
            wakeText: `[System: Teammate ${args.name} prompt rollback cleanup checkpoint is available in team messages]`,
          })
        } catch (checkpointError) {
          log(`spawn:promptAsync:checkpoint-failed name=${args.name} sessionId=${childSessionId} safeBranch=${safeBranch ?? "none"} worktree=${worktreeDir ?? "none"} workspace=${workspaceId ?? "none"} task=${args.claim_task ?? "none"} err=${renderError(checkpointError)}`)
          return
        }
        const alertCleanupFailure = (phase: string, cleanupError: unknown) => {
          const message = renderError(cleanupError)
          try {
            sendLeadAlert(deps.db, deps.client, {
              teamId: teamInfo.teamId,
              content: `Teammate "${args.name}" failed to start and its session was aborted, but prompt rollback stopped during ${phase}: ${message}. The shutdown_requested member remains the durable owner of its safe branch and task ownership for manual recovery. Preserved branch: ${safeBranch ?? "none"}. Session: ${childSessionId}. Worktree: ${worktreeDir ?? "none"}. Workspace: ${workspaceId ?? "none"}. Claimed task: ${args.claim_task ?? "none"}. Retry the failed cleanup phase, then release the task and delete the member together before unregistering it.`,
              wakeText: `[System: Teammate ${args.name} prompt rollback cleanup is incomplete; manual recovery guidance is available in team messages]`,
            })
          } catch (alertError) {
            log(`spawn:promptAsync:cleanup-alert-failed name=${args.name} sessionId=${childSessionId} phase=${phase} cleanup=${message} alert=${renderError(alertError)}`)
          }
        }
        if (workspaceId) {
          try {
            await deps.client.workspace.remove({ directory: repository.repositoryRoot, id: workspaceId })
          } catch (cleanupError) {
            alertCleanupFailure("workspace removal", cleanupError)
            return
          }
        }
        if (worktreeDir) {
          try {
            await deps.client.worktree.remove({ directory: repository.repositoryRoot, worktreeRemoveInput: { directory: worktreeDir } })
          } catch (cleanupError) {
            alertCleanupFailure("worktree removal", cleanupError)
            return
          }
        }
        try {
          deps.db.transaction(() => {
            rollbackSpawnTask(deps, teamInfo.teamId, args.claim_task, args.name, claimEventId)
            const deleted = deps.db.run(
              "DELETE FROM team_member WHERE team_id = ? AND session_id = ? AND status = 'shutdown_requested'",
              [teamInfo.teamId, childSessionId],
            )
            if (deleted.changes !== 1) {
              throw new Error("durable member deletion did not match the shutdown_requested owner")
            }
            const completed = deps.db.run(
              "UPDATE team_message SET content = ? WHERE id = ? AND team_id = ?",
              [
                `Prompt rollback cleanup completed for teammate "${args.name}", which failed to start. Session ${childSessionId} was aborted, workspace ${workspaceId ?? "none"} and worktree ${worktreeDir ?? "none"} were removed, member ownership was deleted, and claimed task ${args.claim_task ?? "none"} was released. Preserved branch: ${safeBranch ?? "none"}. The spawn may be retried.`,
                checkpointId,
                teamInfo.teamId,
              ],
            )
            if (completed.changes !== 1) {
              throw new Error("recovery checkpoint could not be marked complete")
            }
          })()
        } catch (cleanupError) {
          alertCleanupFailure("atomic task release and member deletion", cleanupError)
          return
        }
        deps.registry.unregister(childSessionId)
        const modelInfo = resolvedModel ? ` (model: ${resolvedModel})` : ""
        try {
          sendLeadAlert(deps.db, deps.client, {
            teamId: teamInfo.teamId,
            content: `Teammate "${args.name}" failed to start and was removed${modelInfo}. Error: ${errMsg}. You may retry the spawn.`,
            wakeText: `[System: Teammate ${args.name} failed to start; guidance is available in team messages]`,
          })
        } catch (alertError) {
          log(`spawn:promptAsync:success-alert-failed name=${args.name} sessionId=${childSessionId} checkpoint=${checkpointId} err=${renderError(alertError)}`)
        }
      }
      preserveThenAbort().catch(cleanupError => {
        log(`spawn:promptAsync:cleanup-failed name=${args.name} sessionId=${childSessionId} err=${renderError(cleanupError)}`)
      })
      const modelInfo = resolvedModel ? ` (model: ${resolvedModel})` : ""
      deps.client.tui.showToast({
        title: "Team",
        message: `Teammate "${args.name}" failed to start${modelInfo}: ${errMsg}`,
        variant: "error",
        duration: 8000,
      }).catch(() => { /* TUI may not be available */ })
    } catch { /* rollback failed — watchdog will clean up stale member */ }
  })

  const branchInfo = worktreeBranch ? ` (branch: ${worktreeBranch})` : ""
  const planInfo = usePlanApproval ? " [plan mode — will send plan for approval]" : ""
  // Reset circuit breaker on success
  spawnFailures.delete(teamInfo.teamId)
  log(`spawn:done name=${args.name} sessionId=${childSessionId}`)
  const resumeInfo = resumeContext
    ? `, resuming from "${resumeContext.predecessor}" (${resumeContext.truncated ? "truncated context" : "complete context"})`
    : ""
  return `Teammate "${args.name}" spawned (profile: ${profile.name}, agent: ${runtimeAgent}${resumeInfo})${branchInfo}${planInfo}. They are working on: ${args.prompt.slice(0, 120)}${args.prompt.length > 120 ? "..." : ""}`
}

function buildScoutDependencyContext(deps: ToolDeps, teamId: string, taskId: string): string | undefined {
  const task = deps.db.query("SELECT depends_on FROM team_task WHERE id = ? AND team_id = ?")
    .get(taskId, teamId) as { depends_on: string | null } | null
  const dependencies = task?.depends_on ? JSON.parse(task.depends_on) as string[] : []
  const conclusions = dependencies.flatMap(dependencyId => {
    const dependency = deps.db.query(
      `SELECT task.assignee
       FROM team_task task
       JOIN team_member member ON member.team_id = task.team_id AND member.name = task.assignee
       WHERE task.id = ? AND task.team_id = ? AND task.status = 'completed' AND member.profile = 'scout'`,
    ).get(dependencyId, teamId) as { assignee: string } | null
    if (!dependency) return []
    const messages = deps.db.query(
      "SELECT content FROM team_message WHERE team_id = ? AND from_name = ? AND to_name = 'lead' ORDER BY time_created DESC, id DESC LIMIT 20",
    ).all(teamId, dependency.assignee) as Array<{ content: string }>
    const result = messages
      .map(message => parseTaskResult(message.content))
      .find(parsed => parsed?.kind === "result" && parsed.taskId === dependencyId)
    return result ? [`- ${result.summary}\n  ${result.details}`] : []
  })
  if (conclusions.length === 0) return undefined
  return [
    "Relevant Scout conclusions from completed task dependencies:",
    ...conclusions,
    "Treat these as evidence and boundaries; verify implementation-critical relationships against current source.",
  ].join("\n")
}

async function buildResumeContext(deps: ToolDeps, teamId: string, predecessorName: string): Promise<ResumeContext> {
  const predecessor = deps.db.query(
    "SELECT session_id, prompt FROM team_member WHERE team_id = ? AND name = ?",
  ).get(teamId, predecessorName) as { session_id: string; prompt: string | null } | null
  if (!predecessor) throw new Error(`Teammate "${predecessorName}" not found in this team`)

  const result = await deps.client.session.messages({
    sessionID: predecessor.session_id,
  })
  const messages = [...(result.data ?? [])].sort((left, right) => {
    const leftTime = resumeMessageTime(left)
    const rightTime = resumeMessageTime(right)
    if (leftTime !== rightTime) return leftTime - rightTime
    return resumeMessageId(left).localeCompare(resumeMessageId(right))
  })
  const transcript = messages
    .map((message, index) => formatResumeMessage(message, index))
    .filter((message): message is string => message !== undefined)
    .join("\n\n")
  const fullContext = [
    `Original task:\n${predecessor.prompt ?? "(not recorded)"}`,
    transcript ? `Session transcript (chronological):\n${transcript}` : "Session transcript: (no readable messages)",
  ].join("\n\n")
  const contextLimit = RESUME_CONTEXT_BYTE_LIMIT - utf8Length(`\n${RESUME_SAFETY_INSTRUCTION}`)
  if (utf8Length(fullContext) <= contextLimit) {
    return { predecessor: predecessorName, text: fullContext, truncated: false }
  }

  const marker = "\n\n[... predecessor context truncated ...]\n\n"
  const available = contextLimit - utf8Length(marker)
  const earlyLength = Math.floor(available * 0.4)
  const recentLength = available - earlyLength
  return {
    predecessor: predecessorName,
    text: `${utf8Prefix(fullContext, earlyLength)}${marker}${utf8Suffix(fullContext, recentLength)}`,
    truncated: true,
  }
}

function formatResumeMessage(
  message: { info: unknown; parts: unknown[] },
  index: number,
): string | undefined {
  const info = message.info && typeof message.info === "object"
    ? message.info as { role?: string; time?: { created?: number }; error?: unknown }
    : {}
  const parts = message.parts
    .map(formatResumePart)
    .filter((part): part is string => part !== undefined)
  const error = info.error === undefined ? undefined : `[message error] ${renderResumeValue(info.error)}`
  const content = [...parts, error].filter((part): part is string => part !== undefined).join("\n")
  if (!content) return undefined
  const role = info.role ?? "unknown"
  const sequence = info.time?.created ?? index
  return `[${sequence} ${role}]\n${content}`
}

function resumeMessageTime(message: { info: unknown }): number {
  if (!message.info || typeof message.info !== "object") return Number.MAX_SAFE_INTEGER
  const info = message.info as { time?: { created?: number } }
  return info.time?.created ?? Number.MAX_SAFE_INTEGER
}

function resumeMessageId(message: { info: unknown }): string {
  if (!message.info || typeof message.info !== "object") return ""
  const info = message.info as { id?: string }
  return info.id ?? ""
}

function formatResumePart(part: unknown): string | undefined {
  if (!part || typeof part !== "object") return undefined
  const value = part as {
    type?: string
    text?: string
    tool?: string
    state?: { status?: string; title?: string; input?: unknown; output?: unknown; error?: unknown }
  }
  if ((value.type === "text" || value.type === "reasoning") && value.text) return value.text
  if (value.type !== "tool") return undefined

  const details = value.state
    ? Object.fromEntries(
        Object.entries({
          status: value.state.status,
          title: value.state.title,
          input: value.state.input,
          output: value.state.output,
          error: value.state.error,
        }).filter((entry): entry is [string, unknown] => entry[1] !== undefined),
      )
    : undefined
  const rendered = details === undefined ? "" : renderResumeValue(details)
  return `[tool ${value.tool ?? "unknown"}]${rendered ? ` ${rendered}` : ""}`
}

function renderResumeValue(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value)
  const decoder = new TextDecoder("utf-8", { fatal: true })
  for (let end = Math.min(bytes.length, maxBytes); end >= 0; end--) {
    try {
      return decoder.decode(bytes.slice(0, end))
    } catch {
      // Move at most a few bytes to the previous UTF-8 boundary.
    }
  }
  return ""
}

function utf8Suffix(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value)
  const decoder = new TextDecoder("utf-8", { fatal: true })
  for (let start = Math.max(0, bytes.length - maxBytes); start <= bytes.length; start++) {
    try {
      return decoder.decode(bytes.slice(start))
    } catch {
      // Move at most a few bytes to the next UTF-8 boundary.
    }
  }
  return ""
}
