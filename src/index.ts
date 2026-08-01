import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { OpencodeClient } from "@opencode-ai/sdk/v2"
import path from "node:path"
import { mkdirSync } from "node:fs"
import { getDbPath } from "./db"
import { wrapThrowingClient } from "./client"
import { recoverStaleMembers, recoverUndeliveredMessages, recoverOrphanedWorktrees, recoverOrphanedBranches, rehydrateRegistry } from "./recovery"
import { MemberRegistry, DescendantTracker, PendingPurgeApprovals } from "./state"
import { isWorktreeInstance } from "./util"
import { handleSessionStatusEvent, handleSessionCreatedEvent, checkToolIsolation, shouldNudgeIdleMember, handleSessionErrorEvent, RetryTracker, shouldReleaseShutdownTracking } from "./hooks"
import { notifyTeamEvent, notifyWorkingProgress } from "./notify"
import { sendLeadAlert, hasReportedCompletion, flushPendingPeerMessage, releasePendingPeerDelivery, isMemberPromptEligible } from "./messaging"
import { buildLeadSystemPrompt, buildTeammateSystemPrompt, buildTeamCompactionContext } from "./system-prompt"
import { log, initLog } from "./log"
import { findTeamBySession } from "./types"
import { loadConfig } from "./config"
import { ProgressTracker } from "./progress"
import { recordFromV2Event, recordFromToolBefore, recordFromToolAfter } from "./activity"
import { createLocalDisposer, processRuntime, startMainWatchdog } from "./runtime"
import { executeTeamCreate } from "./tools/team-create"
import { executeTeamSpawn } from "./tools/team-spawn"
import { executeTeamMessage } from "./tools/team-message"
import { executeTeamBroadcast } from "./tools/team-broadcast"
import { abortShutdownRequestedMember, executeTeamShutdown } from "./tools/team-shutdown"
import { executeTeamCleanup } from "./tools/team-cleanup"
import { executeTeamMerge } from "./tools/team-merge"
import { executeTeamTasksList } from "./tools/team-tasks-list"
import { executeTeamTasksAdd } from "./tools/team-tasks-add"
import { executeTeamTasksComplete } from "./tools/team-tasks-complete"
import { executeTeamClaim } from "./tools/team-claim"
import { executeTeamResults } from "./tools/team-results"
import { executeTeamStatus } from "./tools/team-status"
import { executeTeamView } from "./tools/team-view"
import { executeTeamConsult } from "./tools/team-consult"
import { executeTeamConsultReply } from "./tools/team-consult-reply"
import { executeTeamMetricsTool } from "./tools/team-metrics"
import type { TeamMetricsRequest } from "./metrics"
import type { ToolDeps, } from "./types"
import { TokenBucket } from "./rate-limit"
import { Watchdog } from "./watchdog"
import { SafeAbortRecovery } from "./safe-abort-recovery"
import { handleRetryStatus } from "./retry-breaker"
import { recordUsageFromV2Event } from "./telemetry"
import { TerminalLivenessGuard } from "./terminal-liveness"

const DEFAULT_RATE_LIMIT_REFILL = 2
const DEFAULT_RATE_LIMIT_INTERVAL_MS = 1000
const DEFAULT_WATCHDOG_CHECK_MS = 60 * 1000 // 60 seconds
/**
 * opencode-ensemble plugin entry point.
 * Enables agent teams: multiple agents running in parallel with
 * peer-to-peer communication, shared task management, and coordinated execution.
 */
const plugin: Plugin = async (input) => {
  // Initialize SQLite database in the global OpenCode config directory.
  const dbPath = getDbPath()
  mkdirSync(path.dirname(dbPath), { recursive: true })
  // Load plugin configuration (global → project → env vars)
  const config = loadConfig(input.directory)

  // Initialize in-memory state
  const registry = new MemberRegistry()
  const tracker = new DescendantTracker()
  const purgeApprovals = new PendingPurgeApprovals()
  const nudgedMembers = new Set<string>()
  const progressTracker = new ProgressTracker()
  const retryTracker = new RetryTracker({
    fallbackEnabled: Object.values(config.modelFallbackByAgent).some(models => models.length > 0),
    fallbackStartAttempt: config.retryFallbackStartAttempt,
    exhaustionAttempt: config.retryExhaustionAttempt,
  })
  const wakeLeadTimestamps = new Map<string, number>()
  const WAKE_LEAD_COOLDOWN_MS = 5000

  // Extract the working HeyAPI transport from the plugin-provided v1 client and pass it
  // to the v2 OpencodeClient. The plugin framework provides a v1 client which stores its
  // HeyAPI transport as `_client` (underscore). The v2 constructor accepts it as `client`.
  type V2Transport = ConstructorParameters<typeof OpencodeClient>[0] extends { client?: infer C } ? C : never
  const pluginTransport = (input.client as unknown as { _client: V2Transport })._client
  const rawClient = new OpencodeClient({ client: pluginTransport })
  initLog(rawClient)
  const client = wrapThrowingClient(rawClient)
  const mainInstance = !isWorktreeInstance(input.directory)
  const runtime = await processRuntime.acquire({
    dbPath,
    dashboardPort: mainInstance ? config.dashboardPort : undefined,
    dashboardClient: mainInstance ? client : undefined,
  })
  const db = runtime.db
  const activityBuffer = runtime.activityBuffer
  const deps: ToolDeps = { db, registry, tracker, purgeApprovals, client, directory: input.directory, config }
  const wakeFailedMemberLead = (alert: { leadSessionId: string; memberName: string }) => {
    client.session.promptAsync({
      sessionID: alert.leadSessionId,
      parts: [{ type: "text", text: `[System: Teammate ${alert.memberName} failed; recovery guidance is available in team messages]` }],
    }).catch((err) => {
      log(`session-error:wake-lead:failed member=${alert.memberName} err=${err instanceof Error ? err.message : String(err)}`)
    })
  }
  const safeAbortRecovery = new SafeAbortRecovery({ db, registry, client, onTerminal: wakeFailedMemberLead })
  const terminalLiveness = new TerminalLivenessGuard(deps)

  // Recovery only runs for the main project instance — NOT for teammate worktree instances.
  // Worktree instances are created during session.create. Running recovery there makes HTTP
  // calls back to the server, which deadlocks because the server is still handling session.create.
  if (mainInstance) {
    // Always rehydrate the in-memory registry from SQLite. The registry is
    // in-memory only and is wiped on every plugin restart. Without this,
    // teammates from a previous lifetime become invisible — every team_*
    // tool call from them throws "This session is not in a team." This is
    // the bug that surfaced on Desktop, where the Electron sidecar restarts
    // far more often than the CLI.
    const rehydrated = rehydrateRegistry(db, registry)
    if (rehydrated > 0) log(`init:registry:rehydrated members=${rehydrated}`)
    safeAbortRecovery.recoverAfterRestart()
    void runtime
      .recover(path.resolve(input.worktree || input.directory), async (sharedDb) => {
        log("init:recovery:start (main instance)")
        const recovery = await recoverStaleMembers(sharedDb, client, input.directory)
        if (recovery.interrupted > 0) log(`init:recovery:interrupted=${recovery.interrupted}`)
        await Promise.all([
          recoverUndeliveredMessages(sharedDb, client, registry),
          recoverOrphanedWorktrees(sharedDb, client),
          recoverOrphanedBranches(sharedDb, input.directory),
        ])
        log("init:recovery:done")
      })
      .catch((error) => {
        log(`init:recovery:failed err=${error instanceof Error ? error.message : String(error)}`)
      })
  } else {
    log(`init:skip-recovery (worktree instance: ${input.directory})`)
  }

  // Initialize rate limiter — config value already accounts for env var override
  const rateLimiter = new TokenBucket({
    capacity: config.rateLimitCapacity,
    refillRate: DEFAULT_RATE_LIMIT_REFILL,
    refillIntervalMs: DEFAULT_RATE_LIMIT_INTERVAL_MS,
  })

  // Initialize watchdog — config value already accounts for env var override
  const watchdog = startMainWatchdog(mainInstance, () => new Watchdog({
    db,
    client,
    registry,
    ttlMs: config.timeoutMs,
    checkIntervalMs: DEFAULT_WATCHDOG_CHECK_MS,
    progressTracker,
    activityBuffer,
    stallThresholdMs: config.stallThresholdMs,
    stallMinSteps: config.stallMinSteps,
    stallTokenThreshold: config.stallTokenThreshold,
    cwd: input.directory,
    peerMessageLimit: config.peerMessageLimit,
    peerMessageWindowMs: config.peerMessageWindowMs,
  }))
  const dispose = createLocalDisposer(watchdog, runtime)

  return {
    async dispose() {
      safeAbortRecovery.dispose()
      dispose()
    },
    // Event hook — drives state machine transitions + descendant tracking + toasts
    async event({ event }) {
      if (event.type === "session.status") {
        const { sessionID, status } = event.properties
        const statusType = status.type as "idle" | "busy" | "retry"
        const retry = status as { message?: string; attempt?: number }
        if (statusType !== "idle" && await terminalLiveness.handle(sessionID, statusType)) return
        if (statusType === "idle" && safeAbortRecovery.isChecking(sessionID)) {
          safeAbortRecovery.observeMessage(sessionID)
          return
        }
        const retryExhaustion = await handleRetryStatus(
          deps,
          retryTracker,
          sessionID,
          statusType,
          retry.message,
          retry.attempt,
        )
        if (retryExhaustion) log(`retry-breaker:handled member=${retryExhaustion.memberName}`)
        if (statusType !== "idle") releasePendingPeerDelivery(sessionID)
        const transition = handleSessionStatusEvent(db, registry, sessionID, statusType)

        // Fire toast notifications for meaningful transitions
        if (transition) {
          if (transition.to === "shutdown") {
            notifyTeamEvent(client, "shutdown", { memberName: transition.memberName })
          } else if (transition.to === "ready" && transition.from === "busy") {
            notifyTeamEvent(client, "completed", { memberName: transition.memberName })

            // Fast-idle detection: if agent went idle within 15s of spawn with zero messages,
            // the model likely failed silently (auth error, invalid model, etc.)
            const fastIdleKey = `fastidle:${transition.teamId}:${transition.memberName}`
            if (!nudgedMembers.has(fastIdleKey)) {
              const memberInfo = db.query(
                "SELECT time_created, model FROM team_member WHERE team_id = ? AND name = ?"
              ).get(transition.teamId, transition.memberName) as { time_created: number; model: string | null } | null
              if (memberInfo) {
                const spawnAge = Date.now() - memberInfo.time_created
                const msgCount = (db.query(
                  "SELECT COUNT(*) as c FROM team_message WHERE team_id = ? AND from_name = ?"
                ).get(transition.teamId, transition.memberName) as { c: number }).c
                if (spawnAge < 15_000 && msgCount === 0) {
                  nudgedMembers.add(fastIdleKey)
                  const modelInfo = memberInfo.model ? ` (model: ${memberInfo.model})` : ""
                  log(`fast-idle: ${transition.memberName} went idle ${Math.round(spawnAge / 1000)}s after spawn with 0 messages${modelInfo}`)
                  sendLeadAlert(db, client, {
                    teamId: transition.teamId,
                    content: `Warning: Teammate "${transition.memberName}" went idle immediately after spawning with no output${modelInfo}. This usually means the model failed to start (authentication error, invalid model, or provider issue). Check your API key and model configuration, then retry the spawn.`,
                    wakeText: `[System: Teammate ${transition.memberName} went idle without output; guidance is available in team messages]`,
                  })
                  client.tui.showToast({
                    title: "Team",
                    message: `${transition.memberName} failed to produce output${modelInfo}`,
                    variant: "warning",
                    duration: 8000,
                  }).catch(() => { /* TUI may not be available */ })
                }
              }
            }

            // Nudge teammate if they went idle without reporting to the lead (once only)
            // Skip if they already reported completion (issue #3 — prevents re-waking completed teammates)
            const nudgeKey = `${transition.teamId}:${transition.memberName}`
            if (!nudgedMembers.has(nudgeKey) && shouldNudgeIdleMember(db, transition.teamId, transition.memberName) && !hasReportedCompletion(db, transition.teamId, transition.memberName) && isMemberPromptEligible(db, transition.teamId, transition.memberName, ["ready"])) {
              nudgedMembers.add(nudgeKey)
              log(`nudge:idle-without-report name=${transition.memberName}`)
              client.session.promptAsync({
                sessionID,
                parts: [{ type: "text", text: "[System]: You completed your work but did not report results. Send your findings to the lead via team_message now." }],
              }).catch(() => { /* best effort */ })
            }
          } else if (transition.to === "error") {
            notifyTeamEvent(client, "error", { memberName: transition.memberName })
          } else if (transition.to === "busy_while_shutdown" || transition.to === "idle_while_shutdown") {
            const member = deps.db.query(
              "SELECT worktree_branch, worktree_dir, name, team_id FROM team_member WHERE session_id = ?"
            ).get(sessionID) as { worktree_branch: string | null; worktree_dir: string | null; name: string; team_id: string } | null
            if (member) {
              const settled = await abortShutdownRequestedMember(
                deps,
                member.team_id,
                member.name,
                sessionID,
                member.worktree_branch,
                member.worktree_dir,
              )
              if (settled) notifyTeamEvent(client, "shutdown", { memberName: member.name })
            }
          }

          // Show working progress after every transition so the user sees who's still active
          await notifyWorkingProgress(client, db, transition.teamId)
        }

        // Wake the lead when it goes idle and has pending messages.
        // The system prompt transform delivers the actual message content.
        if (statusType === "idle") {
          const team = db.query("SELECT id FROM team WHERE lead_session_id = ? AND status = 'active'").get(sessionID) as { id: string } | null
          if (team) {
            const pending = db.query("SELECT COUNT(*) as c FROM team_message WHERE team_id = ? AND to_name = 'lead' AND delivered = 0").get(team.id) as { c: number }
            const lastWake = wakeLeadTimestamps.get(team.id) ?? 0
            if (pending.c > 0 && Date.now() - lastWake > WAKE_LEAD_COOLDOWN_MS) {
              wakeLeadTimestamps.set(team.id, Date.now())
              log(`wake-lead: ${pending.c} pending messages, sending promptAsync`)
              client.session.promptAsync({
                sessionID,
                parts: [{ type: "text", text: `[System: ${pending.c} new team message(s) available]` }],
              }).catch((err) => {
                log(`wake-lead:failed err=${err instanceof Error ? err.message : String(err)}`)
              })
            }
          }

          // Messages older than 5s missed direct delivery. Claim one atomically so
          // shared directory instances cannot wake the same teammate twice.
          if (flushPendingPeerMessage(db, client, sessionID, Date.now() - 5000)) {
            log(`wake-peer: claimed pending message for session=${sessionID}`)
          }
        }
      }

      if (event.type === "session.created") {
        const info = event.properties.info
        if (info.parentID) {
          handleSessionCreatedEvent(tracker, info.id, info.parentID)
        }
      }

      // Surface teammate session errors as system messages to the lead.
      // Without this, errors during a teammate's prompt loop (auth failure,
      // tool failure, model error, etc.) are invisible to the lead — the
      // teammate just appears stuck.
      if (event.type === "session.error") {
        const props = event.properties as { sessionID?: string; error?: { name?: string; data?: { message?: string } } }
        const eventId = (event as unknown as { id?: string }).id
        retryTracker.observeSessionError(db, props.sessionID)
        if (!safeAbortRecovery.handleSessionError(props.sessionID, props.error, eventId)) {
          const alert = handleSessionErrorEvent(db, registry, props.sessionID, props.error)
          if (alert) wakeFailedMemberLead(alert)
        }
      }

      if (event.type === "message.updated") {
        const info = (event.properties as { info?: { id?: string; sessionID?: string; role?: string } }).info
        if (info?.id && info.sessionID && info.role) {
          retryTracker.observeMessage(info.sessionID, info.id, info.role)
          safeAbortRecovery.observeMessage(info.sessionID)
        }
      }

      // Track per-step output tokens for stall detection
      if (event.type === "message.part.updated") {
        const part = (event.properties as { part?: { type?: string; sessionID?: string; tokens?: { output?: number } } }).part
        if (part?.sessionID) retryTracker.observeOutput(db, part.sessionID, part)
        if (part?.type === "step-finish" && part.sessionID && part.tokens?.output !== undefined) {
          if (registry.getBySession(part.sessionID)) {
            progressTracker.recordStep(part.sessionID, part.tokens.output)
          }
        }
      }

      // Capture activity for dashboard verbose view (best-effort, v2 event types)
      // Only shell and step events are recorded here — tool calls/results are
      // recorded via tool.execute.before/after to avoid duplicate entries.
      recordFromV2Event(
        event as unknown as { type: string; properties: { sessionID?: string; tool?: string; input?: string; content?: string; title?: string; error?: string; command?: string; exitCode?: number; cost?: number; tokens?: { input?: number; output?: number } } },
        registry,
        activityBuffer,
      )
      recordUsageFromV2Event(
        db,
        registry,
        event as unknown as { id?: string; type: string; properties: { sessionID?: string; timestamp?: number; cost?: number; tokens?: { input?: number; output?: number } } },
      )
    },

    // Sub-agent isolation + rate limiting hook
    "tool.execute.before": async (input, _output) => {
      checkToolIsolation(registry, tracker, input.tool, input.sessionID, db)
      // Rate limit team tools that trigger LLM inference
      if (input.tool.startsWith("team_") && input.tool !== "team_metrics") {
        if (!rateLimiter.tryConsume()) {
          await rateLimiter.waitForToken()
        }
      }
      // Record tool call activity for team member sessions
      recordFromToolBefore(input, registry, activityBuffer)
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool === "question") {
        purgeApprovals.recordQuestionAnswer(input.sessionID, output.output, input.args)
      }
      // Record tool result activity for team member sessions
      recordFromToolAfter(input, output, registry, activityBuffer)
    },

    // System prompt injection — keeps lead aware of team state, reminds teammates of role
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      const teamInfo = findTeamBySession(db, registry, input.sessionID)
      if (!teamInfo) return
      log(`system-prompt:transform role=${teamInfo.role} session=${input.sessionID}`)
      const prompt = teamInfo.role === "lead"
        ? buildLeadSystemPrompt(db, teamInfo.teamId, config)
        : buildTeammateSystemPrompt(db, teamInfo.teamId, teamInfo.memberName ?? "unknown")
      log(`system-prompt:injected role=${teamInfo.role} len=${prompt.length}`)
      output.system.push(prompt)
    },

    // Compaction safety — preserves team context when sessions get long
    "experimental.session.compacting": async (input, output) => {
      const teamInfo = findTeamBySession(db, registry, input.sessionID)
      if (!teamInfo) return
      const context = buildTeamCompactionContext(db, teamInfo.teamId, teamInfo.role, teamInfo.memberName)
      output.context.push(context)
    },

    // Team-aware shell environment for scripts and hooks
    "shell.env": async (input, output) => {
      if (!input.sessionID) return
      const teamInfo = findTeamBySession(db, registry, input.sessionID)
      if (!teamInfo) return
      output.env.ENSEMBLE_TEAM = teamInfo.teamName
      output.env.ENSEMBLE_ROLE = teamInfo.role
      if (teamInfo.memberName) {
        output.env.ENSEMBLE_MEMBER = teamInfo.memberName
        const member = db.query("SELECT worktree_branch, worktree_dir FROM team_member WHERE team_id = ? AND name = ?")
          .get(teamInfo.teamId, teamInfo.memberName) as { worktree_branch: string | null; worktree_dir: string | null } | null
        if (member?.worktree_branch) {
          output.env.ENSEMBLE_BRANCH = member.worktree_branch
        }
        if (member?.worktree_dir) {
          output.env.ENSEMBLE_WORKTREE_DIR = member.worktree_dir
        }
      }
    },

    // Register all team tools
    tool: {
      team_create: tool({
        description: "Create a new agent team. You become the team lead. Use this before spawning teammates.",
        args: {
          name: tool.schema.string().describe("Team name (lowercase alphanumeric with hyphens, 1-64 chars)"),
          project_name: tool.schema.string().optional().describe("Project display name for first use of this working directory. Unicode and spaces are allowed; an internal resource slug is generated separately."),
        },
        async execute(args, ctx) {
          const result = await executeTeamCreate(deps, args, ctx.sessionID)
          ctx.metadata({ title: `Created team: ${args.name}` })
          return result
        },
      }),

      team_spawn: tool({
        description: "Spawn a new teammate that works in parallel. The teammate starts immediately with the given prompt. " +
          "Each teammate gets their own git worktree for file isolation. " +
          "Teammates work asynchronously and will message you when done. Do not poll for their status.",
        args: {
          name: tool.schema.string().describe("Teammate name (lowercase alphanumeric with hyphens)"),
          profile: tool.schema.enum(["general", "scout", "researcher", "planner", "frontend", "backend", "platform", "qa", "reviewer"]).optional().describe("Broad capability profile. Use general only when no narrower profile fits."),
          agent: tool.schema.string().optional().describe("Legacy explicit runtime agent. Must match the selected profile when both are provided."),
          prompt: tool.schema.string().describe("Task instructions for the teammate"),
          model: tool.schema.string().optional().describe("Model in provider/model format (optional, uses default)"),
          claim_task: tool.schema.string().optional().describe("Task ID to auto-claim for this teammate (optional)"),
          worktree: tool.schema.boolean().default(true).describe("Create a git worktree for file isolation (default: true, set false for read-only agents)"),
          plan_approval: tool.schema.boolean().default(false).describe("Require teammate to send a plan for approval before writing files (default: false)"),
          resume_from: tool.schema.string().optional().describe("Existing teammate name whose session context should be passed to this new isolated teammate"),
        },
        async execute(args, ctx) {
          const result = await executeTeamSpawn(deps, args, ctx.sessionID)
          ctx.metadata({ title: `Spawned ${args.name} (${args.agent})` })
          return result
        },
      }),

      team_consult: tool({
        description: "Ask a Planner to resolve a technical contract. Only the requesting task boundary waits; unrelated ready work continues.",
        args: {
          task_id: tool.schema.string().describe("In-progress task owned by the requesting teammate"),
          question: tool.schema.string().describe("Technical contract question for the Planner"),
          planner: tool.schema.string().optional().describe("Planner teammate name; defaults to the first active Planner"),
        },
        async execute(args, ctx) {
          const result = await executeTeamConsult(deps, args, ctx.sessionID)
          progressTracker.recordMessage(ctx.sessionID)
          ctx.metadata({ title: `Consult Planner for ${args.task_id}` })
          return result
        },
      }),

      team_consult_reply: tool({
        description: "Reply to a pending technical consultation or escalate a business-level decision to the Lead.",
        args: {
          consult_id: tool.schema.string().describe("Consultation ID from team_consult"),
          reply: tool.schema.string().describe("Technical resolution or escalation summary"),
          escalate_to_lead: tool.schema.boolean().default(false).describe("Keep the requester waiting and escalate the business decision to the Lead"),
        },
        async execute(args, ctx) {
          const result = await executeTeamConsultReply(deps, args, ctx.sessionID)
          progressTracker.recordMessage(ctx.sessionID)
          ctx.metadata({ title: `Reply to ${args.consult_id}` })
          return result
        },
      }),

      team_message: tool({
        description: "Send a message to a specific teammate or to the lead. Use 'lead' to message the team lead.",
        args: {
          to: tool.schema.string().describe("Recipient name ('lead' or teammate name)"),
          text: tool.schema.string().describe("Message content"),
          approve: tool.schema.boolean().optional().describe("Approve a teammate's plan (only when recipient has plan_approval='pending')"),
          reject: tool.schema.string().optional().describe("Reject a teammate's plan with reason (only when recipient has plan_approval='pending')"),
        },
        async execute(args, ctx) {
          const result = await executeTeamMessage(deps, args, ctx.sessionID)
          // Track message activity for stall detection
          progressTracker.recordMessage(ctx.sessionID)
          // Track peer messages for chatty detection
          if (args.to !== "lead") progressTracker.recordPeerMessage(ctx.sessionID)
          ctx.metadata({ title: `Message → ${args.to}` })
          return result
        },
      }),

      team_broadcast: tool({
        description: "Send a message to all teammates and the lead (excluding yourself).",
        args: {
          text: tool.schema.string().describe("Message content"),
        },
        async execute(args, ctx) {
          const result = await executeTeamBroadcast(deps, args, ctx.sessionID)
          // Track broadcast activity for stall detection
          progressTracker.recordMessage(ctx.sessionID)
          ctx.metadata({ title: "Broadcast to team" })
          return result
        },
      }),

      team_tasks_list: tool({
        description: "View the shared team task board. Use this to check task status, not to wait for teammates. Teammates will message you when done.",
        args: {},
        async execute(_args, ctx) {
          const result = await executeTeamTasksList(deps, ctx.sessionID)
          const count = result === "No tasks on the board." ? 0 : result.split("\n").length
          ctx.metadata({ title: count > 0 ? `Task board (${count} tasks)` : "Task board (empty)" })
          return result
        },
      }),

      team_tasks_add: tool({
        description: "Add tasks to the shared team task board so teammates can see what work is available and claim it.",
        args: {
          tasks: tool.schema.array(tool.schema.object({
            content: tool.schema.string().describe("Task description"),
            priority: tool.schema.enum(["high", "medium", "low"]).default("medium").describe("Task priority"),
            key: tool.schema.string().optional().describe("Optional batch-local task key used by depends_on in the same call"),
            depends_on: tool.schema.array(tool.schema.string()).optional().describe("Existing same-Team task IDs or batch-local keys this task depends on"),
            phase: tool.schema.string().optional().describe("Optional workflow phase used to derive the Team's current phase from its active ready frontier"),
          })).describe("Tasks to add"),
        },
        async execute(args, ctx) {
          const result = await executeTeamTasksAdd(deps, args, ctx.sessionID)
          ctx.metadata({ title: `Added ${args.tasks.length} task${args.tasks.length !== 1 ? "s" : ""}` })
          return result
        },
      }),

      team_tasks_complete: tool({
        description: "Mark a task as completed on the shared board. This unblocks dependent tasks. Teammates should include result to atomically report terminal results to the Lead.",
        args: {
          task_id: tool.schema.string().describe("ID of the task to mark complete"),
          result: tool.schema.object({
            summary: tool.schema.string().describe("One-line completion summary"),
            details: tool.schema.string().describe("Full findings or changes made"),
            branch: tool.schema.string().optional().describe("Worktree branch containing the completed work"),
          }).optional().describe("Optional terminal result persisted atomically with task completion"),
        },
        async execute(args, ctx) {
          const result = await executeTeamTasksComplete(deps, args, ctx.sessionID)
          // Track task completion for stall detection
          progressTracker.recordTaskComplete(ctx.sessionID)
          ctx.metadata({ title: `Completed task` })
          return result
        },
      }),

      team_claim: tool({
        description: "Claim a pending task from the shared task list. Only tasks on the ready frontier can be claimed.",
        args: {
          task_id: tool.schema.string().describe("ID of the task to claim"),
        },
        async execute(args, ctx) {
          const result = await executeTeamClaim(deps, args, ctx.sessionID)
          ctx.metadata({ title: `Claimed task` })
          return result
        },
      }),

      team_results: tool({
        description: "Retrieve the complete durable content of unread team messages addressed to you and mark them as read. Use from or message_id to narrow the retrieval.",
        args: {
          from: tool.schema.string().optional().describe("Filter messages by sender name (optional, returns all if omitted)"),
          message_id: tool.schema.string().optional().describe("Retrieve one specific unread message addressed to the caller"),
        },
        async execute(args, ctx) {
          const result = await executeTeamResults(deps, args, ctx.sessionID)
          ctx.metadata({ title: `Results${args.from ? ` from ${args.from}` : ""}` })
          return result
        },
      }),

      team_shutdown: tool({
        description: "Request a teammate to shut down. The teammate finishes current work then stops. " +
          "Pass force: true to abort immediately without waiting.",
        args: {
          member: tool.schema.string().describe("Teammate name to shut down"),
          force: tool.schema.boolean().default(false).describe("Force immediate abort without waiting for current work to finish"),
        },
        async execute(args, ctx) {
          const result = await executeTeamShutdown(deps, args, ctx.sessionID)
          const member = deps.db.query("SELECT session_id, status FROM team_member WHERE name = ?").get(args.member) as { session_id: string; status: string } | null
          if (member && shouldReleaseShutdownTracking(member.status)) {
            progressTracker.remove(member.session_id)
            activityBuffer.remove(member.session_id)
          }
          const hasWarning = result.includes("uncommitted")
          ctx.metadata({ title: hasWarning ? `${args.member} shut down — uncommitted changes` : `${args.member} shut down` })
          return result
        },
      }),

      team_cleanup: tool({
        description: "Clean up the current team, or purge archived teams after human approval. " +
          "Omit purge for normal cleanup. Pass purge with archived team names, or ['*'] for all archived teams. " +
          "First purge call returns a preview, exact approval and denial options, and confirmation token only. " +
          "Archived worktree/workspace references and stale Ensemble-owned branches are shown in the preview and cleaned during confirmed purge. " +
          "Use the question tool with those exact options, then call again with confirm_purge: true and confirm_token only if the user selected the exact approval option.",
        args: {
          force: tool.schema.boolean().default(false).describe("Force cleanup even if members are active (will abort them)"),
          acknowledge_uncommitted: tool.schema.boolean().default(false),
          purge: tool.schema.array(tool.schema.string()).optional().describe("Archived team names to permanently delete, or ['*'] for all archived teams. Requires human approval."),
          confirm_purge: tool.schema.boolean().default(false).describe("Set true only after the user explicitly selects the exact approval option from the purge preview via the question tool."),
          confirm_token: tool.schema.string().optional().describe("Confirmation token from the purge preview. Valid only after the matching exact approval answer is selected in this session."),
        },
        async execute(args, ctx) {
          const approvePurge = args.purge && args.purge.length > 0 && args.confirm_purge
            ? async (preview: string) => {
              await ctx.ask({
                permission: "team_cleanup.purge",
                patterns: args.purge ?? [],
                always: [],
                metadata: {
                  title: "Purge archived teams",
                  preview,
                },
              })
            }
            : undefined
          // Collect member session IDs before cleanup so we can clean up activity buffers after
          const teamInfoForCleanup = findTeamBySession(db, registry, ctx.sessionID)
          const memberSessions = teamInfoForCleanup
            ? (db.query("SELECT session_id FROM team_member WHERE team_id = ?").all(teamInfoForCleanup.teamId) as Array<{ session_id: string }>).map(m => m.session_id)
            : []
          const result = await executeTeamCleanup(deps, args, ctx.sessionID, undefined, undefined, undefined, config.mergeOnCleanup, undefined, approvePurge)
          // Clean up activity buffers for team members after successful cleanup
          if (!result.includes("uncommitted") && !args.purge) {
            for (const sid of memberSessions) activityBuffer.remove(sid)
          }
          const blocked = result.includes("uncommitted")
          const title = args.purge
            ? result.startsWith("No archived teams") ? "No archived teams to purge" : result.startsWith("Purge preview") ? "Purge confirmation required" : "Archived teams purged"
            : blocked ? "Cleanup blocked — uncommitted changes" : "Team cleaned up"
          ctx.metadata({ title })
          return result
        },
      }),

      team_merge: tool({
        description: "Merge a shutdown teammate's branch into the working directory as unstaged changes. " +
          "Use this after team_shutdown to review and integrate a teammate's work. Repeated calls and read-only teammates are safe no-ops. " +
          "The teammate must be shut down first.",
        args: {
          member: tool.schema.string().describe("Teammate name whose branch to merge"),
        },
        async execute(args, ctx) {
          const result = await executeTeamMerge(deps, args, ctx.sessionID)
          const conflict = result.includes("conflict")
          ctx.metadata({ title: conflict ? `Merge conflict: ${args.member}` : `Merged ${args.member}` })
          return result
        },
      }),

      team_status: tool({
        description: "View team members with their current status and agent type. Team leads also see session IDs. " +
          "Use this for a user-requested snapshot or concrete stall/recovery check, not as a polling loop. Includes a task summary.",
        args: {},
        async execute(_args, ctx) {
          const result = await executeTeamStatus(deps, ctx.sessionID)
          const statusMap: Record<string, string> = { busy: "working", ready: "idle", shutdown_requested: "stopping", shutdown: "done", error: "error" }
          const members = deps.db.query("SELECT name, status FROM team_member WHERE team_id IN (SELECT id FROM team WHERE lead_session_id = ? OR id IN (SELECT team_id FROM team_member WHERE session_id = ?))").all(ctx.sessionID, ctx.sessionID) as Array<{ name: string; status: string }>
          const summary = members.map(m => `${m.name}: ${statusMap[m.status] ?? m.status}`).join(", ")
          ctx.metadata({ title: summary || "No teammates" })
          return result
        },
      }),

      team_view: tool({
        description: "Navigate the TUI to a teammate's session so you can see what they are doing. " +
          "Use the session picker (ctrl+p) to return to the lead session.",
        args: {
          member: tool.schema.string().describe("Teammate name to view"),
        },
        async execute(args, ctx) {
          const result = await executeTeamView(deps, args, ctx.sessionID)
          ctx.metadata({ title: `Viewing ${args.member}` })
          return result
        },
      }),

      team_metrics: tool({
        description: "Query bounded, privacy-safe aggregate Team telemetry. Leads may query their project's Teams; members may query only their own Team. Timeline requires explicit team_ids and never returns prompts, messages, paths, sessions, branches, or raw payload text.",
        args: {
          scope: tool.schema.object({
            project: tool.schema.string().optional(),
            team_ids: tool.schema.array(tool.schema.string()).optional(),
          }).optional(),
          window: tool.schema.object({
            from: tool.schema.string().optional(),
            to: tool.schema.string().optional(),
          }).optional(),
          filters: tool.schema.object({
            workflow_kind: tool.schema.array(tool.schema.string()).optional(),
            status: tool.schema.array(tool.schema.string()).optional(),
            profile: tool.schema.array(tool.schema.string()).optional(),
            model: tool.schema.array(tool.schema.string()).optional(),
            mechanism: tool.schema.array(tool.schema.string()).optional(),
            complexity_band: tool.schema.array(tool.schema.string()).optional(),
            instrumentation_version: tool.schema.array(tool.schema.string()).optional(),
          }).optional(),
          view: tool.schema.enum(["summary", "funnel", "timeline", "compare"]),
          metrics: tool.schema.array(tool.schema.string()),
          group_by: tool.schema.enum(["day", "week", "workflow_kind", "profile", "model", "mechanism", "complexity_band"]).optional(),
          compare: tool.schema.object({
            dimension: tool.schema.enum(["execution_mode", "mechanism", "model"]),
            values: tool.schema.array(tool.schema.string()),
          }).optional(),
          limit: tool.schema.number().optional(),
          cursor: tool.schema.string().optional(),
        },
        async execute(args, ctx) {
          const result = executeTeamMetricsTool(deps, args as TeamMetricsRequest, ctx.sessionID)
          ctx.metadata({ title: `Metrics ${args.view}` })
          return result
        },
      }),
    },
  }
}

export default plugin
