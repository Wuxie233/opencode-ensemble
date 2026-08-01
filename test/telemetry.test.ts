import { describe, expect, test } from "bun:test"
import { recordUsageFromV2Event } from "../src/telemetry"
import { insertMember, insertTeam, setupDeps } from "./helpers"

describe("usage telemetry", () => {
  test("aggregates numeric usage without persisting Session or content values", () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "team", "lead")
    insertMember(deps.db, "t1", "alice", "private-session")
    deps.registry.register("t1", "alice", "private-session")

    recordUsageFromV2Event(deps.db, deps.registry, {
      id: "usage-1",
      type: "session.next.step.ended",
      properties: { sessionID: "private-session", timestamp: 1_000, tokens: { input: 100, output: 20 }, cost: 0.01 },
    })
    recordUsageFromV2Event(deps.db, deps.registry, {
      id: "usage-2",
      type: "session.next.step.ended",
      properties: { sessionID: "private-session", timestamp: 2_000, tokens: { input: 50, output: 10 }, cost: 0.02 },
    })

    expect(deps.db.query(
      "SELECT team_id, member_name, input_tokens, output_tokens, cost, event_count, instrumentation_version FROM team_usage_aggregate",
    ).get()).toEqual({
      team_id: "t1",
      member_name: "alice",
      input_tokens: 150,
      output_tokens: 30,
      cost: 0.03,
      event_count: 2,
      instrumentation_version: 1,
    })
    const columns = deps.db.query("PRAGMA table_info(team_usage_aggregate)").all() as Array<{ name: string }>
    expect(columns.map(column => column.name)).not.toEqual(expect.arrayContaining(["session_id", "model", "content", "error", "branch", "path"]))
    expect(JSON.stringify(deps.db.query("SELECT * FROM team_usage_event").all())).not.toContain("usage-1")
  })

  test("uses SDK timestamps for coverage and ignores duplicate or replayed events", () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "team", "lead")
    insertMember(deps.db, "t1", "alice", "session")
    deps.registry.register("t1", "alice", "session")
    const delayed = {
      id: "usage-delayed",
      type: "session.next.step.ended",
      properties: { sessionID: "session", timestamp: 1_000, tokens: { input: 5 }, cost: 0.01 },
    }

    recordUsageFromV2Event(deps.db, deps.registry, {
      id: "usage-later",
      type: "session.next.step.ended",
      properties: { sessionID: "session", timestamp: 2_000, tokens: { output: 7 }, cost: 0.02 },
    })
    recordUsageFromV2Event(deps.db, deps.registry, delayed)
    recordUsageFromV2Event(deps.db, deps.registry, delayed)

    expect(deps.db.query(
      "SELECT input_tokens, output_tokens, cost, event_count, coverage_start, coverage_end FROM team_usage_aggregate",
    ).get()).toEqual({
      input_tokens: 5,
      output_tokens: 7,
      cost: 0.03,
      event_count: 2,
      coverage_start: 1_000,
      coverage_end: 2_000,
    })
    expect(deps.db.query("SELECT COUNT(*) AS count FROM team_usage_event").get()).toEqual({ count: 2 })
  })

  test("ignores invalid, unknown, and archived usage without throwing", () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "team", "lead", "archived")
    insertMember(deps.db, "t1", "alice", "session")
    deps.registry.register("t1", "alice", "session")

    expect(() => recordUsageFromV2Event(deps.db, deps.registry, {
      id: "usage-invalid",
      type: "session.next.step.ended",
      properties: { sessionID: "session", timestamp: 1_000, tokens: { input: -1, output: Number.NaN }, cost: Number.POSITIVE_INFINITY },
    })).not.toThrow()
    expect(() => recordUsageFromV2Event(deps.db, deps.registry, {
      id: "usage-unknown",
      type: "session.next.step.ended",
      properties: { sessionID: "unknown", timestamp: 1_000, tokens: { input: 5 } },
    })).not.toThrow()
    expect(deps.db.query("SELECT * FROM team_usage_aggregate").all()).toEqual([])
  })

  test("swallows aggregate persistence failures", () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "team", "lead")
    insertMember(deps.db, "t1", "alice", "session")
    deps.registry.register("t1", "alice", "session")
    deps.db.exec("CREATE TRIGGER reject_usage BEFORE INSERT ON team_usage_aggregate BEGIN SELECT RAISE(ABORT, 'reject'); END")

    expect(() => recordUsageFromV2Event(deps.db, deps.registry, {
      id: "usage-rejected",
      type: "session.next.step.ended",
      properties: { sessionID: "session", timestamp: 1_000, tokens: { input: 5 } },
    })).not.toThrow()
    expect(deps.db.query("SELECT * FROM team_usage_aggregate").all()).toEqual([])
    expect(deps.db.query("SELECT * FROM team_usage_event").all()).toEqual([])
  })
})
