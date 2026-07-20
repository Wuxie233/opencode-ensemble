import type { ToolDeps, PermissionRule } from "../types"
import { validateMemberName } from "../util"
import { requireLead } from "./shared"
import { sendLeadAlert } from "../messaging"
import { log } from "../log"
import type { EnsembleConfig } from "../config"
import { getTeamResourceParts, preserveBranch, preservedBranchName, teamWorktreeName } from "./merge-helper"
import type { PreserveBranchFn } from "./merge-helper"

/** Tracks consecutive spawn failures per team for circuit breaker. */
export const spawnFailures = new Map<string, { count: number; lastError: string }>()
const spawnsInFlight = new Set<string>()
/** Maximum UTF-8 bytes copied from a predecessor session into a replacement prompt. */
export const RESUME_CONTEXT_BYTE_LIMIT = 32 * 1024

interface SpawnArgs {
  name: string
  agent: string
  prompt: string
  model?: string
  claim_task?: string
  worktree?: boolean
  plan_approval?: boolean
  resume_from?: string
}

interface ResumeContext {
  predecessor: string
  text: string
  truncated: boolean
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

function claimSpawnTask(deps: ToolDeps, teamId: string, taskId: string, assignee: string): void {
  deps.db.transaction(() => {
    const task = deps.db.query("SELECT status, assignee FROM team_task WHERE id = ? AND team_id = ?")
      .get(taskId, teamId) as { status: string; assignee: string | null } | null
    if (!task) throw new Error(`Task "${taskId}" not found`)
    if (task.status === "blocked") throw new Error(`Task "${taskId}" is blocked by unresolved dependencies`)
    if (task.status !== "pending") throw new Error(`Task "${taskId}" is not pending (status: ${task.status})`)
    if (task.assignee) throw new Error(`Task "${taskId}" is already claimed by ${task.assignee}`)

    const result = deps.db.run(
      "UPDATE team_task SET status = 'in_progress', assignee = ?, time_updated = ? WHERE id = ? AND team_id = ? AND status = 'pending' AND assignee IS NULL",
      [assignee, Date.now(), taskId, teamId],
    )
    if (result.changes === 0) {
      throw new Error(`Task "${taskId}" is already claimed (race condition)`)
    }
  })()
}

function rollbackSpawnTask(deps: ToolDeps, teamId: string, taskId: string | undefined, assignee: string): void {
  if (!taskId) return
  deps.db.run(
    "UPDATE team_task SET status = 'pending', assignee = NULL, time_updated = ? WHERE id = ? AND team_id = ? AND status = 'in_progress' AND assignee = ?",
    [Date.now(), taskId, teamId, assignee],
  )
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

  const resumeContext = args.resume_from
    ? await buildResumeContext(deps, teamInfo.teamId, args.resume_from)
    : undefined

  if (args.claim_task) {
    claimSpawnTask(deps, teamInfo.teamId, args.claim_task, args.name)
  }

  const isReadOnly = args.agent === "plan" || args.agent === "explore"
  const useWorktree = args.worktree !== false && !isReadOnly && !isWorktreeDirectory(deps.directory)
  const usePlanApproval = args.plan_approval === true

  log(`spawn:start name=${args.name} agent=${args.agent} worktree=${useWorktree}`)

  // Create worktree if enabled
  let worktreeDir: string | null = null
  let worktreeBranch: string | null = null

  if (useWorktree) {
    const resource = getTeamResourceParts(deps.db, teamInfo.teamId)
    const worktreeName = teamWorktreeName(resource.projectName, resource.teamName, resource.teamId, args.name)
    try {
      log(`spawn:worktree:start name=${args.name}`)
      const result = await withTimeout(
        deps.client.worktree.create({ worktreeCreateInput: { name: worktreeName } }),
        getSpawnTimeout(), `worktree.create for "${args.name}"`
      )
      if (result.data) {
        worktreeDir = result.data.directory
        worktreeBranch = result.data.branch
      }
      log(`spawn:worktree:done name=${args.name} dir=${worktreeDir}`)
    } catch (err) {
      log(`spawn:worktree:failed name=${args.name} err=${err instanceof Error ? err.message : String(err)}`)
      try {
        await deps.client.tui.showToast({
          title: "Team",
          message: `Worktree creation failed for ${args.name}, using shared directory`,
          variant: "warning",
          duration: 4000,
        })
      } catch { /* TUI may not be available */ }
    }
  }

  // Create workspace from worktree branch — links session to worktree directory.
  // OQ-workspace: assumes workspace.create({ branch }) auto-links to the worktree at that branch.
  let workspaceId: string | null = null
  if (worktreeDir && worktreeBranch) {
    try {
      log(`spawn:workspace:start name=${args.name}`)
      const wsResult = await withTimeout(
        deps.client.workspace.create({ branch: worktreeBranch }),
        getSpawnTimeout(), `workspace.create for "${args.name}"`
      )
      if (wsResult.data) {
        workspaceId = wsResult.data.id
      }
      log(`spawn:workspace:done name=${args.name} id=${workspaceId}`)
    } catch (err) {
      log(`spawn:workspace:failed name=${args.name} err=${err instanceof Error ? err.message : String(err)}`)
      // Non-fatal — prompt-based CWD instruction is the fallback
    }
  }

  // Permission rules on session.create are the hard gate (server-enforced).
  // For read-only agents, deny write tools and explicitly allow team tools.
  // For all agents with worktrees, allowlist the worktree path for edit/bash.
  const TEAM_TOOLS = ["team_message", "team_broadcast", "team_tasks_list", "team_tasks_add", "team_tasks_complete", "team_claim"] as const
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
    )
  }

  permission.push(
    ...TEAM_TOOLS.map(t => ({ permission: t, pattern: "*", action: "allow" as const })),
  )

  // Create child session — bind to workspace if available (server-enforced CWD isolation).
  // Falls back to no workspace binding if workspace.create failed.
  let childSessionId: string | undefined
  try {
    log(`spawn:session:start name=${args.name}`)
    const createResult = await withTimeout(
      deps.client.session.create({
        parentID: sessionId,
        title: `${args.name} (@${args.agent} teammate)`,
        permission,
        ...(workspaceId ? { workspaceID: workspaceId } : {}),
      }),
      getSpawnTimeout(), `session.create for "${args.name}"`
    )
    childSessionId = createResult.data?.id
    log(`spawn:session:done name=${args.name} sessionId=${childSessionId}`)
  } catch (err) {
    log(`spawn:session:failed name=${args.name} err=${err instanceof Error ? err.message : String(err)}`)
    // Track failure for circuit breaker
    const errMsg = err instanceof Error ? err.message : String(err)
    const prev = spawnFailures.get(teamInfo.teamId)
    spawnFailures.set(teamInfo.teamId, { count: (prev?.count ?? 0) + 1, lastError: errMsg })
    // Rollback workspace and worktree if session creation failed
    if (workspaceId) {
      try { await deps.client.workspace.remove({ id: workspaceId }) } catch { /* best effort */ }
    }
    if (worktreeDir) {
      try { await deps.client.worktree.remove({ worktreeRemoveInput: { directory: worktreeDir } }) } catch { /* best effort */ }
    }
    rollbackSpawnTask(deps, teamInfo.teamId, args.claim_task, args.name)
    throw new Error(`Failed to create session for teammate "${args.name}": ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!childSessionId) {
    if (workspaceId) {
      try { await deps.client.workspace.remove({ id: workspaceId }) } catch { /* best effort */ }
    }
    if (worktreeDir) {
      try { await deps.client.worktree.remove({ worktreeRemoveInput: { directory: worktreeDir } }) } catch { /* best effort */ }
    }
    rollbackSpawnTask(deps, teamInfo.teamId, args.claim_task, args.name)
    throw new Error("Failed to create teammate session")
  }

  // Register in DB
  const planApproval = usePlanApproval ? "pending" : "none"
  const now = Date.now()
  // Resolve model before DB insert so the stored value matches what promptAsync uses
  const memberCount = (deps.db.query("SELECT COUNT(*) as c FROM team_member WHERE team_id = ?").get(teamInfo.teamId) as { c: number }).c
  const resolvedModel = resolveModel(args.model, args.agent, memberCount, deps.config)
  if (resolvedModel) log(`spawn:model name=${args.name} model=${resolvedModel}`)

  try {
    deps.db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, prompt, worktree_dir, worktree_branch, workspace_id, plan_approval, time_created, time_updated)
       VALUES (?, ?, ?, ?, 'busy', 'starting', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [teamInfo.teamId, args.name, childSessionId, args.agent, resolvedModel ?? null, args.prompt, worktreeDir, worktreeBranch, workspaceId, planApproval, now, now]
    )
  } catch (err) {
    rollbackSpawnTask(deps, teamInfo.teamId, args.claim_task, args.name)
    if (worktreeBranch) {
      const resource = getTeamResourceParts(deps.db, teamInfo.teamId)
      const safeBranch = preservedBranchName(resource.projectName, resource.teamName, resource.teamId, args.name)
      const ok = await preserve(worktreeBranch, safeBranch, deps.directory)
      if (!ok) {
        sendLeadAlert(deps.db, deps.client, {
          teamId: teamInfo.teamId,
          content: `Teammate "${args.name}" could not be registered and branch ${worktreeBranch} could not be preserved. Its session and worktree remain intact for manual recovery. Error: ${err instanceof Error ? err.message : String(err)}.`,
          wakeText: `[System: Teammate ${args.name} registration and branch preservation failed; recovery guidance is available in team messages]`,
        })
        throw new Error(`${err instanceof Error ? err.message : String(err)}. Cleanup stopped because branch ${worktreeBranch} could not be preserved; the session and worktree were left intact for retry.`)
      }
    }
    await deps.client.session.abort({ sessionID: childSessionId }).catch(() => { /* best effort */ })
    if (workspaceId) {
      try { await deps.client.workspace.remove({ id: workspaceId }) } catch { /* best effort */ }
    }
    if (worktreeDir) {
      try { await deps.client.worktree.remove({ worktreeRemoveInput: { directory: worktreeDir } }) } catch { /* best effort */ }
    }
    throw err
  }

  // Register in memory
  deps.registry.register(teamInfo.teamId, args.name, childSessionId)

  // Build teammate context message
  const context = [
    `You are "${args.name}", a teammate in team "${teamInfo.teamName}".`,
    `Your agent type is "${args.agent}".`,
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
      "Read and explore the codebase, then send your implementation plan to the lead via team_message.",
      "Do NOT write or modify any files until the lead approves your plan.",
      "Wait for the lead's approval message before proceeding with implementation.",
    )
  }

  if (isReadOnly) {
    context.push(
      "", "Tools available to you:",
      "- team_message: send a message to the lead or another teammate",
      "- team_broadcast: send a message to all team members",
      "- team_tasks_list: view the shared team task board",
    )
  } else {
    context.push(
      "", "Tools available to you:",
      "- team_message: send a message to the lead or another teammate",
      "- team_broadcast: send a message to all team members",
      "- team_tasks_list: view the shared team task board",
      "- team_tasks_add: add tasks to the shared board",
      "- team_tasks_complete: mark a task complete on the shared board",
      "- team_claim: claim a pending task from the shared board",
    )
  }

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
    context.push("2. If you claimed a task, mark it complete using team_tasks_complete.")
    context.push(
      "3. Send ONE message to the lead using team_message with this format:",
    )
  } else if (!isReadOnly) {
    context.push("1. If you claimed a task, mark it complete using team_tasks_complete.")
    context.push(
      "2. Send ONE message to the lead using team_message with this format:",
    )
  } else {
    context.push(
      "1. Send ONE message to the lead using team_message with this format:",
    )
  }
  context.push(
    "<task-result>",
    "<status>completed or failed</status>",
    "<summary>One-line summary of what you did</summary>",
    "<details>Full findings or changes made</details>",
  )
  if (worktreeBranch) {
    context.push(`<branch>${worktreeBranch}</branch>`)
  }
  context.push("</task-result>")
  const lastStep = !isReadOnly && worktreeBranch ? "4" : !isReadOnly ? "3" : "2"
  context.push(
    `${lastStep}. STOP. Do not send follow-up confirmations, status updates, or 'standing by' messages.`,
    "",
    "If you are blocked:",
    "- Send ONE message to the lead via team_message describing the specific blocker.",
    "- Do NOT attempt workarounds or make assumptions. Wait for the lead's response.",
    "",
    "Your plain text output is NOT visible to the team. You MUST use team_message to communicate.",
  )

  if (resumeContext) {
    context.push(
      "",
      `Resumed context from teammate "${resumeContext.predecessor}" (reference only; your current task follows):`,
      resumeContext.text,
    )
  }

  context.push(
    "",
    "Your task:",
    args.prompt,
  )

  if (args.claim_task) {
    context.push("", `You have been assigned task ${args.claim_task}. Mark it complete when done.`)
  }

  const contextStr = context.join("\n")

  // Model was already resolved before DB insert — just parse for promptAsync
  const modelParam = resolvedModel ? parseModelId(resolvedModel) : undefined
  if (resolvedModel && !modelParam) {
    log(`spawn:model:invalid name=${args.name} model=${resolvedModel} — expected "provider/model" format, falling back to default`)
  }

  // Fire-and-forget: send prompt to teammate session.
  log(`spawn:promptAsync:fire name=${args.name} sessionId=${childSessionId}`)
  deps.client.session.promptAsync({
    sessionID: childSessionId,
    parts: [{ type: "text", text: contextStr }],
    agent: args.agent,
    ...(modelParam ? { model: modelParam } : {}),
  }).catch((err) => {
    const errMsg = err instanceof Error ? err.message : String(err)
    log(`spawn:promptAsync:failed name=${args.name} err=${errMsg} — rolling back`)
    try {
      rollbackSpawnTask(deps, teamInfo.teamId, args.claim_task, args.name)
      const preserveThenAbort = async () => {
        if (worktreeBranch) {
          const resource = getTeamResourceParts(deps.db, teamInfo.teamId)
          const safeBranch = preservedBranchName(resource.projectName, resource.teamName, resource.teamId, args.name)
          const ok = await preserve(worktreeBranch, safeBranch, deps.directory)
          if (!ok) {
            deps.db.run(
              "UPDATE team_member SET status = 'error', execution_status = 'failed', time_updated = ? WHERE team_id = ? AND session_id = ?",
              [Date.now(), teamInfo.teamId, childSessionId],
            )
            sendLeadAlert(deps.db, deps.client, {
              teamId: teamInfo.teamId,
              content: `Teammate "${args.name}" failed to start and branch preservation also failed. Its session and worktree were left intact at ${worktreeBranch} so the work remains retryable. Error: ${errMsg}.`,
              wakeText: `[System: Teammate ${args.name} failed to start and branch preservation failed; recovery guidance is available in team messages]`,
            })
            deps.registry.unregister(childSessionId)
            return
          }
          deps.db.run("UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND session_id = ?",
            [safeBranch, teamInfo.teamId, childSessionId])
        }
        deps.db.run(
          "UPDATE team_member SET status = 'shutdown_requested', time_updated = ? WHERE team_id = ? AND session_id = ?",
          [Date.now(), teamInfo.teamId, childSessionId],
        )
        try {
          await deps.client.session.abort({ sessionID: childSessionId })
        } catch (abortError) {
          const message = abortError instanceof Error ? abortError.message : String(abortError)
          sendLeadAlert(deps.db, deps.client, {
            teamId: teamInfo.teamId,
            content: `Teammate "${args.name}" failed to start and its branch was preserved, but abort failed. Its member record remains shutdown_requested for retry. Error: ${message}.`,
            wakeText: `[System: Teammate ${args.name} failed to start and could not be aborted; recovery guidance is available in team messages]`,
          })
          deps.registry.unregister(childSessionId)
          return
        }
        if (workspaceId) await deps.client.workspace.remove({ id: workspaceId })
        if (worktreeDir) await deps.client.worktree.remove({ worktreeRemoveInput: { directory: worktreeDir } })
        deps.db.run("DELETE FROM team_member WHERE team_id = ? AND session_id = ?", [teamInfo.teamId, childSessionId])
        deps.registry.unregister(childSessionId)
        const modelInfo = resolvedModel ? ` (model: ${resolvedModel})` : ""
        sendLeadAlert(deps.db, deps.client, {
          teamId: teamInfo.teamId,
          content: `Teammate "${args.name}" failed to start and was removed${modelInfo}. Error: ${errMsg}. You may retry the spawn.`,
          wakeText: `[System: Teammate ${args.name} failed to start; guidance is available in team messages]`,
        })
      }
      preserveThenAbort().catch(() => { /* best effort */ })
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
  return `Teammate "${args.name}" spawned (agent: ${args.agent}${resumeInfo})${branchInfo}${planInfo}. They are working on: ${args.prompt.slice(0, 120)}${args.prompt.length > 120 ? "..." : ""}`
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
  if (utf8Length(fullContext) <= RESUME_CONTEXT_BYTE_LIMIT) {
    return { predecessor: predecessorName, text: fullContext, truncated: false }
  }

  const marker = "\n\n[... predecessor context truncated ...]\n\n"
  const available = RESUME_CONTEXT_BYTE_LIMIT - utf8Length(marker)
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
