import { describe, expect, test } from "bun:test"
import { appendTeamEvent } from "../../src/team-event"
import { executeTeamMetrics } from "../../src/metrics"
import { insertMember, insertTeam, setupDb, setupDeps } from "../helpers"

const TO = new Date(Date.now() + 60_000).toISOString()
const FROM = new Date(Date.now() - 60_000).toISOString()

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
})
