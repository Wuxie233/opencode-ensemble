import { describe, expect, test } from "bun:test"
import { appendTeamEvent } from "../../src/team-event"
import { executeTeamMetrics } from "../../src/metrics"
import { insertMember, insertTeam, setupDb, setupDeps } from "../helpers"

const TO = new Date(Date.now() + 60_000).toISOString()
const FROM = new Date(Date.now() - 60_000).toISOString()

function insertEvent(db: ReturnType<typeof setupDb>, id: string, teamId: string, kind: string, time: number, version: number | null = 1, payload = "{}") {
  db.run(
    "INSERT INTO team_event (id, team_id, kind, payload, time_created, instrumentation_version) VALUES (?, ?, ?, ?, ?, ?)",
    [id, teamId, kind, payload, time, version],
  )
}

function seedTeam() {
  const db = setupDb()
  insertTeam(db, "team-one", "team-one", "lead-session")
  appendTeamEvent(db, { teamId: "team-one", kind: "team.created", payload: {} })
  appendTeamEvent(db, { teamId: "team-one", kind: "task.created", payload: { task_id: "task-one", status: "pending" } })
  appendTeamEvent(db, { teamId: "team-one", kind: "team.archived", payload: {} })
  return db
}

describe("team_metrics", () => {
  test("returns aggregate coverage and cycle time without operational text", () => {
    const db = seedTeam()
    const deps = setupDeps(db)
    const body = JSON.parse(executeTeamMetrics(db, deps.registry, {
      scope: { project: "/tmp/test-project" },
      window: { from: FROM, to: TO },
      view: "summary",
      metrics: ["cycle_time_ms_p50", "task_created"],
    }, "lead-session")) as Record<string, unknown>
    expect(body.view).toBe("summary")
    expect(body.request_window).toEqual({ from: FROM, to: TO })
    expect(body.coverage).toMatchObject({ sample_size: 1, instrumentation_version: [1] })
    expect(JSON.stringify(body)).not.toContain("team-one")
    expect(JSON.stringify(body)).not.toContain("task-one")
  })

  test("allows a member only its own explicit timeline and projects safe payload keys", () => {
    const db = seedTeam()
    insertMember(db, "team-one", "worker", "worker-session")
    const deps = setupDeps(db)
    const body = JSON.parse(executeTeamMetrics(db, deps.registry, {
      scope: { team_ids: ["team-one"] },
      window: { from: FROM, to: TO },
      view: "timeline",
      metrics: ["task_created"],
      limit: 10,
    }, "worker-session")) as { events: Array<{ team_id: string; payload: Record<string, unknown> }> }
    expect(body.events.some(event => event.team_id === "team-one")).toBe(true)
    const task = body.events.find(event => event.payload.task_id === "task-one")
    expect(task?.payload).toEqual({ task_id: "task-one", status: "pending" })
    expect(JSON.stringify(body)).not.toContain("worker")
  })

  test("rejects invalid windows, unknown metrics, cursors, and unscoped timelines", () => {
    const db = seedTeam()
    const deps = setupDeps(db)
    const request = { view: "summary" as const, metrics: ["task_created"], window: { from: FROM, to: TO } }
    expect(() => executeTeamMetrics(db, deps.registry, { ...request, metrics: ["not_a_metric"] }, "lead-session")).toThrow("invalid or outside")
    expect(() => executeTeamMetrics(db, deps.registry, { ...request, cursor: "anything" }, "lead-session")).toThrow("invalid or outside")
    expect(() => executeTeamMetrics(db, deps.registry, { ...request, view: "timeline" }, "lead-session")).toThrow("invalid or outside")
    expect(() => executeTeamMetrics(db, deps.registry, { ...request, window: { from: "2026-07-01T00:00:00Z", to: TO } }, "lead-session")).toThrow("invalid or outside")
  })

  test("returns structured unsupported reasons instead of inventing quality metrics", () => {
    const db = seedTeam()
    const deps = setupDeps(db)
    const body = JSON.parse(executeTeamMetrics(db, deps.registry, {
      window: { from: FROM, to: TO }, view: "summary", metrics: ["verified_outcome_rate", "cost_per_verified_outcome"],
    }, "lead-session")) as { metrics: Array<{ supported: boolean; value: number | null; unsupported_reason: string }> }
    expect(body.metrics).toHaveLength(2)
    expect(body.metrics.every(metric => metric.supported === false && metric.value === null && metric.unsupported_reason.length > 0)).toBe(true)
  })

  test("uses only in-window Team starts as the aggregate cohort and marks unfinished Teams censored", () => {
    const db = setupDb()
    insertTeam(db, "old-team", "old-team", "lead-session")
    insertTeam(db, "current-team", "current-team", "lead-session")
    db.run("UPDATE team SET project_id = '/tmp/test-project' WHERE id IN ('old-team', 'current-team')")
    const before = Date.parse(FROM) - 1
    db.run(
      "INSERT INTO team_event (id, team_id, kind, payload, time_created, instrumentation_version) VALUES ('event-old', 'old-team', 'team.created', '{}', ?, 1)",
      [before],
    )
    appendTeamEvent(db, { teamId: "current-team", kind: "team.created", payload: {} })
    const deps = setupDeps(db)
    const body = JSON.parse(executeTeamMetrics(db, deps.registry, {
      window: { from: FROM, to: TO }, view: "summary", metrics: ["team_created", "cycle_time_ms_p50"],
    }, "lead-session")) as { coverage: { denominator: number; censored: number }; metrics: Array<{ metric: string; censored: number }> }
    expect(body.coverage).toMatchObject({ denominator: 1, censored: 1 })
    expect(body.metrics.find(metric => metric.metric === "cycle_time_ms_p50")?.censored).toBe(1)
  })

  test("compares one mechanism with none and suppresses project-wide cells below five Teams", () => {
    const db = setupDb()
    for (let index = 0; index < 6; index++) {
      const id = `team-${index}`
      insertTeam(db, id, id, "lead-session")
      appendTeamEvent(db, { teamId: id, kind: "team.created", payload: {} })
      if (index === 0) appendTeamEvent(db, { teamId: id, kind: "plan.approved", payload: { member_name: "worker" } })
    }
    const deps = setupDeps(db)
    const body = JSON.parse(executeTeamMetrics(db, deps.registry, {
      window: { from: FROM, to: TO },
      view: "compare",
      metrics: ["task_completed"],
      compare: { dimension: "mechanism", values: ["plan_approval", "none"] },
    }, "lead-session")) as { groups: Array<{ key: string; suppressed?: boolean; n?: number; metrics?: unknown[] }> }
    expect(body.groups).toEqual([
      { key: "plan_approval", suppressed: true, suppression_reason: "fewer than five Teams" },
      expect.objectContaining({ key: "none", n: 5, metrics: expect.any(Array) }),
    ])
  })

  test("rejects unknown timeline metrics before returning events", () => {
    const db = seedTeam()
    const deps = setupDeps(db)
    expect(() => executeTeamMetrics(db, deps.registry, {
      scope: { team_ids: ["team-one"] }, window: { from: FROM, to: TO }, view: "timeline", metrics: ["private_metric"],
    }, "lead-session")).toThrow("invalid or outside")
  })

  test("rejects cross-project Team scope and another member's Team without leaking existence", () => {
    const db = setupDb()
    insertTeam(db, "team-one", "team-one", "lead-one")
    db.run(
      "INSERT INTO project (id, name, path, status, time_created, time_updated, slug) VALUES ('project-two', 'project-two', '/tmp/project-two', 'active', 1, 1, 'project-two')",
    )
    db.run(
      "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('team-two', 'team-two', 'project-two', 'lead-two', 'active', 0, 1, 1)",
    )
    insertMember(db, "team-one", "alice", "alice-session")
    insertMember(db, "team-one", "bob", "bob-session")
    appendTeamEvent(db, { teamId: "team-one", kind: "team.created", payload: {} })
    appendTeamEvent(db, { teamId: "team-two", kind: "team.created", payload: {} })
    const deps = setupDeps(db)
    const request = { window: { from: FROM, to: TO }, view: "timeline" as const, metrics: ["team_created"] }

    expect(() => executeTeamMetrics(db, deps.registry, { ...request, scope: { team_ids: ["team-two"] } }, "lead-one"))
      .toThrow("Metrics request is invalid or outside caller scope")
    expect(() => executeTeamMetrics(db, deps.registry, { ...request, scope: { team_ids: ["team-two"] } }, "alice-session"))
      .toThrow("Metrics request is invalid or outside caller scope")
  })

  test("does not return a lifetime usage aggregate when its coverage crosses the request window", () => {
    const db = seedTeam()
    insertMember(db, "team-one", "worker", "worker-session")
    db.run(
      `INSERT INTO team_usage_aggregate
         (team_id, member_name, input_tokens, output_tokens, cost, event_count, coverage_start, coverage_end, instrumentation_version)
       VALUES ('team-one', 'worker', 100, 20, 0.1, 2, ?, ?, 1)`,
      [Date.parse(FROM) - 1, Date.parse(TO) - 1],
    )
    const deps = setupDeps(db)
    const body = JSON.parse(executeTeamMetrics(db, deps.registry, {
      window: { from: FROM, to: TO }, view: "summary", metrics: ["input_tokens"],
    }, "lead-session")) as { metrics: Array<{ value: number | null; unknown: number; sample_size: number }> }
    expect(body.metrics[0]).toMatchObject({ value: null, unknown: 1, sample_size: 0 })
  })

  test("filters by persisted member dimensions and returns matched model strata with uncertainty", () => {
    const db = setupDb()
    for (let index = 0; index < 10; index++) {
      const id = `team-${index}`
      insertTeam(db, id, id, "lead-session")
      insertMember(db, id, "worker", `session-${index}`)
      db.run("UPDATE team_member SET profile = 'backend', model = ? WHERE team_id = ?", [index < 5 ? "provider/a" : "provider/b", id])
      appendTeamEvent(db, { teamId: id, kind: "team.created", payload: {} })
      appendTeamEvent(db, { teamId: id, kind: "merge.started", payload: { member_name: "worker" } })
      if (index !== 9) appendTeamEvent(db, { teamId: id, kind: "merge.completed", payload: { member_name: "worker" } })
    }
    const deps = setupDeps(db)
    const body = JSON.parse(executeTeamMetrics(db, deps.registry, {
      window: { from: FROM, to: TO },
      filters: { profile: ["backend"], status: ["active"], instrumentation_version: ["1"] },
      view: "compare",
      metrics: ["merge_reliability"],
      compare: { dimension: "model", values: ["provider/a", "provider/b"] },
      group_by: "profile",
    }, "lead-session")) as { matched_strata: Array<{ key: string; groups: Array<{ key: string; n: number; metrics: Array<{ uncertainty: { method: string } }> }> }> }

    expect(body.matched_strata).toHaveLength(1)
    expect(body.matched_strata[0]?.key).toBe("backend")
    expect(body.matched_strata[0]?.groups.map(group => [group.key, group.n])).toEqual([["provider/a", 5], ["provider/b", 5]])
    expect(body.matched_strata[0]?.groups.every(group => group.metrics[0]?.uncertainty.method === "wilson_95")).toBe(true)
  })

  test("rejects invalid filter, grouping, comparison, percentile, and cursor contracts", () => {
    const db = seedTeam()
    const deps = setupDeps(db)
    const base = { window: { from: FROM, to: TO }, view: "compare" as const, metrics: ["task_created"] }
    expect(() => executeTeamMetrics(db, deps.registry, { ...base, filters: { status: ["secret"] } }, "lead-session")).toThrow("invalid or outside")
    expect(() => executeTeamMetrics(db, deps.registry, { ...base, compare: { dimension: "execution_mode", values: ["ensemble"] } }, "lead-session")).toThrow("invalid or outside")
    expect(() => executeTeamMetrics(db, deps.registry, { ...base, compare: { dimension: "model", values: ["a", "b"] }, group_by: "model" }, "lead-session")).toThrow("invalid or outside")
    expect(() => executeTeamMetrics(db, deps.registry, { ...base, compare: { dimension: "model", values: ["a", "b"] }, cursor: "0" }, "lead-session")).toThrow("invalid or outside")
    expect(() => executeTeamMetrics(db, deps.registry, { ...base, percentile: 50 } as typeof base, "lead-session")).toThrow("invalid or outside")
    expect(() => executeTeamMetrics(db, deps.registry, { ...base, metrics: ["cycle_time_ms"] } as typeof base, "lead-session")).toThrow("invalid or outside")
    expect(() => executeTeamMetrics(db, deps.registry, { ...base, metrics: ["cycle_time_ms"], percentile: 75 } as typeof base, "lead-session")).toThrow("invalid or outside")
  })

  test("applies requested p50, p90, and p95 cycle-time percentiles", () => {
    const db = setupDb()
    const start = Date.parse(FROM) + 1_000
    const durations = [100, 200, 300, 400, 500, 600, 700, 800, 900, 10_000]
    durations.forEach((duration, index) => {
      const id = `team-${index}`
      insertTeam(db, id, id, "lead-session")
      insertEvent(db, `created-${index}`, id, "team.created", start)
      insertEvent(db, `archived-${index}`, id, "team.archived", start + duration)
    })
    const deps = setupDeps(db)
    const values = ([50, 90, 95] as const).map(requested => {
      const body = JSON.parse(executeTeamMetrics(db, deps.registry, {
        window: { from: FROM, to: TO }, view: "summary", metrics: ["cycle_time_ms"], percentile: requested,
      }, "lead-session")) as { metrics: Array<{ percentile: number; value: number }> }
      return [body.metrics[0]?.percentile, body.metrics[0]?.value]
    })

    expect(values).toEqual([[50, 500], [90, 900], [95, 10_000]])
  })

  test("rejects unavailable owner-supplied workflow dimensions explicitly", () => {
    const db = seedTeam()
    const deps = setupDeps(db)
    const request = { window: { from: FROM, to: TO }, view: "summary" as const, metrics: ["team_created"] }

    expect(() => executeTeamMetrics(db, deps.registry, { ...request, filters: { workflow_kind: ["delivery"] } }, "lead-session"))
      .toThrow("workflow_kind is unsupported")
    expect(() => executeTeamMetrics(db, deps.registry, { ...request, filters: { complexity_band: ["large"] } }, "lead-session"))
      .toThrow("complexity_band is unsupported")
  })

  test("excludes legacy Teams with unknown plan approval observability", () => {
    const db = setupDb()
    for (let index = 0; index < 11; index++) {
      const id = `team-${index}`
      insertTeam(db, id, id, "lead-session")
      const version = index === 0 ? null : 1
      insertEvent(db, `created-${index}`, id, "team.created", Date.now(), version)
      if (index < 6) insertEvent(db, `approved-${index}`, id, "plan.approved", Date.now() + 1, version, '{"member_name":"worker"}')
    }
    const deps = setupDeps(db)
    const summary = JSON.parse(executeTeamMetrics(db, deps.registry, {
      window: { from: FROM, to: TO }, view: "summary", metrics: ["plan_approval_adoption"],
    }, "lead-session")) as { metrics: Array<{ denominator: number; unknown: number }> }
    const comparison = JSON.parse(executeTeamMetrics(db, deps.registry, {
      window: { from: FROM, to: TO }, view: "compare", metrics: ["task_completed"],
      compare: { dimension: "mechanism", values: ["plan_approval", "none"] },
    }, "lead-session")) as { groups: Array<{ key: string; n: number }> ; unknown_count: number }

    expect(summary.metrics[0]).toMatchObject({ denominator: 10, unknown: 1 })
    expect(comparison.groups.map(group => [group.key, group.n])).toEqual([["plan_approval", 5], ["none", 5]])
    expect(comparison.unknown_count).toBe(1)
  })

  test("excludes legacy events from generic metrics and mechanism filters while preserving explicit timeline history", () => {
    const db = setupDb()
    insertTeam(db, "legacy", "legacy", "lead-session")
    insertTeam(db, "current", "current", "lead-session")
    const now = Date.now()
    insertEvent(db, "legacy-created", "legacy", "team.created", now, null)
    insertEvent(db, "legacy-task", "legacy", "task.created", now + 1, null, '{"task_id":"legacy-task","status":"pending"}')
    insertEvent(db, "legacy-approved", "legacy", "plan.approved", now + 2, null, '{"member_name":"worker"}')
    insertEvent(db, "current-created", "current", "team.created", now)
    insertEvent(db, "current-task", "current", "task.created", now + 1)
    const deps = setupDeps(db)
    const summary = JSON.parse(executeTeamMetrics(db, deps.registry, {
      window: { from: FROM, to: TO }, view: "summary", metrics: ["team_created", "task_created"],
    }, "lead-session")) as { coverage: { sample_size: number; denominator: number; unknown: number }; metrics: Array<{ value: number; denominator: number; unknown: number }> }
    const filtered = JSON.parse(executeTeamMetrics(db, deps.registry, {
      window: { from: FROM, to: TO }, filters: { mechanism: ["plan_approval"] }, view: "summary", metrics: ["task_created"],
    }, "lead-session")) as { coverage: { denominator: number; unknown: number }; metrics: Array<{ value: number; unknown: number }> }
    const history = JSON.parse(executeTeamMetrics(db, deps.registry, {
      scope: { team_ids: ["legacy"] }, window: { from: FROM, to: TO }, view: "timeline", metrics: ["task_created"],
    }, "lead-session")) as { events: Array<{ id: string }> }

    expect(summary.coverage).toMatchObject({ sample_size: 1, denominator: 2, unknown: 1 })
    expect(summary.metrics).toEqual([
      expect.objectContaining({ value: 1, denominator: 2, unknown: 1 }),
      expect.objectContaining({ value: 1, denominator: 1, unknown: 1 }),
    ])
    expect(filtered.coverage).toMatchObject({ denominator: 1, unknown: 1 })
    expect(filtered.metrics[0]).toMatchObject({ value: 0, unknown: 1 })
    expect(history.events.map(event => event.id)).toContain("legacy-task")
  })

  test("keeps funnel stages ordered and monotonic for partial or out-of-order lifecycles", () => {
    const db = setupDb()
    insertTeam(db, "complete", "complete", "lead-session")
    insertTeam(db, "partial", "partial", "lead-session")
    insertTeam(db, "out-of-order", "out-of-order", "lead-session")
    const now = Date.now()
    insertEvent(db, "complete-1", "complete", "team.created", now)
    insertEvent(db, "complete-2", "complete", "member.registered", now + 1, 1, '{"member_name":"worker"}')
    insertEvent(db, "complete-3", "complete", "task.created", now + 2, 1, '{"task_id":"task-a","status":"pending"}')
    insertEvent(db, "complete-4", "complete", "task.completed", now + 3, 1, '{"task_id":"task-a"}')
    insertEvent(db, "complete-5", "complete", "team.archived", now + 4)
    insertEvent(db, "partial-1", "partial", "team.created", now)
    insertEvent(db, "partial-2", "partial", "member.registered", now + 1, 1, '{"member_name":"worker"}')
    insertEvent(db, "out-1", "out-of-order", "team.created", now)
    insertEvent(db, "out-2", "out-of-order", "task.completed", now + 1, 1, '{"task_id":"task-b"}')
    insertEvent(db, "out-3", "out-of-order", "team.archived", now + 2)
    const deps = setupDeps(db)
    const body = JSON.parse(executeTeamMetrics(db, deps.registry, {
      window: { from: FROM, to: TO }, view: "funnel", metrics: ["team_created"],
    }, "lead-session")) as { stages: Array<{ kind: string; count: number }> }

    expect(body.stages).toEqual([
      { kind: "team.created", count: 3 },
      { kind: "member.registered", count: 2 },
      { kind: "task.created", count: 1 },
      { kind: "task.completed", count: 1 },
      { kind: "team.archived", count: 1 },
    ])
  })

  test("omits suppressed compare strata before cursor pagination", () => {
    const db = setupDb()
    const start = Date.parse("2026-07-01T00:00:00.000Z")
    for (let day = 0; day < 3; day++) {
      for (let index = 0; index < 10; index++) {
        const id = `team-${day}-${index}`
        insertTeam(db, id, id, "lead-session")
        insertEvent(db, `created-${day}-${index}`, id, "team.created", start + day * 86_400_000)
        if (index < (day === 0 ? 1 : 5)) insertEvent(db, `approved-${day}-${index}`, id, "plan.approved", start + day * 86_400_000 + 1, 1, '{"member_name":"worker"}')
      }
    }
    const deps = setupDeps(db)
    const request = {
      window: { from: "2026-07-01T00:00:00.000Z", to: "2026-07-04T00:00:00.000Z" },
      view: "compare" as const,
      metrics: ["task_completed"],
      compare: { dimension: "mechanism" as const, values: ["plan_approval", "none"] },
      group_by: "day" as const,
      limit: 1,
    }
    const first = JSON.parse(executeTeamMetrics(db, deps.registry, request, "lead-session")) as { matched_strata: Array<{ key: string; groups: Array<{ suppressed?: boolean }> }>; next_cursor: string }
    const second = JSON.parse(executeTeamMetrics(db, deps.registry, { ...request, cursor: first.next_cursor }, "lead-session")) as { matched_strata: Array<{ key: string; groups: Array<{ suppressed?: boolean }> }>; next_cursor: string }

    expect(first.matched_strata[0]?.key).toBe("2026-07-02")
    expect(first.matched_strata[0]?.groups.every(group => group.suppressed !== true)).toBe(true)
    expect(second.matched_strata[0]?.key).toBe("2026-07-03")
    expect(second.next_cursor).toBeUndefined()
  })
})
