import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"
import { parseTaskResult, formatTaskResult } from "../result-parser"
import { immediateTransaction } from "../db"

/** Row shape for unread messages query. */
interface UnreadMessageRow {
  id: string
  from_name: string
  content: string
  time_created: number
}

/**
 * Retrieve unread messages from the team message store.
 * Optionally filter by sender name. Marks returned messages as read.
 */
export async function executeTeamResults(
  deps: ToolDeps,
  args: { from?: string; message_id?: string },
  sessionId: string,
): Promise<string> {
  const team = requireTeamMember(deps, sessionId)
  const recipient = team.role === "lead" ? "lead" : team.memberName
  if (!recipient) return "No unread messages."

  const rows = immediateTransaction(deps.db, () => {
    const selected = args.message_id
      ? deps.db.query(
          "SELECT id, from_name, content, time_created FROM team_message WHERE id = ? AND team_id = ? AND read = 0 AND to_name = ?",
        ).all(args.message_id, team.teamId, recipient) as UnreadMessageRow[]
      : args.from
        ? deps.db.query(
            "SELECT id, from_name, content, time_created FROM team_message WHERE team_id = ? AND read = 0 AND to_name = ? AND from_name = ? ORDER BY time_created ASC, id ASC LIMIT 20",
          ).all(team.teamId, recipient, args.from) as UnreadMessageRow[]
        : deps.db.query(
            "SELECT id, from_name, content, time_created FROM team_message WHERE team_id = ? AND read = 0 AND to_name = ? ORDER BY time_created ASC, id ASC LIMIT 20",
          ).all(team.teamId, recipient) as UnreadMessageRow[]
    if (selected.length === 0) return selected
    const ids = selected.map(row => row.id)
    const placeholders = ids.map(() => "?").join(", ")
    deps.db.run(`UPDATE team_message SET read = 1 WHERE read = 0 AND id IN (${placeholders})`, ids)
    return selected
  })

  if (rows.length === 0) return "No unread messages."

  // Format output — parse structured task results when present
  const output = rows.map((r) => {
    const parsed = parseTaskResult(r.content)
    if (parsed) return formatTaskResult(r.from_name, parsed)
    return `[Message ${r.id} from ${r.from_name}]:\n${r.content}`
  }).join("\n\n")
  if (args.message_id) return output
  const remaining = deps.db.query(
    "SELECT COUNT(*) AS count FROM team_message WHERE team_id = ? AND read = 0 AND to_name = ?",
  ).get(team.teamId, recipient) as { count: number }
  return remaining.count > 0
    ? `${output}\n\nMore unread messages remain (${remaining.count}). Call team_results again or pass message_id for a specific message.`
    : output
}
