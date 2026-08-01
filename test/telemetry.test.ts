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
      type: "session.next.step.ended",
      properties: { sessionID: "private-session", tokens: { input: 100, output: 20 }, cost: 0.01 },
    })
    recordUsageFromV2Event(deps.db, deps.registry, {
      type: "session.next.step.ended",
      properties: { sessionID: "private-session", tokens: { input: 50, output: 10 }, cost: 0.02 },
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
  })

  test("ignores invalid, unknown, and archived usage without throwing", () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "team", "lead", "archived")
    insertMember(deps.db, "t1", "alice", "session")
    deps.registry.register("t1", "alice", "session")

    expect(() => recordUsageFromV2Event(deps.db, deps.registry, {
      type: "session.next.step.ended",
      properties: { sessionID: "session", tokens: { input: -1, output: Number.NaN }, cost: Number.POSITIVE_INFINITY },
    })).not.toThrow()
    expect(() => recordUsageFromV2Event(deps.db, deps.registry, {
      type: "session.next.step.ended",
      properties: { sessionID: "unknown", tokens: { input: 5 } },
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
      type: "session.next.step.ended",
      properties: { sessionID: "session", tokens: { input: 5 } },
    })).not.toThrow()
    expect(deps.db.query("SELECT * FROM team_usage_aggregate").all()).toEqual([])
  })
})
