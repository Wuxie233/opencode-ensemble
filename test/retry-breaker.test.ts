import { describe, expect, test } from "bun:test"
import { RetryTracker } from "../src/hooks"
import type { RetryExhaustion } from "../src/hooks"
import type { ToolDeps } from "../src/types"
import { breakRetryLoop, handleRetryStatus } from "../src/retry-breaker"
import { TerminalLivenessGuard } from "../src/terminal-liveness"
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
  if (!request || request.kind !== "exhaustion") throw new Error("expected retry exhaustion")
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
  test("keeps retrying the same model through attempt five when no alternate fallback exists", async () => {
    const deps = setupRetryingMember()
    deps.config.modelFallbackByAgent = { build: ["wuxie-openai/gpt-5.6-sol"] }
    deps.db.run("UPDATE team_member SET model = 'wuxie-openai/gpt-5.6-sol' WHERE name = 'alice'")
    const tracker = new RetryTracker({ fallbackEnabled: true, fallbackStartAttempt: 4, exhaustionAttempt: 6 })
    const terminated: Array<{ attempts: number; fallbackModel?: string }> = []
    const terminate = async (_deps: ToolDeps, request: RetryExhaustion) => {
      terminated.push(request)
      return true
    }

    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await handleRetryStatus(deps, tracker, "sess-alice", "retry", "provider overloaded", attempt, terminate)).toBeUndefined()
    }
    const result = await handleRetryStatus(deps, tracker, "sess-alice", "retry", "provider overloaded", 6, terminate)

    expect(result).toMatchObject({ kind: "exhaustion", attempts: 6 })
    expect(terminated).toHaveLength(1)
    expect(terminated[0]).toMatchObject({ kind: "exhaustion", attempts: 6 })
  })

  test("hands a configured alternate model to the Lead at the fallback threshold", async () => {
    const deps = setupRetryingMember()
    deps.config.modelFallbackByAgent = { build: ["wuxie-openai/gpt-5.6-sol", "provider/backup"] }
    deps.db.run("UPDATE team_member SET model = 'wuxie-openai/gpt-5.6-sol' WHERE name = 'alice'")
    const tracker = new RetryTracker({ fallbackEnabled: true, fallbackStartAttempt: 4, exhaustionAttempt: 6 })
    let captured: RetryExhaustion | undefined
    const terminate = async (_deps: ToolDeps, request: RetryExhaustion) => {
      captured = request
      return true
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      await handleRetryStatus(deps, tracker, "sess-alice", "retry", "provider overloaded", attempt, terminate)
    }
    const result = await handleRetryStatus(deps, tracker, "sess-alice", "retry", "provider overloaded", 4, terminate)

    expect(result).toMatchObject({ kind: "exhaustion", attempts: 4, fallbackModel: "provider/backup" })
    expect(captured).toEqual({
      kind: "exhaustion",
      leadSessionId: "lead-sess",
      memberName: "alice",
      sessionId: "sess-alice",
      teamId: "t1",
      reason: "provider overloaded",
      attempts: 4,
      fallbackModel: "provider/backup",
    })
  })

  test("waits for the sixth-retry termination attempt before returning from status handling", async () => {
    const deps = setupRetryingMember()
    const tracker = new RetryTracker()
    for (let attempt = 1; attempt <= 5; attempt++) {
      await handleRetryStatus(deps, tracker, "sess-alice", "retry", "provider overloaded", attempt)
    }
    let finishAbort: (() => void) | undefined
    let abortCalls = 0
    deps.client.session.abort = async () => {
      abortCalls += 1
      return new Promise<void>(resolve => { finishAbort = resolve })
    }
    let returned = false

    const handling = handleRetryStatus(deps, tracker, "sess-alice", "retry", "provider overloaded", 6)
      .then(() => { returned = true })
    await Bun.sleep(0)
    const duplicate = handleRetryStatus(deps, tracker, "sess-alice", "retry", "must not become attempt seven", 7)

    expect(returned).toBe(false)
    expect(deps.db.query("SELECT status, execution_status, retry_count, retry_tripped FROM team_member WHERE name = 'alice'").get())
      .toEqual({ status: "shutdown_requested", execution_status: "cancelling", retry_count: 6, retry_tripped: 1 })
    expect(abortCalls).toBe(1)
    expect((deps.db.query("SELECT retry_attempts FROM team_member WHERE name = 'alice'").get() as { retry_attempts: string }).retry_attempts)
      .toBe("[1,2,3,4,5,6]")
    finishAbort?.()
    await Promise.all([handling, duplicate])
    expect(returned).toBe(true)
    expect(deps.db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get())
      .toEqual({ status: "error", execution_status: "failed" })
  })

  test("single-flights concurrent sixth and seventh retry events across plugin dependencies", async () => {
    const firstDeps = setupRetryingMember()
    const secondDeps = { ...firstDeps }
    const tracker = new RetryTracker()
    for (let attempt = 1; attempt <= 5; attempt++) {
      await handleRetryStatus(firstDeps, tracker, "sess-alice", "retry", "provider overloaded", attempt)
    }
    let preserveCalls = 0
    let abortCalls = 0
    let finishAbort: (() => void) | undefined
    const terminate = async () => {
      preserveCalls += 1
      abortCalls += 1
      await new Promise<void>(resolve => { finishAbort = resolve })
      return true
    }

    const sixth = handleRetryStatus(firstDeps, tracker, "sess-alice", "retry", "provider overloaded", 6, terminate)
    await Bun.sleep(0)
    const seventh = handleRetryStatus(secondDeps, new RetryTracker(), "sess-alice", "retry", "provider overloaded", 7, terminate)
    await Bun.sleep(0)

    expect(preserveCalls).toBe(1)
    expect(abortCalls).toBe(1)
    expect(firstDeps.db.query("SELECT retry_count, retry_tripped, retry_attempts FROM team_member WHERE name = 'alice'").get())
      .toEqual({ retry_count: 6, retry_tripped: 1, retry_attempts: "[1,2,3,4,5,6]" })
    finishAbort?.()
    const outcomes = await Promise.all([sixth, seventh])
    expect(outcomes[0]).toEqual(outcomes[1])
    expect(outcomes[0]).toMatchObject({ attempts: 6 })
  })

  test("preserves and aborts before releasing ownership, then guides a resumed replacement", async () => {
    const deps = setupRetryingMember()
    const now = Date.now()
    deps.db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, phase, time_created, time_updated) VALUES ('task-ready', 't1', 'Resume ready work', 'pending', 'high', 'discovery', ?, ?)",
      [now - 1, now - 1],
    )
    deps.db.run("UPDATE team_task SET phase = 'implementation', time_created = ? WHERE id = 'task-retry'", [now])
    deps.db.run("UPDATE team SET current_phase = 'implementation' WHERE id = 't1'")
    deps.db.run(
      "UPDATE team_member SET worktree_branch = 'ensemble-my-team-alice', worktree_dir = '/tmp/wt-alice' WHERE name = 'alice'",
    )
    const calls: string[] = []
    let finishAbort: (() => void) | undefined
    deps.client.session.abort = async () => {
      const branch = (deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'").get() as { worktree_branch: string }).worktree_branch
      expect(branch).toStartWith("ensemble/preserved/")
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
    expect(deps.db.query("SELECT current_phase FROM team WHERE id = 't1'").get())
      .toEqual({ current_phase: "discovery" })
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
      .toEqual({ status: "shutdown_requested", execution_status: "cancelling" })
    const retryState = deps.db.query("SELECT retry_count, retry_tripped FROM team_member WHERE name = 'alice'").get()
    expect(retryState).toEqual({ retry_count: 6, retry_tripped: 1 })

    const tracker = new RetryTracker()
    const retry = tracker.observeStatus(deps.db, deps.registry, "sess-alice", "retry", "provider still unavailable", 7)
    expect(retry).toMatchObject({ attempts: 6, reason: "provider still unavailable" })
    if (!retry || retry.kind !== "exhaustion") throw new Error("expected retry exhaustion")
    expect(await breakRetryLoop(deps, retry!, async () => true)).toBe(true)
    expect(deps.db.query("SELECT retry_count, retry_tripped FROM team_member WHERE name = 'alice'").get())
      .toEqual({ retry_count: 6, retry_tripped: 1 })
  })

  test("keeps member and task owned when abort fails", async () => {
    const deps = setupRetryingMember()
    deps.db.run("UPDATE team_member SET worktree_branch = 'live-alice' WHERE name = 'alice'")
    deps.client.session.abort = async () => {
      const branch = (deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'").get() as { worktree_branch: string }).worktree_branch
      expect(branch).toStartWith("ensemble/preserved/")
      throw new Error("transport unavailable")
    }

    expect(await breakRetryLoop(deps, requestFor(deps), async () => true)).toBe(false)
    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id = 'task-retry'").get())
      .toEqual({ status: "in_progress", assignee: "alice" })
    expect(deps.db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get())
      .toEqual({ status: "shutdown_requested", execution_status: "cancelling" })
    expect(deps.db.query("SELECT retry_tripped FROM team_member WHERE name = 'alice'").get())
      .toEqual({ retry_tripped: 1 })
    expect((deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'").get() as { worktree_branch: string }).worktree_branch)
      .toStartWith("ensemble/preserved/")
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
      .toEqual({ status: "shutdown_requested", execution_status: "cancelling", retry_tripped: 1 })
    expect(deps.client.calls.filter(call => call.method === "session.abort")).toHaveLength(0)
  })

  test("does not abort a preserved retry branch without live worktree metadata", async () => {
    const deps = setupRetryingMember()
    deps.db.run("UPDATE team_member SET worktree_branch = 'ensemble/preserved/project/team/alice', worktree_dir = NULL WHERE name = 'alice'")

    expect(await breakRetryLoop(deps, requestFor(deps), async () => true)).toBe(false)
    expect(deps.client.calls.filter(call => call.method === "session.abort")).toHaveLength(0)
    expect((deps.db.query("SELECT content FROM team_message WHERE team_id = 't1' AND to_name = 'lead'").get() as { content: string }).content)
      .toContain("no live worktree metadata")
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

describe("terminal liveness guard", () => {
  test("preserves a live branch before re-aborting a terminal member", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice", "error", "failed")
    deps.db.run("UPDATE team_member SET worktree_branch = 'live-alice' WHERE name = 'alice'")
    const order: string[] = []
    deps.client.session.abort = async () => {
      expect((deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'").get() as { worktree_branch: string }).worktree_branch)
        .toStartWith("ensemble/preserved/")
      order.push("abort")
      return {}
    }
    const guard = new TerminalLivenessGuard(deps, async (source, target) => {
      order.push(`preserve:${source}:${target}`)
      return true
    })

    expect(await guard.handle("sess-alice", "retry")).toBe(true)
    expect(order[0]).toStartWith("preserve:live-alice:ensemble/preserved/")
    expect(order[1]).toBe("abort")
    expect((deps.db.query("SELECT worktree_branch FROM team_member WHERE name = 'alice'").get() as { worktree_branch: string }).worktree_branch)
      .toStartWith("ensemble/preserved/")
  })

  test("refreshes an existing preserved ref from the live worktree before re-abort", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_branch = 'ensemble/preserved/default/my-team#t1/alice', worktree_dir = '/tmp/wt' WHERE name = 'alice'")
    const order: string[] = []
    deps.client.session.abort = async () => { order.push("abort"); return {} }
    const guard = new TerminalLivenessGuard(
      deps,
      async source => { order.push(`preserve:${source}`); return true },
      async () => "live-alice",
    )

    expect(await guard.handle("sess-alice", "busy")).toBe(true)
    expect(order).toEqual(["preserve:live-alice", "abort"])
  })

  test("does not re-abort when terminal branch preservation fails", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice", "error", "failed")
    deps.db.run("UPDATE team_member SET worktree_branch = 'live-alice' WHERE name = 'alice'")
    const guard = new TerminalLivenessGuard(deps, async () => false)

    expect(await guard.handle("sess-alice", "retry")).toBe(true)
    expect(deps.client.calls.filter(call => call.method === "session.abort")).toHaveLength(0)
    expect(deps.db.query("SELECT status, worktree_branch FROM team_member WHERE name = 'alice'").get())
      .toEqual({ status: "error", worktree_branch: "live-alice" })
  })

  test("does not re-abort when a terminal live branch cannot be resolved", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_branch = 'ensemble/preserved/default/my-team#t1/alice', worktree_dir = '/tmp/wt' WHERE name = 'alice'")
    const guard = new TerminalLivenessGuard(deps, async () => true, async () => {
      throw new Error("worktree unavailable")
    })

    expect(await guard.handle("sess-alice", "busy")).toBe(true)
    expect(deps.client.calls.filter(call => call.method === "session.abort")).toHaveLength(0)
    expect((deps.db.query("SELECT status FROM team_member WHERE name = 'alice'").get() as { status: string }).status).toBe("shutdown")
  })

  test("does not re-abort a preserved terminal branch without live worktree metadata", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice", "shutdown", "idle")
    deps.db.run("UPDATE team_member SET worktree_branch = 'ensemble/preserved/default/my-team#t1/alice', worktree_dir = NULL WHERE name = 'alice'")

    expect(await new TerminalLivenessGuard(deps).handle("sess-alice", "busy")).toBe(true)
    expect(deps.client.calls.filter(call => call.method === "session.abort")).toHaveLength(0)
    expect((deps.db.query("SELECT content FROM team_message WHERE team_id = 't1' AND to_name = 'lead'").get() as { content: string }).content)
      .toContain("no live worktree metadata")
  })

  test.each([
    ["error", "failed", "retry"],
    ["shutdown", "idle", "busy"],
    ["shutdown", "idle", "retry"],
  ] as const)("re-aborts absent-registry terminal members after late activity", async (status, executionStatus, eventStatus) => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice", status, executionStatus)
    deps.db.run("UPDATE team_member SET retry_count = 6, retry_tripped = 1 WHERE name = 'alice'")
    const guard = new TerminalLivenessGuard(deps)

    expect(await guard.handle("sess-alice", eventStatus)).toBe(true)

    expect(deps.client.calls.filter(call => call.method === "session.abort")).toHaveLength(1)
    expect(deps.db.query("SELECT status, execution_status, retry_count, retry_tripped FROM team_member WHERE name = 'alice'").get())
      .toEqual({ status, execution_status: executionStatus, retry_count: 6, retry_tripped: 1 })
  })

  test("single-flights overlapping late terminal events across guard instances", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice", "error", "failed")
    let finishAbort: (() => void) | undefined
    deps.client.session.abort = async options => {
      deps.client.calls.push({ method: "session.abort", args: [options] })
      return new Promise<void>(resolve => { finishAbort = resolve })
    }
    const firstGuard = new TerminalLivenessGuard(deps)
    const secondGuard = new TerminalLivenessGuard({ ...deps })

    const handling = Promise.all([
      firstGuard.handle("sess-alice", "retry"),
      secondGuard.handle("sess-alice", "busy"),
    ])
    await Bun.sleep(0)
    expect(deps.client.calls.filter(call => call.method === "session.abort")).toHaveLength(1)
    finishAbort?.()
    expect(await handling).toEqual([true, true])
  })

  test("keeps terminal state and retries re-abort on a later event after failure", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice", "error", "failed")
    let attempts = 0
    deps.client.session.abort = async options => {
      deps.client.calls.push({ method: "session.abort", args: [options] })
      attempts += 1
      if (attempts === 1) throw new Error("runner not reachable")
      return {}
    }
    const guard = new TerminalLivenessGuard(deps)

    expect(await guard.handle("sess-alice", "retry")).toBe(true)
    expect(deps.db.query("SELECT status, execution_status FROM team_member WHERE name = 'alice'").get())
      .toEqual({ status: "error", execution_status: "failed" })
    expect((deps.db.query("SELECT content FROM team_message WHERE team_id = 't1' AND to_name = 'lead'").get() as { content: string }).content)
      .toContain("late retry")

    expect(await guard.handle("sess-alice", "retry")).toBe(true)
    expect(deps.client.calls.filter(call => call.method === "session.abort")).toHaveLength(2)
  })
})
