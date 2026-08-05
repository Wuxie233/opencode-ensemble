import { describe, expect, test } from "bun:test"
import { recoverSpawnAttempts } from "../src/spawn-attempt-recovery"
import { insertTeam, setupDeps } from "./helpers"

function insertClaimedAttempt(deps: ReturnType<typeof setupDeps>, stage: string): void {
  const now = Date.now()
  deps.db.run(
    `INSERT INTO team_task
       (id, team_id, content, status, priority, assignee, time_created, time_updated)
     VALUES ('task-1', 't1', 'work', 'in_progress', 'high', 'writer', ?, ?)`,
    [now, now],
  )
  deps.db.run(
    `INSERT INTO team_spawn_attempt
       (team_id, name, repository_root, repository_git_identity, worktree_name,
        stage, worktree_dir, worktree_branch, worktree_source_branch, workspace_id,
        claim_task_id, claim_event_id, time_created, time_updated)
     VALUES ('t1', 'writer', '/tmp/test-project', '/tmp/test-project/.git', 'writer-wt',
       ?, '/tmp/writer-wt', 'writer-branch', 'writer-branch', 'ws-writer',
       'task-1', NULL, ?, ?)`,
    [stage, now, now],
  )
}

describe("spawn attempt recovery", () => {
  test("removes reconciled resources and releases the claimed task", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "team", "lead")
    insertClaimedAttempt(deps, "workspace_creating")
    deps.client.worktree.list = async () => ({ data: [{ name: "writer-wt", branch: "writer-branch", directory: "/tmp/writer-wt" }] })
    deps.client.workspace.list = async () => ({ data: [{ id: "ws-writer", type: "worktree", branch: "writer-branch", directory: null, projectID: "p" }] })

    expect(await recoverSpawnAttempts(deps.db, deps.client, undefined, "t1"))
      .toEqual({ recovered: 1, blocked: 0 })
    expect(deps.db.query("SELECT name FROM team_spawn_attempt").all()).toHaveLength(0)
    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id = 'task-1'").get())
      .toEqual({ status: "pending", assignee: null })
    expect(deps.client.calls.find(call => call.method === "workspace.remove")?.args[0])
      .toEqual({ directory: "/tmp/test-project", id: "ws-writer" })
    expect(deps.client.calls.find(call => call.method === "worktree.remove")?.args[0])
      .toEqual({ directory: "/tmp/test-project", worktreeRemoveInput: { directory: "/tmp/writer-wt" } })
  })

  test("keeps an unresolved session-create timeout fail closed", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "team", "lead")
    insertClaimedAttempt(deps, "session_creating")

    expect(await recoverSpawnAttempts(deps.db, deps.client, undefined, "t1"))
      .toEqual({ recovered: 0, blocked: 1 })
    expect(deps.db.query("SELECT name FROM team_spawn_attempt").all()).toHaveLength(1)
    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id = 'task-1'").get())
      .toEqual({ status: "in_progress", assignee: "writer" })
    expect(deps.client.calls).toHaveLength(0)
  })

  test("does not release a worktree-create attempt before a late resource appears", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "team", "lead")
    insertClaimedAttempt(deps, "worktree_creating")
    deps.db.run(
      "UPDATE team_spawn_attempt SET worktree_dir = NULL, worktree_branch = NULL, worktree_source_branch = NULL, workspace_id = NULL WHERE name = 'writer'",
    )

    expect(await recoverSpawnAttempts(deps.db, deps.client, undefined, "t1"))
      .toEqual({ recovered: 0, blocked: 1 })
    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id = 'task-1'").get())
      .toEqual({ status: "in_progress", assignee: "writer" })
  })

  test("recovers a legacy attempt after OpenCode normalized its worktree name", async () => {
    const deps = setupDeps()
    insertTeam(deps.db, "t1", "team", "lead")
    insertClaimedAttempt(deps, "worktree_creating")
    deps.db.run(
      `UPDATE team_spawn_attempt
       SET worktree_name = 'ensemble-test-project-team#t1-writer',
           worktree_dir = NULL,
           worktree_branch = NULL,
           worktree_source_branch = NULL,
           workspace_id = NULL
       WHERE name = 'writer'`,
    )
    deps.client.worktree.list = async () => ({
      data: [{
        name: "ensemble-test-project-team-t1-writer",
        branch: "opencode/ensemble-test-project-team-t1-writer",
        directory: "/tmp/legacy-normalized-writer",
      }],
    })

    expect(await recoverSpawnAttempts(deps.db, deps.client, undefined, "t1"))
      .toEqual({ recovered: 1, blocked: 0 })
    expect(deps.client.calls.find(call => call.method === "worktree.remove")?.args[0])
      .toEqual({
        directory: "/tmp/test-project",
        worktreeRemoveInput: { directory: "/tmp/legacy-normalized-writer" },
      })
    expect(deps.db.query("SELECT name FROM team_spawn_attempt").all()).toHaveLength(0)
    expect(deps.db.query("SELECT status, assignee FROM team_task WHERE id = 'task-1'").get())
      .toEqual({ status: "pending", assignee: null })
  })
})
