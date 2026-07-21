import { describe, expect, test } from "bun:test"
import { RetryTracker } from "../src/hooks"
import { breakRetryLoop } from "../src/retry-breaker"
import { insertMember, insertTeam, setupDeps } from "./helpers"

function insertAssignedTask(deps: ReturnType<typeof setupDeps>) {
  const now = Date.now()
  deps.db.run(
    `INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated)
     VALUES ('task-retry', 't1', 'Continue provider work', 'in_progress', 'high', 'alice', ?, ?)`,
    [now, now],
  )
}

function requestFor(deps: ReturnType<typeof setupDeps>) {
  const tracker = new RetryTracker()
  let request: ReturnType<RetryTracker["observeStatus"]>
  for (let attempt = 1; attempt <= 6; attempt++) {
    request = tracker.observeStatus(deps.db, deps.registry, "sess-alice", "retry", "provider overloaded", attempt) ?? request
  }
  if (!request) throw new Error("expected retry exhaustion")
  return request
}

function setupRetryingMember() {
  const deps = setupDeps()
  insertTeam(deps.db, "t1", "my-team", "lead-sess")
  insertMember(deps.db, "t1", "alice", "sess-alice", "busy", "running")
  deps.registry.register("t1", "alice", "sess-alice")
  insertAssignedTask(deps)
  return deps
}

describe("retry breaker", () => {
  test("preserves and aborts before releasing ownership, then guides a resumed replacement", async () => {
    const deps = setupRetryingMember()
    deps.db.run(
      "UPDATE team_member SET worktree_branch = 'ensemble-my-team-alice', worktree_dir = '/tmp/wt-alice' WHERE name = 'alice'",
    )
    const calls: string[] = []
    let finishAbort: (() => void) | undefined
    deps.client.session.abort = async () => {
      calls.push("abort")
      await new Promise<void>(resolve => { finishAbort = resolve })
      return {}
    }

    const breaking = breakRetryLoop(deps, requestFor(deps), async (source, target) => {
      calls.push(`preserve:${source}:${target}`)
      return true
    })
    await Bun.sleep(0)

    expect(calls[0]).toStartWith("preserve:ensemble-my-team-alice:ensemble/preserved/")
    expect(calls[1]).toBe("abort")
    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id = 'task-retry'").get())
      .toEqual({ status: "in_progress", assignee: "alice" })
    expect(deps.db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get())
      .toEqual({ status: "shutdown_requested", execution_status: "cancelling" })

    finishAbort?.()
    expect(await breaking).toBe(true)
    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id = 'task-retry'").get())
      .toEqual({ status: "pending", assignee: null })
    expect(deps.db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get())
      .toEqual({ status: "error", execution_status: "failed" })
    const alert = deps.db.query("SELECT content FROM team_message WHERE team_id = 't1' AND to_name = 'lead'").get() as { content: string }
    expect(alert.content).toContain("6 consecutive retries")
    expect(alert.content).toContain('resume_from: "alice"')
    expect(alert.content).toContain("task-retry")
  })

  test("keeps member and task owned when branch preservation fails", async () => {
    const deps = setupRetryingMember()
    deps.db.run("UPDATE team_member SET worktree_branch = 'ensemble-my-team-alice' WHERE name = 'alice'")

    expect(await breakRetryLoop(deps, requestFor(deps), async () => false)).toBe(false)
    expect(deps.client.calls.filter(call => call.method === "session.abort")).toHaveLength(0)
    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id = 'task-retry'").get())
      .toEqual({ status: "in_progress", assignee: "alice" })
    expect(deps.db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get())
      .toEqual({ status: "busy", execution_status: "cancel_requested" })
    const retryState = deps.db.query("SELECT retry_count, retry_tripped FROM team_member WHERE name = 'alice'").get()
    expect(retryState).toEqual({ retry_count: 6, retry_tripped: 0 })

    const tracker = new RetryTracker()
    expect(tracker.observeStatus(deps.db, deps.registry, "sess-alice", "retry", "provider still unavailable", 7))
      .toMatchObject({ attempts: 7, reason: "provider still unavailable" })
  })

  test("keeps member and task owned when abort fails", async () => {
    const deps = setupRetryingMember()
    deps.client.session.abort = async () => { throw new Error("transport unavailable") }

    expect(await breakRetryLoop(deps, requestFor(deps), async () => true)).toBe(false)
    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id = 'task-retry'").get())
      .toEqual({ status: "in_progress", assignee: "alice" })
    expect(deps.db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get())
      .toEqual({ status: "busy", execution_status: "cancel_requested" })
    expect(deps.db.query("SELECT retry_tripped FROM team_member WHERE name = 'alice'").get())
      .toEqual({ retry_tripped: 0 })
    const alert = deps.db.query("SELECT content FROM team_message WHERE team_id = 't1' AND to_name = 'lead'").get() as { content: string }
    expect(alert.content).toContain("could not be aborted")
  })

  test("restores retry ownership when branch resolution throws", async () => {
    const deps = setupRetryingMember()
    deps.db.run(
      "UPDATE team_member SET worktree_branch = 'ensemble/preserved/project/team/alice', worktree_dir = '/tmp/wt-alice' WHERE name = 'alice'",
    )

    expect(await breakRetryLoop(deps, requestFor(deps), async () => true, async () => {
      throw new Error("worktree unavailable")
    })).toBe(false)

    expect(deps.db.query("SELECT status, execution_status, retry_tripped FROM team_member WHERE name = 'alice'").get())
      .toEqual({ status: "busy", execution_status: "cancel_requested", retry_tripped: 0 })
    expect(deps.client.calls.filter(call => call.method === "session.abort")).toHaveLength(0)
  })

  test("only one tracker instance can claim the sixth retry", () => {
    const deps = setupRetryingMember()
    const first = new RetryTracker()
    const second = new RetryTracker()
    let claimed = 0
    for (let attempt = 1; attempt <= 6; attempt++) {
      if (first.observeStatus(deps.db, deps.registry, "sess-alice", "retry", "overloaded", attempt)) claimed++
      if (second.observeStatus(deps.db, deps.registry, "sess-alice", "retry", "overloaded", attempt)) claimed++
    }
    expect(claimed).toBe(1)
  })
})
