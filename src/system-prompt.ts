import type { Database } from "./db"
import { markDelivered } from "./messaging"
import { parseTaskResult, formatTaskResult } from "./result-parser"
import type { EnsembleConfig } from "./config"
import { projectStructuredResults } from "./structured-result-projection"

/** Truncate a string to maxLen chars, appending "..." if truncated. */
function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s
}

/** Status display mapping from DB status to human-readable label. */
const STATUS_DISPLAY: Record<string, string> = {
  busy: "working",
  ready: "idle",
  shutdown_requested: "shutting down",
  shutdown: "shut down",
  error: "error",
}

const LEAD_IDLE_TURN_GUIDANCE = [
  "After dispatching asynchronous work, end the current turn.",
  "Use team_status or team_tasks_list only for a user-requested snapshot or a concrete stall or recovery check.",
  "Follow up only when new information arrives or an identified blocker or stall requires recovery.",
]

/**
 * Build the system prompt injected into the lead's session.
 * Includes team name, member statuses, task counts, and anti-polling guidance.
 */
export function buildLeadSystemPrompt(db: Database, teamId: string, config?: Required<EnsembleConfig>): string {
  const team = db.query("SELECT name, current_phase FROM team WHERE id = ?").get(teamId) as { name: string; current_phase: string | null } | null
  if (!team) return ""

  const members = db.query("SELECT name, status FROM team_member WHERE team_id = ?").all(teamId) as Array<{ name: string; status: string }>

  const taskCounts = db.query(
    "SELECT status, COUNT(*) as count FROM team_task WHERE team_id = ? GROUP BY status",
  ).all(teamId) as Array<{ status: string; count: number }>

  const countMap: Record<string, number> = {}
  for (const row of taskCounts) {
    countMap[row.status] = row.count
  }

  const completed = countMap.completed ?? 0
  const inProgress = countMap.in_progress ?? 0
  const pending = countMap.pending ?? 0

  const memberList = members
    .map((m) => `${m.name} [${STATUS_DISPLAY[m.status] ?? m.status}]`)
    .join(", ")

  const teammateLine = members.length > 0
    ? `Teammates: ${memberList}`
    : "Teammates: none"

  const pendingMessages = db.query(
    "SELECT id, from_name, content FROM team_message WHERE team_id = ? AND to_name = 'lead' AND delivered = 0 AND delivery_claimed_at IS NULL ORDER BY time_created ASC"
  ).all(teamId) as Array<{ id: string; from_name: string; content: string }>

  const lines = [
    `You are leading team "${team.name}" with ${members.length} active teammates.`,
    teammateLine,
    `Tasks: ${completed} completed, ${inProgress} in progress, ${pending} pending`,
  ]
  if (team.current_phase) lines.push(`Current phase: ${team.current_phase}`)

  const leadBrief = buildRollingLeadBrief(db, teamId)
  if (leadBrief) lines.push("", "--- Lead Brief ---", leadBrief, "--- End Lead Brief ---")

  // Inline active and recently completed tasks
  const activeTasks = db.query(
    "SELECT content, assignee FROM team_task WHERE team_id = ? AND status = 'in_progress' ORDER BY time_updated DESC LIMIT 5"
  ).all(teamId) as Array<{ content: string; assignee: string | null }>

  const recentCompleted = db.query(
    "SELECT content, assignee FROM team_task WHERE team_id = ? AND status = 'completed' ORDER BY time_updated DESC LIMIT 3"
  ).all(teamId) as Array<{ content: string; assignee: string | null }>

  if (activeTasks.length > 0) {
    lines.push("Active tasks:")
    for (const t of activeTasks) {
      lines.push(`  [in_progress] ${truncate(t.content, 120)}${t.assignee ? ` → ${t.assignee}` : ""}`)
    }
  }
  if (recentCompleted.length > 0) {
    lines.push("Recently completed:")
    for (const t of recentCompleted) {
      lines.push(`  [completed] ${truncate(t.content, 120)}${t.assignee ? ` → ${t.assignee}` : ""}`)
    }
  }

  if (pendingMessages.length > 0) {
    lines.push("", "--- Team Messages ---")
    for (const msg of pendingMessages) {
      const parsed = parseTaskResult(msg.content)
      if (parsed) {
        lines.push(formatTaskResult(msg.from_name, parsed))
      } else {
        lines.push(`[From ${msg.from_name}]: ${msg.content}`)
      }
      markDelivered(db, msg.id)
    }
    lines.push("--- End Messages ---")
  }

  // Model selection guidance (only when promptForModels is enabled)
  if (config?.promptForModels) {
    const poolOptions = (config.modelPool && config.modelPool.length > 0)
      ? config.modelPool.map(m => `      { label: "${m}", description: "" }`).join(",\n")
      : ""
    lines.push(
      "",
      "MODEL SELECTION:",
      "Before spawning teammates, use the question tool to ask the user about model preferences.",
      "Do NOT spawn any agents until the user confirms their model preference.",
      "Keep descriptions simple and clear — explain what each option means in plain language.",
      "Example question tool call:",
      '  question({ questions: [{ question: "Which AI models should your team agents use?", header: "Agent models", options: [',
      '    { label: "Same as me (Recommended)", description: "Every agent uses the same model I\'m running on. Simplest option — no extra setup needed." },',
      '    { label: "Mix of models", description: "Each agent gets a different model from your configured pool. Useful for getting diverse perspectives on the same problem." },',
      '    { label: "I\'ll choose per agent", description: "You pick the exact model for each agent as I spawn them. Most control, but requires a choice per agent." }',
      "  ]}]})",
    )
    if (poolOptions) {
      lines.push(
        'If user picks "Mix of models", ask which models with multiple: true:',
        "  question({ questions: [{ question: \"Which models should agents rotate through? Pick all that apply.\", header: \"Model pool\", multiple: true, options: [",
        poolOptions,
        "  ]}]})",
      )
    }
    lines.push(
      'If user picks "I\'ll choose per agent", ask for each agent\'s model individually before each team_spawn call.',
      "Pass the chosen model via the model parameter on each team_spawn call.",
    )
  }

  lines.push(
    "",
    "METRICS:",
    "Use team_metrics for bounded, privacy-safe telemetry aggregates. Leads may query Teams in this project, including archived Teams; teammates may query only their own Team.",
    "Use summary or funnel first. Timeline requires explicit authorized team_ids (at most 10) and returns only allowlisted enum, boolean, number, and opaque IDs. Metrics never expose prompts, messages, paths, sessions, branches, raw payloads, or free text.",
    "Treat unsupported quality, causal, active-time, and cost-per-success metrics as unavailable; do not infer them from task or archive state.",
    "",
    "Spawn only tasks in the ready frontier: pending tasks whose dependencies are complete.",
    "Independent read-only worktree:false spawns may run concurrently when the tool caller supports parallel calls.",
    "Create writer worktrees one at a time and wait for each team_spawn result before creating the next; created writers may execute concurrently.",
    "For every writer, keep the default worktree:true. Pass worktree:false only for intentionally read-only work; a requested writer worktree failure cancels the spawn instead of falling back to the shared directory.",
    "Read-only agents (explore, plan) automatically skip worktree creation. For other read-only agents, pass worktree: false.",
    "",
    "Teammates work asynchronously and message you when done.",
    ...LEAD_IDLE_TURN_GUIDANCE,
    "Reuse this Team across research, implementation, review, verification, and recovery phases. Add tasks and teammates instead of creating a new Team for each phase.",
    "Use team_spawn with resume_from when replacing a failed teammate so the fresh session receives bounded predecessor context.",
    "After spawning all teammates, tell the user what you've set up, then end the current turn.",
    "When all teammates finish, summarize results and suggest next steps.",
    "",
    "MERGE WORKFLOW:",
    "After a teammate finishes and you shut them down, use team_merge to merge their branch.",
    "Do NOT tell teammates to commit — they handle that themselves.",
    "Do NOT run git merge manually — use team_merge which squash-merges and unstages for you.",
    "team_cleanup will refuse to archive while any writer branch is unmerged or has an interrupted merge.",
    "",
    "Before calling team_cleanup, verify teammates have committed their work.",
    "team_shutdown will warn you if a teammate has uncommitted changes.",
    "team_cleanup will block if any worktree has uncommitted changes — merge or commit first.",
    "To permanently delete archived teams, call team_cleanup with purge: [\"team-name\"] or purge: [\"*\"] for all archived teams.",
    "The first purge call is preview-only and deletes nothing.",
    "Use the question tool to ask the user for visible human approval before deleting archived team records or preserved Ensemble branches.",
    "The question must include the exact approval and denial option labels shown in the preview.",
    "Only if the user selects that exact approval option, call team_cleanup again with the same purge value, confirm_purge: true, and the confirm_token from the preview.",
  )

  return lines.join("\n")
}

/**
 * Build the system prompt injected into a teammate's session.
 * Includes role reminder and delivers any pending peer messages.
 */
export function buildTeammateSystemPrompt(db: Database, teamId: string, memberName: string): string {
  const team = db.query("SELECT name FROM team WHERE id = ?").get(teamId) as { name: string } | null
  if (!team) return ""

  const consultation = db.query(
    "SELECT consult_id, consult_state, consult_task_id, consult_planner, consult_question, consult_reply FROM team_member WHERE team_id = ? AND name = ?",
  ).get(teamId, memberName) as {
    consult_id: string | null
    consult_state: string
    consult_task_id: string | null
    consult_planner: string | null
    consult_question: string | null
    consult_reply: string | null
  } | null
  const lines = [
    `You are "${memberName}", a teammate in team "${team.name}". Use team_message to communicate. You MUST send your results to the lead via team_message before stopping.`,
  ]
  if (consultation?.consult_state === "waiting" || consultation?.consult_state === "escalated") {
    lines.push(
      `Consultation ${consultation.consult_id} for task ${consultation.consult_task_id} is ${consultation.consult_state}.`,
      `Question: ${consultation.consult_question}`,
      `Planner: ${consultation.consult_planner}`,
      "Pause only this affected task boundary. Do not guess or replay side effects while waiting.",
    )
  }
  if (consultation?.consult_state === "answered") {
    lines.push(
      `Consultation ${consultation.consult_id} for task ${consultation.consult_task_id} was answered by ${consultation.consult_planner}.`,
      `Technical reply: ${consultation.consult_reply}`,
      "Verify the current source state, then resume the affected boundary.",
    )
  }

  // Deliver pending peer messages addressed to this teammate
  const pendingMessages = db.query(
    "SELECT id, from_name, content FROM team_message WHERE team_id = ? AND to_name = ? AND delivered = 0 AND delivery_claimed_at IS NULL ORDER BY time_created ASC"
  ).all(teamId, memberName) as Array<{ id: string; from_name: string; content: string }>

  if (pendingMessages.length > 0) {
    lines.push("", "--- Messages for you ---")
    for (const msg of pendingMessages) {
      const parsed = parseTaskResult(msg.content)
      if (parsed) {
        lines.push(formatTaskResult(msg.from_name, parsed))
      } else {
        lines.push(`[From ${msg.from_name}]: ${msg.content}`)
      }
      markDelivered(db, msg.id)
    }
    lines.push("--- End Messages ---")
  }

  return lines.join("\n")
}

/**
 * Build a concise context string for compaction.
 * Includes team name, member statuses, task progress, and role statement.
 */
export function buildTeamCompactionContext(
  db: Database,
  teamId: string,
  role: "lead" | "member",
  memberName?: string,
): string {
  const team = db.query("SELECT name FROM team WHERE id = ?").get(teamId) as { name: string } | null
  if (!team) return ""

  const members = db.query("SELECT name, status FROM team_member WHERE team_id = ?").all(teamId) as Array<{ name: string; status: string }>

  const taskCounts = db.query(
    "SELECT status, COUNT(*) as count FROM team_task WHERE team_id = ? GROUP BY status",
  ).all(teamId) as Array<{ status: string; count: number }>

  const countMap: Record<string, number> = {}
  for (const row of taskCounts) {
    countMap[row.status] = row.count
  }

  const completed = countMap.completed ?? 0
  const inProgress = countMap.in_progress ?? 0
  const pending = countMap.pending ?? 0

  const roleLine = role === "lead"
    ? `[Team Context] You are the lead of team "${team.name}".`
    : `[Team Context] You are a teammate named "${memberName}" in team "${team.name}".`

  const memberList = members
    .map((m) => `${m.name} (${STATUS_DISPLAY[m.status] ?? m.status})`)
    .join(", ")

  const membersLine = members.length > 0
    ? `Members: ${memberList}`
    : "Members: none"

  const lines = [
    roleLine,
    membersLine,
    `Tasks: ${completed} completed, ${inProgress} in progress, ${pending} pending`,
  ]

  if (role === "member" && memberName) {
    lines.push("IMPORTANT: You MUST send your results to the lead via team_message before stopping.")

    // Include original task prompt
    const member = db.query("SELECT prompt FROM team_member WHERE team_id = ? AND name = ?")
      .get(teamId, memberName) as { prompt: string | null } | null
    if (member?.prompt) {
      lines.push(`Your original task: ${truncate(member.prompt, 300)}`)
    }

    // Include recent messages involving this member
    const recentMsgs = db.query(
      "SELECT from_name, content FROM team_message WHERE team_id = ? AND (from_name = ? OR to_name = ?) ORDER BY time_created DESC LIMIT 3"
    ).all(teamId, memberName, memberName) as Array<{ from_name: string; content: string }>
    if (recentMsgs.length > 0) {
      lines.push("Recent context:")
      for (const msg of recentMsgs) {
        lines.push(`  [${msg.from_name}]: ${truncate(msg.content, 200)}`)
      }
    }
  } else if (role === "member") {
    lines.push("IMPORTANT: You MUST send your results to the lead via team_message before stopping.")
  }

  if (role === "lead") {
    lines.push(...LEAD_IDLE_TURN_GUIDANCE)
    const brief = buildRollingLeadBrief(db, teamId)
    if (brief) lines.push("Lead Brief:", brief)
    // Include recently completed tasks
    const completedTasks = db.query(
      "SELECT content, assignee FROM team_task WHERE team_id = ? AND status = 'completed' ORDER BY time_updated DESC LIMIT 5"
    ).all(teamId) as Array<{ content: string; assignee: string | null }>
    if (completedTasks.length > 0) {
      lines.push("Recently completed:")
      for (const t of completedTasks) {
        lines.push(`  [completed] ${truncate(t.content, 120)}${t.assignee ? ` (by ${t.assignee})` : ""}`)
      }
    }
  }

  return lines.join("\n")
}

/** Build and persist a bounded deterministic summary for the Team Lead. */
export function buildRollingLeadBrief(db: Database, teamId: string): string {
  const team = db.query("SELECT current_phase FROM team WHERE id = ?").get(teamId) as { current_phase: string | null } | null
  if (!team) return ""
  const lines = [`Phase: ${team.current_phase ?? "unspecified"}`]
  const active = db.query(
    "SELECT id, content, assignee FROM team_task WHERE team_id = ? AND status = 'in_progress' ORDER BY time_updated DESC LIMIT 8",
  ).all(teamId) as Array<{ id: string; content: string; assignee: string | null }>
  if (active.length > 0) {
    lines.push("Active work:")
    active.forEach(task => {
      lines.push(`- ${task.id}: ${truncate(task.content, 160)}${task.assignee ? ` (${task.assignee})` : ""}`)
    })
  }
  const messages = db.query(
    "SELECT id, from_name, content, time_created FROM team_message WHERE team_id = ? AND to_name = 'lead' AND content LIKE '%<task-result>%' ORDER BY time_created DESC, id DESC LIMIT 100",
  ).all(teamId) as Array<{ id: string; from_name: string; content: string; time_created: number }>
  const tasks = db.query(
    "SELECT id, status FROM team_task WHERE team_id = ?",
  ).all(teamId) as Array<{ id: string; status: string }>
  const projected = projectStructuredResults(
    messages.map(message => ({
      id: message.id,
      fromName: message.from_name,
      content: message.content,
      timeCreated: message.time_created,
    })),
    tasks,
  )
  const blockers = projected
    .filter(item => item.result.kind === "blocker")
    .slice(0, 8)
    .map(item => `- ${item.result.taskId ?? item.fromName}: ${truncate(item.result.summary, 160)}`)
  if (blockers.length > 0) {
    lines.push("Blockers:")
    lines.push(...blockers)
  }
  const summaries = projected.toReversed().map(item =>
    `- [${item.result.kind}] ${item.fromName}${item.result.taskId ? `/${item.result.taskId}` : ""}: ${truncate(item.result.summary, 240)}`
  )
  if (summaries.length > 0) lines.push("Latest summaries:", ...summaries)
  const brief = truncateUtf8(lines.join("\n"), 8 * 1024)
  db.run("UPDATE team SET lead_brief = ?, lead_brief_updated_at = ? WHERE id = ?", [brief, Date.now(), teamId])
  return brief
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value)
  if (bytes.length <= maxBytes) return value
  const decoder = new TextDecoder("utf-8", { fatal: true })
  for (let end = maxBytes - 3; end >= 0; end--) {
    try {
      return `${decoder.decode(bytes.slice(0, end))}...`
    } catch {
      // Move to the previous UTF-8 boundary.
    }
  }
  return "..."
}
