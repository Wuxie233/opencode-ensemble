import { describe, test, expect, beforeEach } from "bun:test"
import { setupDeps, insertTeam } from "../helpers"
import { executeTeamCreate } from "../../src/tools/team-create"
import type { ToolDeps } from "../../src/types"

describe("team_create", () => {
  let deps: ToolDeps

  beforeEach(() => {
    deps = setupDeps()
  })

  test("creates a team and returns confirmation", async () => {
    const result = await executeTeamCreate(deps, { name: "my-team" }, "lead-sess")
    expect(result).toContain("my-team")
    expect(result).toContain("created")

    const row = deps.db.query("SELECT * FROM team WHERE name = ?").get("my-team") as Record<string, unknown>
    expect(row).toBeTruthy()
    expect(row.lead_session_id).toBe("lead-sess")
    expect(row.project_id).toBe("/tmp/test-project")
    expect(row.status).toBe("active")
    expect(row.controller_directory).toBe("/tmp/test-project")

    const project = deps.db.query("SELECT id, name, path, git_identity FROM project WHERE id = ?").get("/tmp/test-project") as Record<string, unknown>
    expect(project.path).toBe("/tmp/test-project")
    expect(typeof project.name).toBe("string")
    expect(project.name).not.toBe("test-project")
    expect(project.git_identity).toBe("/tmp/test-project/.git")
  })

  test("binds an explicit nested target separately from the controller directory", async () => {
    deps.directory = "/controller"
    deps.repositoryBindingOps = {
      ...deps.repositoryBindingOps!,
      async canonicalControllerDirectory() { return "/controller" },
      async verifyRepositoryRoot() { return { repositoryRoot: "/controller/nested", gitIdentity: "/controller/nested/.git" } },
    }

    await executeTeamCreate(deps, { name: "nested", repository_root: "/controller/nested" }, "nested-lead")

    expect(deps.db.query(
      `SELECT t.project_id, t.controller_directory, p.path, p.git_identity
       FROM team t JOIN project p ON p.id = t.project_id WHERE t.name = 'nested'`,
    ).get()).toEqual({
      project_id: "/controller/nested",
      controller_directory: "/controller",
      path: "/controller/nested",
      git_identity: "/controller/nested/.git",
    })
  })

  test("rejects a repository replaced under an existing canonical path", async () => {
    deps.db.run(
      "INSERT INTO project (id, name, path, git_identity, status, time_created, time_updated) VALUES ('/tmp/test-project', 'existing', '/tmp/test-project', '/tmp/test-project/.git', 'active', 1, 1)",
    )
    deps.repositoryBindingOps = {
      ...deps.repositoryBindingOps!,
      async verifyRepositoryRoot() { return { repositoryRoot: "/tmp/test-project", gitIdentity: "/replacement/.git" } },
    }

    await expect(executeTeamCreate(deps, { name: "replacement" }, "replacement-lead"))
      .rejects.toThrow("Git identity changed")
  })

  test("uses explicit project name on first team in a project", async () => {
    await executeTeamCreate(deps, { name: "my-team", project_name: "silver-river" }, "lead-sess")

    const project = deps.db.query("SELECT name FROM project WHERE id = ?").get("/tmp/test-project") as { name: string }
    expect(project.name).toBe("silver-river")
  })

  test("accepts a localized project display name", async () => {
    await executeTeamCreate(deps, { name: "my-team", project_name: "银色河流项目" }, "lead-sess")
    const project = deps.db.query("SELECT name FROM project WHERE id = ?").get("/tmp/test-project") as { name: string }
    expect(project.name).toBe("银色河流项目")
  })

  test("rejects duplicate team name", async () => {
    await executeTeamCreate(deps, { name: "my-team" }, "lead-sess")
    await expect(executeTeamCreate(deps, { name: "my-team" }, "other-sess"))
      .rejects.toThrow("already exists")
  })

  test("allows same active team name in different projects", async () => {
    await executeTeamCreate(deps, { name: "my-team" }, "lead-sess")

    const otherDeps = setupDeps(deps.db)
    otherDeps.directory = "/tmp/other-project"

    await executeTeamCreate(otherDeps, { name: "my-team" }, "other-sess")

    const rows = deps.db.query("SELECT name, project_id FROM team WHERE name = ? ORDER BY project_id").all("my-team") as Array<{ name: string; project_id: string }>
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.project_id)).toEqual(["/tmp/other-project", "/tmp/test-project"])
  })

  test("rejects if session already leads a team", async () => {
    await executeTeamCreate(deps, { name: "team-a" }, "lead-sess")
    await expect(executeTeamCreate(deps, { name: "team-b" }, "lead-sess"))
      .rejects.toThrow("already")
  })

  test("rejects invalid team name", async () => {
    await expect(executeTeamCreate(deps, { name: "My Team!" }, "lead-sess"))
      .rejects.toThrow()
  })

  test("rejects empty team name", async () => {
    await expect(executeTeamCreate(deps, { name: "" }, "lead-sess"))
      .rejects.toThrow()
  })

  test("response is clean without LLM instructions", async () => {
    const result = await executeTeamCreate(deps, { name: "my-team" }, "lead-sess")
    expect(result).toContain("team_spawn")
    expect(result).not.toContain("STOP")
    expect(result).not.toContain("do NOT call")
    expect(result).not.toContain("do not poll")
    expect(result).not.toContain("woken automatically")
  })
})
