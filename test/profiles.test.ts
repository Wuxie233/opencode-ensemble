import { describe, expect, test } from "bun:test"
import { resolveProfile } from "../src/profiles"
import { executeTeamSpawn } from "../src/tools/team-spawn"
import { insertTeam, setupDeps } from "./helpers"

describe("Ensemble profiles", () => {
  test("maps broad profiles to runtime agents and access capabilities", () => {
    expect(resolveProfile("general", undefined)).toMatchObject({ agent: "build", access: "write" })
    const scout = resolveProfile("scout", undefined)
    expect(scout).toMatchObject({ agent: "explore", access: "read" })
    expect(scout.capabilities).toContain("file_read")
    expect(scout.capabilities).toContain("shell")
    expect(resolveProfile("planner", undefined)).toMatchObject({ agent: "plan", access: "read" })
    expect(resolveProfile("frontend", undefined)).toMatchObject({ agent: "build", access: "write" })
    expect(resolveProfile(undefined, "explore")).toMatchObject({ name: "scout", agent: "explore" })
  })

  test("uses general only as the explicit default and rejects unknown profiles", () => {
    expect(resolveProfile(undefined, undefined).name).toBe("general")
    expect(() => resolveProfile("typo", undefined)).toThrow('Unknown Ensemble profile "typo"')
  })

  test("rejects an unknown profile before task claim or resource creation", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    deps.db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES ('task-1', 't1', 'Task', 'pending', 'high', 1, 1)",
    )

    await expect(
      executeTeamSpawn(
        deps,
        { name: "alice", profile: "typo", prompt: "Implement", claim_task: "task-1" },
        "lead-sess",
      ),
    ).rejects.toThrow('Unknown Ensemble profile "typo"')

    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id = 'task-1'").get()).toEqual({
      status: "pending",
      assignee: null,
    })
    expect(deps.client.calls).toHaveLength(0)
  })

  test("rejects writer worktree bypass before task claim or resource creation", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    deps.db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES ('task-1', 't1', 'Task', 'pending', 'high', 1, 1)",
    )

    await expect(
      executeTeamSpawn(
        deps,
        { name: "alice", profile: "backend", prompt: "Implement", claim_task: "task-1", worktree: false },
        "lead-sess",
      ),
    ).rejects.toThrow("requires an isolated worktree")

    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id = 'task-1'").get()).toEqual({
      status: "pending",
      assignee: null,
    })
    expect(deps.client.calls).toHaveLength(0)
  })

  test("allows multiple members with the same profile", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "my-team", "lead-sess")

    await executeTeamSpawn(deps, { name: "api-a", profile: "backend", prompt: "Slice A" }, "lead-sess")
    await executeTeamSpawn(deps, { name: "api-b", profile: "backend", prompt: "Slice B" }, "lead-sess")

    expect(deps.db.query("SELECT name, profile FROM team_member ORDER BY name").all()).toEqual([
      { name: "api-a", profile: "backend" },
      { name: "api-b", profile: "backend" },
    ])
  })
})
