import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { applyMigrations } from "../src/schema"
import { MemberRegistry, DescendantTracker } from "../src/state"
import { handleSessionStatusEvent, handleSessionCreatedEvent, checkToolIsolation, shouldNudgeIdleMember, handleSessionErrorEvent, RetryTracker, shouldReleaseShutdownTracking } from "../src/hooks"
import { buildLeadSystemPrompt, buildTeammateSystemPrompt, buildTeamCompactionContext } from "../src/system-prompt"
import { findTeamBySession } from "../src/types"
import { sendMessage } from "../src/messaging"

function setupDb(): Database {
  const db = new Database(":memory:")
  db.exec("PRAGMA journal_mode=WAL")
  db.exec("PRAGMA foreign_keys=ON")
  applyMigrations(db)
  return db
}

function insertTeam(db: Database, id: string, name: string, leadSession: string, status = "active") {
  db.run(
    "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, ?, 0, ?, ?)",
    [id, name, leadSession, status, Date.now(), Date.now()]
  )
}

function insertMember(db: Database, teamId: string, name: string, sessionId: string, status: string, execStatus: string) {
  db.run(
    "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, 'build', ?, ?, ?, ?)",
    [teamId, name, sessionId, status, execStatus, Date.now(), Date.now()]
  )
}

describe("handleSessionStatusEvent", () => {
  let db: Database
  let registry: MemberRegistry

  beforeEach(() => {
    db = setupDb()
    registry = new MemberRegistry()
  })

  test("transitions busy member to ready when session becomes idle", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    registry.register("t1", "alice", "sess-1")

    handleSessionStatusEvent(db, registry, "sess-1", "idle")

    const row = db.query("SELECT status, execution_status FROM team_member WHERE session_id = ?").get("sess-1") as Record<string, string>
    expect(row.status).toBe("ready")
    expect(row.execution_status).toBe("idle")
  })

  test("keeps a pending-plan progress report active and incomplete when the session becomes idle", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    db.run("UPDATE team_member SET plan_approval = 'pending' WHERE team_id = ? AND name = ?", ["t1", "alice"])
    sendMessage(db, {
      teamId: "t1",
      from: "alice",
      to: "lead",
      content: "<task-result><kind>progress</kind><status>in_progress</status><summary>Plan ready</summary><details>Awaiting approval before edits.</details></task-result>",
    })
    registry.register("t1", "alice", "sess-1")

    handleSessionStatusEvent(db, registry, "sess-1", "idle")

    expect(db.query(
      "SELECT status, execution_status, plan_approval, reported_to_lead FROM team_member WHERE session_id = ?",
    ).get("sess-1")).toEqual({
      status: "ready",
      execution_status: "idle",
      plan_approval: "pending",
      reported_to_lead: 0,
    })
  })

  test("keeps shutdown_requested member nonterminal when session becomes idle", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "shutdown_requested", "running")
    registry.register("t1", "alice", "sess-1")

    const result = handleSessionStatusEvent(db, registry, "sess-1", "idle")

    const row = db.query("SELECT status, execution_status FROM team_member WHERE session_id = ?").get("sess-1") as Record<string, string>
    expect(row.status).toBe("shutdown_requested")
    expect(row.execution_status).toBe("running")
    expect(result).toBeUndefined()
  })

  test("transitions ready member to busy when session becomes busy", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "ready", "idle")
    registry.register("t1", "alice", "sess-1")

    handleSessionStatusEvent(db, registry, "sess-1", "busy")

    const row = db.query("SELECT status, execution_status FROM team_member WHERE session_id = ?").get("sess-1") as Record<string, string>
    expect(row.status).toBe("busy")
    expect(row.execution_status).toBe("running")
  })

  test("ignores events for unknown sessions", () => {
    handleSessionStatusEvent(db, registry, "unknown-sess", "idle")
    // No error thrown — just a no-op
  })

  test("ignores events for archived teams", () => {
    insertTeam(db, "t1", "my-team", "lead-sess", "archived")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    registry.register("t1", "alice", "sess-1")

    handleSessionStatusEvent(db, registry, "sess-1", "idle")

    const row = db.query("SELECT status FROM team_member WHERE session_id = ?").get("sess-1") as Record<string, string>
    expect(row.status).toBe("busy") // unchanged
  })

  test("returns undefined when team row is missing from DB", () => {
    // Member registered in memory but team row deleted/missing from DB
    registry.register("t1", "alice", "sess-1")

    const result = handleSessionStatusEvent(db, registry, "sess-1", "idle")
    expect(result).toBeUndefined()
  })

  test("returns undefined when member row is missing from DB", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    // Register in memory but don't insert member row into DB
    registry.register("t1", "alice", "sess-1")

    const result = handleSessionStatusEvent(db, registry, "sess-1", "idle")
    expect(result).toBeUndefined()
  })

  test("returns undefined when idle event and member is already ready (no-op)", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "ready", "idle")
    registry.register("t1", "alice", "sess-1")

    const result = handleSessionStatusEvent(db, registry, "sess-1", "idle")
    expect(result).toBeUndefined()

    const row = db.query("SELECT status, execution_status FROM team_member WHERE session_id = ?").get("sess-1") as Record<string, string>
    expect(row.status).toBe("ready")
    expect(row.execution_status).toBe("idle")
  })

  test("keeps error member terminal when later busy and idle events arrive", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "error", "failed")
    registry.register("t1", "alice", "sess-1")

    expect(handleSessionStatusEvent(db, registry, "sess-1", "busy")).toBeUndefined()
    expect(handleSessionStatusEvent(db, registry, "sess-1", "idle")).toBeUndefined()
    const row = db.query("SELECT status, execution_status FROM team_member WHERE session_id = ?").get("sess-1") as Record<string, string>
    expect(row.status).toBe("error")
    expect(row.execution_status).toBe("failed")
  })

  test("ignores busy event when member is shutdown_requested (not ready/error)", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "shutdown_requested", "running")
    registry.register("t1", "alice", "sess-1")

    const result = handleSessionStatusEvent(db, registry, "sess-1", "busy")

    // Should return a transition so the event hook can re-issue abort
    expect(result).toEqual({
      memberName: "alice",
      teamId: "t1",
      from: "shutdown_requested",
      to: "busy_while_shutdown",
    })

    // Status should remain shutdown_requested
    const row = db.query("SELECT status FROM team_member WHERE session_id = ?").get("sess-1") as Record<string, string>
    expect(row.status).toBe("shutdown_requested")
  })

  test("ignores busy event when member is already busy", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    registry.register("t1", "alice", "sess-1")

    const result = handleSessionStatusEvent(db, registry, "sess-1", "busy")
    expect(result).toBeUndefined()
  })

  test("advances a newly spawned busy member from starting to running on its first busy event", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "starting")
    registry.register("t1", "alice", "sess-1")

    const result = handleSessionStatusEvent(db, registry, "sess-1", "busy")

    expect(result).toBeUndefined()
    const row = db.query("SELECT status, execution_status FROM team_member WHERE session_id = ?").get("sess-1") as Record<string, string>
    expect(row.status).toBe("busy")
    expect(row.execution_status).toBe("running")
  })

  test("returns undefined for retry status so short bursts produce no notification", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    registry.register("t1", "alice", "sess-1")

    const result = handleSessionStatusEvent(db, registry, "sess-1", "retry")

    expect(result).toBeUndefined()

    // Status should remain unchanged
    const row = db.query("SELECT status, execution_status FROM team_member WHERE session_id = ?").get("sess-1") as Record<string, string>
    expect(row.status).toBe("busy")
    expect(row.execution_status).toBe("running")
  })

  test("returns StatusTransition on successful idle transition", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    registry.register("t1", "alice", "sess-1")

    const result = handleSessionStatusEvent(db, registry, "sess-1", "idle")

    expect(result).toEqual({
      memberName: "alice",
      teamId: "t1",
      from: "busy",
      to: "ready",
    })
  })

  test("returns StatusTransition on successful busy transition", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "ready", "idle")
    registry.register("t1", "alice", "sess-1")

    const result = handleSessionStatusEvent(db, registry, "sess-1", "busy")

    expect(result).toEqual({
      memberName: "alice",
      teamId: "t1",
      from: "ready",
      to: "busy",
    })
  })

  test("does not report shutdown transition from an idle event alone", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "shutdown_requested", "running")
    registry.register("t1", "alice", "sess-1")

    const result = handleSessionStatusEvent(db, registry, "sess-1", "idle")

    expect(result).toBeUndefined()
  })

  test("returns undefined for unknown sessions", () => {
    const result = handleSessionStatusEvent(db, registry, "unknown-sess", "idle")
    expect(result).toBeUndefined()
  })

  test("returns undefined for archived teams", () => {
    insertTeam(db, "t1", "my-team", "lead-sess", "archived")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    registry.register("t1", "alice", "sess-1")

    const result = handleSessionStatusEvent(db, registry, "sess-1", "idle")
    expect(result).toBeUndefined()
  })
})

describe("shouldReleaseShutdownTracking", () => {
  test("releases tracking only after shutdown is terminal", () => {
    expect(shouldReleaseShutdownTracking("shutdown")).toBe(true)
    expect(shouldReleaseShutdownTracking("shutdown_requested")).toBe(false)
    expect(shouldReleaseShutdownTracking("busy")).toBe(false)
    expect(shouldReleaseShutdownTracking("error")).toBe(false)
  })
})

describe("RetryTracker", () => {
  let db: Database
  let registry: MemberRegistry
  let tracker: RetryTracker

  beforeEach(() => {
    db = setupDb()
    registry = new MemberRegistry()
    tracker = new RetryTracker()
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-1", "busy", "running")
    registry.register("t1", "alice", "sess-1")
  })

  test("returns one circuit-break request on the sixth consecutive retry", () => {
    let warning: ReturnType<RetryTracker["observeStatus"]>
    for (let attempt = 1; attempt <= 8; attempt++) {
      warning = tracker.observeStatus(db, registry, "sess-1", "retry", "rate limited", attempt) ?? warning
      tracker.observeStatus(db, registry, "sess-1", "busy")
    }

    const messages = db.query(
      "SELECT content FROM team_message WHERE team_id = ? AND from_name = 'system' AND to_name = 'lead'",
    ).all("t1") as Array<{ content: string }>
    expect(messages).toHaveLength(0)
    expect(warning).toEqual({
      leadSessionId: "lead-sess",
      memberName: "alice",
      sessionId: "sess-1",
      teamId: "t1",
      reason: "rate limited",
      attempts: 6,
    })
    const member = db.query("SELECT status FROM team_member WHERE session_id = ?").get("sess-1") as { status: string }
    expect(member.status).toBe("busy")
    expect(db.query("SELECT retry_count, retry_tripped, retry_attempts FROM team_member WHERE session_id = ?").get("sess-1"))
      .toEqual({ retry_count: 6, retry_tripped: 1, retry_attempts: "[1,2,3,4,5,6]" })
  })

  test("keeps a tripped sequence permanent across idle and output events", () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      tracker.observeStatus(db, registry, "sess-1", "retry", "rate limited", attempt)
    }

    tracker.observeStatus(db, registry, "sess-1", "idle")
    tracker.observeMessage("sess-1", "assistant-message", "assistant")
    tracker.observeOutput(db, "sess-1", { type: "text", messageID: "assistant-message", text: "late output" })
    tracker.observeSessionError(db, "sess-1")

    expect(db.query("SELECT retry_count, retry_tripped, retry_attempts FROM team_member WHERE session_id = ?").get("sess-1"))
      .toEqual({ retry_count: 6, retry_tripped: 1, retry_attempts: "[1,2,3,4,5,6]" })
  })

  test("keeps counting across retry reasons and busy transitions", () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      tracker.observeStatus(db, registry, "sess-1", "retry", attempt === 3 ? "connection reset" : "rate limited", attempt)
      tracker.observeStatus(db, registry, "sess-1", "busy")
    }

    expect(tracker.observeStatus(db, registry, "sess-1", "retry", "provider overloaded", 6)).toMatchObject({
      reason: "provider overloaded",
      attempts: 6,
    })
  })

  test("resets on idle completion, meaningful assistant output, and terminal errors", () => {
    const retry = (attempt: number) => tracker.observeStatus(db, registry, "sess-1", "retry", "rate limited", attempt)
    for (let attempt = 1; attempt <= 5; attempt++) retry(attempt)
    tracker.observeStatus(db, registry, "sess-1", "idle")
    for (let attempt = 1; attempt <= 5; attempt++) retry(attempt)
    tracker.observeMessage("sess-1", "assistant-message", "assistant")
    tracker.observeOutput(db, "sess-1", { type: "text", messageID: "assistant-message", text: "meaningful progress" })
    for (let attempt = 1; attempt <= 5; attempt++) retry(attempt)
    tracker.observeSessionError(db, "sess-1")
    for (let attempt = 1; attempt <= 5; attempt++) retry(attempt)

    const count = (db.query("SELECT COUNT(*) AS count FROM team_message").get() as { count: number }).count
    expect(count).toBe(0)
  })

  test("does not reset empty-response retries for user text parts", () => {
    for (let index = 0; index < 5; index++) {
      tracker.observeStatus(db, registry, "sess-1", "retry", "Provider returned an empty response", index)
    }
    tracker.observeMessage("sess-1", "user-message", "user")
    tracker.observeOutput(db, "sess-1", { type: "text", messageID: "user-message", text: "incoming instruction" })
    expect(tracker.observeStatus(db, registry, "sess-1", "retry", "Provider returned an empty response", 6))
      .toMatchObject({ attempts: 6 })
  })

  test("ignores duplicate retry events for the same attempt", () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      tracker.observeStatus(db, registry, "sess-1", "retry", "Provider returned an empty response", attempt)
      tracker.observeStatus(db, registry, "sess-1", "retry", "Provider returned an empty response", attempt)
    }
    expect((db.query("SELECT COUNT(*) AS count FROM team_message").get() as { count: number }).count).toBe(0)

    expect(tracker.observeStatus(db, registry, "sess-1", "retry", "Provider returned an empty response", 6))
      .toMatchObject({ attempts: 6 })
  })

  test("ignores non-adjacent duplicate and missing attempt identities", () => {
    for (const attempt of [1, 2, 3, 1, 2, 3]) {
      tracker.observeStatus(db, registry, "sess-1", "retry", "rate limited", attempt)
    }
    for (let index = 0; index < 6; index++) {
      tracker.observeStatus(db, registry, "sess-1", "retry", "rate limited")
    }

    expect((db.query("SELECT COUNT(*) AS count FROM team_message").get() as { count: number }).count).toBe(0)

    for (const attempt of [4, 5]) {
      tracker.observeStatus(db, registry, "sess-1", "retry", "rate limited", attempt)
    }
    expect(tracker.observeStatus(db, registry, "sess-1", "retry", "rate limited", 6))
      .toMatchObject({ attempts: 6 })
  })

  test("does not warn for a short retry burst", () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(tracker.observeStatus(db, registry, "sess-1", "retry", "provider overloaded", attempt)).toBeUndefined()
    }

    expect((db.query("SELECT COUNT(*) AS count FROM team_message").get() as { count: number }).count).toBe(0)
  })

  test("keeps the empty-response reason in the circuit-break request", () => {
    let warning: ReturnType<RetryTracker["observeStatus"]>
    for (let attempt = 1; attempt <= 6; attempt++) {
      warning = tracker.observeStatus(db, registry, "sess-1", "retry", "Provider returned an empty response", attempt) ?? warning
    }

    expect(warning).toMatchObject({ reason: "Provider returned an empty response", attempts: 6 })
  })
})

describe("handleSessionCreatedEvent", () => {
  let tracker: DescendantTracker

  beforeEach(() => {
    tracker = new DescendantTracker()
  })

  test("tracks parent-child relationship when parentID is present", () => {
    handleSessionCreatedEvent(tracker, "child-sess", "parent-sess")
    expect(tracker.getParent("child-sess")).toBe("parent-sess")
  })

  test("does nothing when parentID is undefined", () => {
    handleSessionCreatedEvent(tracker, "child-sess", undefined)
    expect(tracker.getParent("child-sess")).toBeUndefined()
  })
})

describe("checkToolIsolation", () => {
  let registry: MemberRegistry
  let tracker: DescendantTracker

  beforeEach(() => {
    registry = new MemberRegistry()
    tracker = new DescendantTracker()
  })

  test("allows team tools for registered team members", () => {
    registry.register("t1", "alice", "sess-1")
    expect(() => checkToolIsolation(registry, tracker, "team_message", "sess-1")).not.toThrow()
  })

  test("allows team tools for lead sessions (tracked as lead in DB, not in registry)", () => {
    // Lead sessions are not in the member registry — they're the team creator.
    // checkToolIsolation should allow any session that is NOT a descendant of a team member.
    // A lead session has no parent in the tracker, so it won't be blocked.
    expect(() => checkToolIsolation(registry, tracker, "team_create", "lead-sess")).not.toThrow()
  })

  test("blocks team tools for sub-agents (descendants of team members)", () => {
    registry.register("t1", "alice", "sess-1")
    tracker.track("sub-agent-sess", "sess-1")

    // OQ-11: assuming throwing inside tool.execute.before fails the tool call gracefully
    expect(() => checkToolIsolation(registry, tracker, "team_message", "sub-agent-sess"))
      .toThrow("Team tools are not available to sub-agents")
  })

  test("blocks team tools for deep descendants", () => {
    registry.register("t1", "alice", "sess-1")
    tracker.track("child", "sess-1")
    tracker.track("grandchild", "child")

    expect(() => checkToolIsolation(registry, tracker, "team_broadcast", "grandchild"))
      .toThrow("Team tools are not available to sub-agents")
  })

  test("allows non-team tools for any session", () => {
    registry.register("t1", "alice", "sess-1")
    tracker.track("sub-agent-sess", "sess-1")

    // Non-team tools (like "bash", "read", etc.) should never be blocked
    expect(() => checkToolIsolation(registry, tracker, "bash", "sub-agent-sess")).not.toThrow()
    expect(() => checkToolIsolation(registry, tracker, "read", "sub-agent-sess")).not.toThrow()
  })

  test("allows team tools for unrelated session when registry has members", () => {
    // Registry has a member, but the calling session is neither that member
    // nor a descendant — e.g. the lead session or another unrelated session
    registry.register("t1", "alice", "sess-1")

    expect(() => checkToolIsolation(registry, tracker, "team_create", "lead-sess")).not.toThrow()
    expect(() => checkToolIsolation(registry, tracker, "team_spawn", "other-sess")).not.toThrow()
  })

  test("allows team tools when registry is empty (no team members yet)", () => {
    // Before any teammates are spawned, any session should be able to call team tools
    expect(() => checkToolIsolation(registry, tracker, "team_create", "any-sess")).not.toThrow()
  })

  test("blocks all team tool variants for sub-agents", () => {
    registry.register("t1", "alice", "sess-1")
    tracker.track("sub-agent", "sess-1")

    // Every team_* tool should be blocked for sub-agents
    const teamTools = [
      "team_create", "team_spawn", "team_message", "team_broadcast",
      "team_tasks_list", "team_tasks_add", "team_tasks_complete",
      "team_claim", "team_approve_plan", "team_shutdown", "team_cleanup",
      "team_status", "team_view",
    ]
    for (const tool of teamTools) {
      expect(() => checkToolIsolation(registry, tracker, tool, "sub-agent"))
        .toThrow("Team tools are not available to sub-agents")
    }
  })

  test("allows tools with 'team' in name but not starting with 'team_'", () => {
    registry.register("t1", "alice", "sess-1")
    tracker.track("sub-agent", "sess-1")

    // A tool named "my_team_helper" should not be blocked — only "team_*" prefix matters
    expect(() => checkToolIsolation(registry, tracker, "my_team_helper", "sub-agent")).not.toThrow()
  })
})

// --- Hook integration tests ---
// These test the logic that the hooks in index.ts wire together:
// findTeamBySession → buildLeadSystemPrompt / buildTeammateSystemPrompt / buildTeamCompactionContext

describe("experimental.chat.system.transform logic", () => {
  let db: Database
  let registry: MemberRegistry

  beforeEach(() => {
    db = setupDb()
    registry = new MemberRegistry()
  })

  test("injects lead system prompt for lead session", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "alice-sess", "busy", "running")
    registry.register("t1", "alice", "alice-sess")

    const teamInfo = findTeamBySession(db, registry, "lead-sess")
    expect(teamInfo).toBeTruthy()
    expect(teamInfo!.role).toBe("lead")

    const prompt = buildLeadSystemPrompt(db, teamInfo!.teamId)
    expect(prompt).toContain("leading team")
    expect(prompt).toContain("my-team")
    expect(prompt).toContain("alice")
    expect(prompt).toContain("end the current turn")
    expect(prompt).toContain("user-requested snapshot")
    expect(prompt).toContain("new information arrives")
    expect(prompt).not.toContain("wait for messages")
    expect(prompt).not.toContain("tell the user what you've set up and wait")
  })

  test("injects teammate system prompt for member session", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "alice-sess", "busy", "running")
    registry.register("t1", "alice", "alice-sess")

    const teamInfo = findTeamBySession(db, registry, "alice-sess")
    expect(teamInfo).toBeTruthy()
    expect(teamInfo!.role).toBe("member")

    const prompt = buildTeammateSystemPrompt(db, teamInfo!.teamId, teamInfo!.memberName!)
    expect(prompt).toContain("alice")
    expect(prompt).toContain("my-team")
    expect(prompt).toContain("team_message")
  })

  test("returns undefined for non-team session (no injection)", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")

    const teamInfo = findTeamBySession(db, registry, "random-sess")
    expect(teamInfo).toBeUndefined()
  })
})

describe("experimental.session.compacting logic", () => {
  let db: Database
  let registry: MemberRegistry

  beforeEach(() => {
    db = setupDb()
    registry = new MemberRegistry()
  })

  test("produces compaction context for lead", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "alice-sess", "busy", "running")
    registry.register("t1", "alice", "alice-sess")

    const teamInfo = findTeamBySession(db, registry, "lead-sess")
    const context = buildTeamCompactionContext(db, teamInfo!.teamId, teamInfo!.role, teamInfo!.memberName)
    expect(context).toContain("lead")
    expect(context).toContain("my-team")
    expect(context).toContain("alice")
    expect(context).toContain("end the current turn")
    expect(context).toContain("concrete stall or recovery check")
    expect(context).toContain("identified blocker or stall requires recovery")
  })

  test("produces compaction context for teammate", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "alice-sess", "busy", "running")
    registry.register("t1", "alice", "alice-sess")

    const teamInfo = findTeamBySession(db, registry, "alice-sess")
    const context = buildTeamCompactionContext(db, teamInfo!.teamId, teamInfo!.role, teamInfo!.memberName)
    expect(context).toContain("teammate")
    expect(context).toContain("alice")
    expect(context).toContain("my-team")
  })

  test("no context for non-team session", () => {
    const teamInfo = findTeamBySession(db, registry, "random-sess")
    expect(teamInfo).toBeUndefined()
  })
})

describe("shell.env logic", () => {
  let db: Database
  let registry: MemberRegistry

  beforeEach(() => {
    db = setupDb()
    registry = new MemberRegistry()
  })

  test("sets env vars for lead session", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")

    const teamInfo = findTeamBySession(db, registry, "lead-sess")
    expect(teamInfo).toBeTruthy()

    const env: Record<string, string> = {}
    env.ENSEMBLE_TEAM = teamInfo!.teamName
    env.ENSEMBLE_ROLE = teamInfo!.role

    expect(env.ENSEMBLE_TEAM).toBe("my-team")
    expect(env.ENSEMBLE_ROLE).toBe("lead")
  })

  test("sets env vars for teammate session including member name", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "alice-sess", "busy", "running")
    registry.register("t1", "alice", "alice-sess")

    const teamInfo = findTeamBySession(db, registry, "alice-sess")
    expect(teamInfo).toBeTruthy()

    const env: Record<string, string> = {}
    env.ENSEMBLE_TEAM = teamInfo!.teamName
    env.ENSEMBLE_ROLE = teamInfo!.role
    if (teamInfo!.memberName) {
      env.ENSEMBLE_MEMBER = teamInfo!.memberName
    }

    expect(env.ENSEMBLE_TEAM).toBe("my-team")
    expect(env.ENSEMBLE_ROLE).toBe("member")
    expect(env.ENSEMBLE_MEMBER).toBe("alice")
  })

  test("includes worktree branch when available", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "alice-sess", "busy", "running")
    db.run("UPDATE team_member SET worktree_branch = 'ensemble-my-team-alice' WHERE name = 'alice'")
    registry.register("t1", "alice", "alice-sess")

    const teamInfo = findTeamBySession(db, registry, "alice-sess")
    const member = db.query("SELECT worktree_branch FROM team_member WHERE team_id = ? AND name = ?")
      .get(teamInfo!.teamId, teamInfo!.memberName!) as { worktree_branch: string | null } | null

    expect(member?.worktree_branch).toBe("ensemble-my-team-alice")
  })

  test("includes worktree dir when available", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "alice-sess", "busy", "running")
    db.run("UPDATE team_member SET worktree_dir = '/tmp/wt-alice', worktree_branch = 'ensemble-my-team-alice' WHERE name = 'alice'")
    registry.register("t1", "alice", "alice-sess")

    const teamInfo = findTeamBySession(db, registry, "alice-sess")
    // Mirror the FIXED production code from index.ts shell.env hook
    const member = db.query("SELECT worktree_branch, worktree_dir FROM team_member WHERE team_id = ? AND name = ?")
      .get(teamInfo!.teamId, teamInfo!.memberName!) as { worktree_branch: string | null; worktree_dir: string | null } | null

    const env: Record<string, string> = {}
    if (member?.worktree_branch) {
      env.ENSEMBLE_BRANCH = member.worktree_branch
    }
    if (member?.worktree_dir) {
      env.ENSEMBLE_WORKTREE_DIR = member.worktree_dir
    }

    expect(env.ENSEMBLE_BRANCH).toBe("ensemble-my-team-alice")
    expect(env.ENSEMBLE_WORKTREE_DIR).toBe("/tmp/wt-alice")
  })

  test("no env vars for non-team session", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")

    const teamInfo = findTeamBySession(db, registry, "random-sess")
    expect(teamInfo).toBeUndefined()
  })
})

// --- Fix 3: idle-without-reporting nudge ---

describe("shouldNudgeIdleMember", () => {
  let db: Database

  beforeEach(() => {
    db = setupDb()
    insertTeam(db, "t1", "my-team", "lead-sess")
  })

  test("returns true when member went idle without sending any messages", () => {
    insertMember(db, "t1", "alice", "sess-alice", "ready", "idle")
    expect(shouldNudgeIdleMember(db, "t1", "alice")).toBe(true)
  })

  test("returns false when member has sent a message to the lead", () => {
    insertMember(db, "t1", "alice", "sess-alice", "ready", "idle")
    sendMessage(db, { teamId: "t1", from: "alice", to: "lead", content: "here are my results" })
    expect(shouldNudgeIdleMember(db, "t1", "alice")).toBe(false)
  })

  test("returns false when member status is shutdown", () => {
    insertMember(db, "t1", "alice", "sess-alice", "shutdown", "idle")
    expect(shouldNudgeIdleMember(db, "t1", "alice")).toBe(false)
  })

  test("returns false when member status is busy", () => {
    insertMember(db, "t1", "alice", "sess-alice", "busy", "running")
    expect(shouldNudgeIdleMember(db, "t1", "alice")).toBe(false)
  })
})

// --- Fix 2: stronger teammate system prompt ---

describe("buildTeammateSystemPrompt — reporting requirement", () => {
  let db: Database

  beforeEach(() => {
    db = setupDb()
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-alice", "busy", "running")
  })

  test("includes mandatory reporting instruction", () => {
    const prompt = buildTeammateSystemPrompt(db, "t1", "alice")
    expect(prompt).toContain("team_message")
    expect(prompt).toContain("before stopping")
  })
})

// --- Fix 1: compaction preserves completion requirement ---

describe("buildTeamCompactionContext — completion requirement", () => {
  let db: Database

  beforeEach(() => {
    db = setupDb()
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "sess-alice", "busy", "running")
  })

  test("member compaction context includes reporting requirement", () => {
    const ctx = buildTeamCompactionContext(db, "t1", "member", "alice")
    expect(ctx).toContain("team_message")
    expect(ctx).toContain("before stopping")
  })

  test("lead compaction context does NOT include reporting requirement", () => {
    const ctx = buildTeamCompactionContext(db, "t1", "lead")
    expect(ctx).not.toContain("before stopping")
  })
})

describe("handleSessionErrorEvent", () => {
  let db: Database
  let registry: MemberRegistry

  beforeEach(() => {
    db = setupDb()
    registry = new MemberRegistry()
    insertTeam(db, "t1", "smoke", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "busy", "running")
    registry.register("t1", "scout", "scout-sess")
  })

  test("atomically fails the member, posts one actionable alert, and returns lead wake metadata", () => {
    const wake = handleSessionErrorEvent(db, registry, "scout-sess", {
      name: "UnknownError",
      data: { message: "Tool team_message failed: This session is not in a team." },
    })

    expect(wake).toEqual({ leadSessionId: "lead-sess", memberName: "scout" })
    const member = db.query("SELECT status, execution_status FROM team_member WHERE session_id = ?")
      .get("scout-sess") as { status: string; execution_status: string }
    expect(member).toEqual({ status: "error", execution_status: "failed" })

    const msgs = db.query(
      "SELECT from_name, to_name, content FROM team_message WHERE team_id = ?"
    ).all("t1") as Array<{ from_name: string; to_name: string; content: string }>
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.from_name).toBe("system")
    expect(msgs[0]?.to_name).toBe("lead")
    expect(msgs[0]?.content).toContain("scout")
    expect(msgs[0]?.content).toContain("scout-sess")
    expect(msgs[0]?.content).toContain("Tool team_message failed")
    expect(msgs[0]?.content).toContain("team_spawn")
    expect(msgs[0]?.content).toContain("resume_from")

    expect(handleSessionErrorEvent(db, registry, "scout-sess", {
      name: "UnknownError",
      data: { message: "duplicate delivery" },
    })).toBeUndefined()
    expect((db.query("SELECT COUNT(*) AS count FROM team_message").get() as { count: number }).count).toBe(1)
  })

  test("releases in-progress tasks assigned to the failed member", () => {
    const now = Date.now()
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, phase, time_created, time_updated) VALUES (?, ?, ?, 'pending', 'high', ?, ?, ?)",
      ["task-ready", "t1", "resume the ready frontier", "discovery", now - 1, now - 1],
    )
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, phase, time_created, time_updated) VALUES (?, ?, ?, 'in_progress', 'high', ?, ?, ?, ?)",
      ["task-failed", "t1", "finish the interrupted work", "scout", "implementation", now, now],
    )
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES (?, ?, ?, 'completed', 'medium', ?, ?, ?)",
      ["task-done", "t1", "leave completed work alone", "scout", now, now],
    )
    db.run("UPDATE team SET current_phase = 'implementation' WHERE id = 't1'")

    handleSessionErrorEvent(db, registry, "scout-sess", {
      name: "MessageAbortedError",
      data: { message: "Aborted" },
    })

    const failed = db.query("SELECT status, assignee FROM team_task WHERE id = ?")
      .get("task-failed") as { status: string; assignee: string | null }
    const completed = db.query("SELECT status, assignee FROM team_task WHERE id = ?")
      .get("task-done") as { status: string; assignee: string | null }
    expect(failed).toEqual({ status: "pending", assignee: null })
    expect(completed).toEqual({ status: "completed", assignee: "scout" })
    expect(db.query("SELECT current_phase FROM team WHERE id = 't1'").get())
      .toEqual({ current_phase: "discovery" })

    const alert = db.query("SELECT content FROM team_message WHERE team_id = ? AND to_name = 'lead'")
      .get("t1") as { content: string }
    expect(alert.content).toContain("1 assigned task was returned to pending")
  })

  test("uses error.name as fallback when data.message is missing", () => {
    handleSessionErrorEvent(db, registry, "scout-sess", { name: "ProviderAuthError" })

    const msgs = db.query("SELECT content FROM team_message WHERE team_id = ?")
      .all("t1") as Array<{ content: string }>
    expect(msgs[0]?.content).toContain("ProviderAuthError")
  })

  test("uses 'unknown error' when error is undefined", () => {
    handleSessionErrorEvent(db, registry, "scout-sess", undefined)

    const msgs = db.query("SELECT content FROM team_message WHERE team_id = ?")
      .all("t1") as Array<{ content: string }>
    expect(msgs[0]?.content).toContain("unknown error")
  })

  test("ignores errors for unknown sessions (not in registry)", () => {
    handleSessionErrorEvent(db, registry, "stranger-sess", {
      name: "UnknownError",
      data: { message: "boom" },
    })

    const msgs = db.query("SELECT id FROM team_message").all() as unknown[]
    expect(msgs).toHaveLength(0)
  })

  test("ignores undefined sessionID", () => {
    handleSessionErrorEvent(db, registry, undefined, { name: "UnknownError", data: { message: "boom" } })

    const msgs = db.query("SELECT id FROM team_message").all() as unknown[]
    expect(msgs).toHaveLength(0)
  })

  test("does not post a duplicate message for the lead — leads are not in registry", () => {
    // The lead's session is NOT in the registry (leads are looked up via SQLite).
    // A session.error for the lead's session should not produce a teammate-error message.
    handleSessionErrorEvent(db, registry, "lead-sess", {
      name: "UnknownError",
      data: { message: "boom" },
    })

    const msgs = db.query("SELECT id FROM team_message").all() as unknown[]
    expect(msgs).toHaveLength(0)
  })

  test.each(["shutdown_requested", "shutdown", "error"])("suppresses errors for %s members", status => {
    db.run("UPDATE team_member SET status = ? WHERE session_id = ?", [status, "scout-sess"])

    expect(handleSessionErrorEvent(db, registry, "scout-sess", {
      name: "AbortError",
      data: { message: "aborted intentionally" },
    })).toBeUndefined()

    expect((db.query("SELECT COUNT(*) AS count FROM team_message").get() as { count: number }).count).toBe(0)
  })
})

describe("handleSessionStatusEvent — abort recovery inspection", () => {
  test("suppresses idle transitions while an abort recovery check is active", () => {
    const db = setupDb()
    const registry = new MemberRegistry()
    insertTeam(db, "t1", "smoke", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "busy", "running")
    registry.register("t1", "scout", "scout-sess")
    db.run("UPDATE team_member SET abort_recovery_state = 'checking' WHERE session_id = ?", ["scout-sess"])

    expect(handleSessionStatusEvent(db, registry, "scout-sess", "idle")).toBeUndefined()
    expect(db.query("SELECT status, execution_status FROM team_member WHERE session_id = ?").get("scout-sess"))
      .toEqual({ status: "busy", execution_status: "running" })
  })
})

// --- Multi-instance state partition: registry empty, SQLite is source of truth ---
// When opencode runs multiple Plugin instances in one process (Desktop's local
// sidecar + a connected WSL serve sharing the same SQLite DB), each instance
// has its own MemberRegistry. A team_* tool call from a teammate may be
// dispatched to a Plugin instance whose registry never saw the spawn.
// findTeamBySession and resolveRecipientSession MUST fall back to SQLite.

describe("findTeamBySession — SQLite fallback when registry is empty", () => {
  let db: Database
  let registry: MemberRegistry

  beforeEach(() => {
    db = setupDb()
    registry = new MemberRegistry()
  })

  test("resolves a teammate session via SQLite when registry has no entry", () => {
    // Simulate a teammate written to the DB by a different Plugin instance
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "busy", "running")
    // Note: registry is intentionally empty — this Plugin instance never saw the spawn

    const teamInfo = findTeamBySession(db, registry, "scout-sess")

    expect(teamInfo).toBeTruthy()
    expect(teamInfo!.role).toBe("member")
    expect(teamInfo!.memberName).toBe("scout")
    expect(teamInfo!.teamId).toBe("t1")
    expect(teamInfo!.teamName).toBe("my-team")
  })

  test("populates the registry cache after a successful SQLite fallback", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "busy", "running")

    findTeamBySession(db, registry, "scout-sess")

    // Cache should now hold the entry so subsequent lookups don't re-query
    const cached = registry.getBySession("scout-sess")
    expect(cached).toBeTruthy()
    expect(cached!.memberName).toBe("scout")
    expect(cached!.teamId).toBe("t1")
  })

  test("does not return members of archived teams", () => {
    db.run(
      "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, 'archived', 0, ?, ?)",
      ["t1", "old", "lead-sess", Date.now(), Date.now()]
    )
    insertMember(db, "t1", "scout", "scout-sess", "busy", "running")

    expect(findTeamBySession(db, registry, "scout-sess")).toBeUndefined()
  })

  test("does not return shutdown members from SQLite", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "shutdown", "completed")

    expect(findTeamBySession(db, registry, "scout-sess")).toBeUndefined()
  })

  test("does not return error members from SQLite", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "error", "failed")

    expect(findTeamBySession(db, registry, "scout-sess")).toBeUndefined()
  })

  test("registry-hit fast path still works without SQLite query", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "alice-sess", "busy", "running")
    registry.register("t1", "alice", "alice-sess")

    const teamInfo = findTeamBySession(db, registry, "alice-sess")

    expect(teamInfo).toBeTruthy()
    expect(teamInfo!.role).toBe("member")
    expect(teamInfo!.memberName).toBe("alice")
  })

  test("returns undefined when neither registry nor DB knows the session", () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    expect(findTeamBySession(db, registry, "ghost-sess")).toBeUndefined()
  })
})

describe("resolveRecipientSession — SQLite fallback when registry is empty", () => {
  let db: Database
  let registry: MemberRegistry

  beforeEach(() => {
    db = setupDb()
    registry = new MemberRegistry()
  })

  test("resolves a member by name via SQLite when registry has no entry", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "busy", "running")
    // Note: registry intentionally empty

    const { resolveRecipientSession } = await import("../src/types")
    const sessionId = resolveRecipientSession(db, registry, "t1", "scout")

    expect(sessionId).toBe("scout-sess")
  })

  test("populates the registry cache after a successful SQLite fallback", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "busy", "running")

    const { resolveRecipientSession } = await import("../src/types")
    resolveRecipientSession(db, registry, "t1", "scout")

    expect(registry.getByName("t1", "scout")?.sessionId).toBe("scout-sess")
  })

  test("registry-hit fast path still works", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "alice", "alice-sess", "busy", "running")
    registry.register("t1", "alice", "alice-sess")

    const { resolveRecipientSession } = await import("../src/types")
    expect(resolveRecipientSession(db, registry, "t1", "alice")).toBe("alice-sess")
  })

  test("does not return shutdown members", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "shutdown", "completed")

    const { resolveRecipientSession } = await import("../src/types")
    expect(resolveRecipientSession(db, registry, "t1", "scout")).toBeUndefined()
  })

  test("does not return error members", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "error", "failed")

    const { resolveRecipientSession } = await import("../src/types")
    expect(resolveRecipientSession(db, registry, "t1", "scout")).toBeUndefined()
  })

  test("'lead' resolves to team.lead_session_id (unchanged behaviour)", async () => {
    insertTeam(db, "t1", "my-team", "lead-sess")

    const { resolveRecipientSession } = await import("../src/types")
    expect(resolveRecipientSession(db, registry, "t1", "lead")).toBe("lead-sess")
  })
})

describe("checkToolIsolation — SQLite fallback for multi-instance scenarios", () => {
  let db: Database
  let registry: MemberRegistry
  let tracker: DescendantTracker

  beforeEach(() => {
    db = setupDb()
    registry = new MemberRegistry()
    tracker = new DescendantTracker()
  })

  test("blocks sub-agent of teammate even when registry is empty (SQLite fallback)", () => {
    // Multi-instance scenario: this Plugin instance's registry is empty, but
    // SQLite has the teammate. A sub-agent of that teammate must still be
    // blocked from calling team tools.
    insertTeam(db, "t1", "smoke", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "busy", "running")
    tracker.track("sub-agent-sess", "scout-sess")

    expect(() => checkToolIsolation(registry, tracker, "team_message", "sub-agent-sess", db))
      .toThrow("Team tools are not available to sub-agents")
  })

  test("allows team tools for the teammate's own session via SQLite fallback", () => {
    insertTeam(db, "t1", "smoke", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "busy", "running")
    // Registry empty — but scout IS a teammate per SQLite

    expect(() => checkToolIsolation(registry, tracker, "team_message", "scout-sess", db)).not.toThrow()
  })

  test("ignores shutdown teammates in SQLite — their sub-agents are not blocked", () => {
    insertTeam(db, "t1", "smoke", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "shutdown", "completed")
    tracker.track("sub-agent-sess", "scout-sess")

    expect(() => checkToolIsolation(registry, tracker, "team_message", "sub-agent-sess", db)).not.toThrow()
  })

  test("works without db param (backward compatible — registry only)", () => {
    // Legacy call sites that don't pass db keep their existing behaviour
    registry.register("t1", "alice", "sess-1")
    tracker.track("sub-agent-sess", "sess-1")

    expect(() => checkToolIsolation(registry, tracker, "team_message", "sub-agent-sess"))
      .toThrow("Team tools are not available to sub-agents")
  })
})

describe("handleSessionErrorEvent — SQLite fallback when registry is empty", () => {
  let db: Database
  let registry: MemberRegistry

  beforeEach(() => {
    db = setupDb()
    registry = new MemberRegistry()
  })

  test("posts a system message via SQLite fallback when registry is empty", () => {
    // Multi-Plugin-instance: SQLite has the teammate but this Plugin
    // instance's in-memory registry never saw the spawn.
    insertTeam(db, "t1", "smoke", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "busy", "running")

    handleSessionErrorEvent(db, registry, "scout-sess", {
      name: "UnknownError",
      data: { message: "Tool team_message failed" },
    })

    const msgs = db.query(
      "SELECT from_name, to_name, content FROM team_message WHERE team_id = ?"
    ).all("t1") as Array<{ from_name: string; to_name: string; content: string }>
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.from_name).toBe("system")
    expect(msgs[0]?.to_name).toBe("lead")
    expect(msgs[0]?.content).toContain("scout")
  })

  test("removes a terminal member from the registry after SQLite fallback", () => {
    insertTeam(db, "t1", "smoke", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "busy", "running")

    handleSessionErrorEvent(db, registry, "scout-sess", { name: "UnknownError", data: { message: "boom" } })

    expect(registry.getBySession("scout-sess")).toBeUndefined()
  })

  test("ignores shutdown teammates even if SQLite has the row", () => {
    insertTeam(db, "t1", "smoke", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "shutdown", "completed")

    handleSessionErrorEvent(db, registry, "scout-sess", { name: "UnknownError", data: { message: "boom" } })

    const msgs = db.query("SELECT id FROM team_message").all() as unknown[]
    expect(msgs).toHaveLength(0)
  })

  test("ignores error-state teammates even if SQLite has the row", () => {
    insertTeam(db, "t1", "smoke", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "error", "failed")

    handleSessionErrorEvent(db, registry, "scout-sess", { name: "UnknownError", data: { message: "boom" } })

    const msgs = db.query("SELECT id FROM team_message").all() as unknown[]
    expect(msgs).toHaveLength(0)
  })
})

describe("checkToolIsolation — registry fast-path performance", () => {
  let db: Database
  let registry: MemberRegistry
  let tracker: DescendantTracker

  beforeEach(() => {
    db = setupDb()
    registry = new MemberRegistry()
    tracker = new DescendantTracker()
  })

  function instrumentedDb(real: Database): { db: typeof real; queryCount: () => number } {
    let count = 0
    const wrapper = {
      query: (sql: string) => {
        count++
        return real.query(sql)
      },
      exec: real.exec.bind(real),
      run: real.run.bind(real),
      close: real.close.bind(real),
      transaction: real.transaction.bind(real),
    } as unknown as typeof real
    return { db: wrapper, queryCount: () => count }
  }

  test("skips SQLite query when caller is in registry (fast path)", () => {
    insertTeam(db, "t1", "smoke", "lead-sess")
    insertMember(db, "t1", "alice", "alice-sess", "busy", "running")
    registry.register("t1", "alice", "alice-sess")

    const { db: spyDb, queryCount } = instrumentedDb(db as unknown as Parameters<typeof instrumentedDb>[0])

    expect(() => checkToolIsolation(registry, tracker, "team_message", "alice-sess", spyDb as unknown as Database)).not.toThrow()
    expect(queryCount()).toBe(0)
  })

  test("falls through to SQLite when caller is NOT in registry", () => {
    insertTeam(db, "t1", "smoke", "lead-sess")
    insertMember(db, "t1", "scout", "scout-sess", "busy", "running")
    // Registry is empty for scout

    const { db: spyDb, queryCount } = instrumentedDb(db as unknown as Parameters<typeof instrumentedDb>[0])

    expect(() => checkToolIsolation(registry, tracker, "team_message", "scout-sess", spyDb as unknown as Database)).not.toThrow()
    expect(queryCount()).toBeGreaterThan(0)
  })
})
