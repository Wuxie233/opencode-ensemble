import type { Database } from "./db"
import type { PluginClient } from "./types"
import { log } from "./log"
import { generateId } from "./util"

const MAX_CONTENT_BYTES = 10 * 1024 // 10KB
const pendingPeerDeliveries = new Set<string>()

/** Input for sending a direct message. */
export interface SendMessageInput {
  teamId: string
  from: string
  to: string
  content: string
}

/** Input for broadcasting a message. */
export interface BroadcastMessageInput {
  teamId: string
  from: string
  content: string
}

/** A message row from the database. */
export interface MessageRow {
  id: string
  team_id: string
  from_name: string
  to_name: string | null
  content: string
  delivered: number
  time_created: number
}

/**
 * Insert a direct message into team_message. Returns the message ID.
 * Throws if content exceeds 10KB.
 */
export function sendMessage(db: Database, input: SendMessageInput): string {
  if (new TextEncoder().encode(input.content).length > MAX_CONTENT_BYTES) {
    throw new Error("Message content exceeds 10KB limit")
  }
  const id = generateId("msg")
  db.run(
    "INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?, ?, ?, ?, ?, 0, ?)",
    [id, input.teamId, input.from, input.to, input.content, Date.now()]
  )
  return id
}

/**
 * Insert a broadcast message (to_name = NULL) into team_message. Returns the message ID.
 * Throws if content exceeds 10KB.
 */
export function broadcastMessage(db: Database, input: BroadcastMessageInput): string {
  if (new TextEncoder().encode(input.content).length > MAX_CONTENT_BYTES) {
    throw new Error("Message content exceeds 10KB limit")
  }
  const id = generateId("msg")
  db.run(
    "INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?, ?, ?, NULL, ?, 0, ?)",
    [id, input.teamId, input.from, input.content, Date.now()]
  )
  return id
}

/**
 * Get all undelivered messages for a team.
 */
export function getUndeliveredMessages(db: Database, teamId: string): MessageRow[] {
  return db.query(
    "SELECT * FROM team_message WHERE team_id = ? AND delivered = 0 ORDER BY time_created ASC"
  ).all(teamId) as MessageRow[]
}

/**
 * Mark a message as delivered.
 */
export function markDelivered(db: Database, messageId: string): void {
  db.run("UPDATE team_message SET delivered = 1 WHERE id = ?", [messageId])
}

/** Allow another stale peer message after the recipient starts a new turn. */
export function releasePendingPeerDelivery(sessionId: string): void {
  pendingPeerDeliveries.delete(sessionId)
}

/** Deliver the oldest stale peer message when an eligible teammate goes idle. */
export function flushPendingPeerMessage(
  db: Database,
  client: PluginClient,
  sessionId: string,
  staleBefore: number,
): boolean {
  if (pendingPeerDeliveries.has(sessionId)) return false
  pendingPeerDeliveries.add(sessionId)
  const message = db.query(
    `UPDATE team_message
     SET delivered = 1
     WHERE id = (
       SELECT msg.id
       FROM team_message msg
       JOIN team_member tm ON tm.team_id = msg.team_id AND tm.name = msg.to_name
       JOIN team t ON t.id = tm.team_id
       WHERE tm.session_id = ?
         AND tm.status = 'ready'
         AND tm.reported_to_lead = 0
         AND t.status = 'active'
         AND msg.delivered = 0
         AND msg.time_created < ?
       ORDER BY msg.time_created ASC, msg.id ASC
       LIMIT 1
     )
       AND delivered = 0
     RETURNING *`
  ).get(sessionId, staleBefore) as MessageRow | null
  if (!message) {
    pendingPeerDeliveries.delete(sessionId)
    return false
  }

  client.session.promptAsync({
    sessionID: sessionId,
    parts: [{ type: "text", text: `[Team message from ${message.from_name}]: ${message.content}` }],
  }).catch((err) => {
    try {
      db.run(
        `UPDATE team_message
         SET delivered = 0
         WHERE id = ?
           AND delivered = 1
           AND EXISTS (
             SELECT 1
             FROM team t
             JOIN team_member tm ON tm.team_id = t.id
             WHERE t.id = team_message.team_id
               AND t.status = 'active'
               AND tm.name = team_message.to_name
               AND tm.session_id = ?
               AND tm.status = 'ready'
               AND tm.reported_to_lead = 0
           )`,
        [message.id, sessionId],
      )
      log(`wake-peer:failed message=${message.id} err=${err instanceof Error ? err.message : String(err)}`)
    } finally {
      pendingPeerDeliveries.delete(sessionId)
    }
  })
  return true
}

/**
 * Check if a teammate has reported completion to the lead.
 * Returns true if the reported_to_lead flag is set on the member.
 */
export function hasReportedCompletion(db: Database, teamId: string, memberName: string): boolean {
  const row = db.query(
    "SELECT reported_to_lead FROM team_member WHERE team_id = ? AND name = ?"
  ).get(teamId, memberName) as { reported_to_lead: number } | null
  return row?.reported_to_lead === 1
}
