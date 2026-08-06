import { describe, test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { applyMigrations, MIGRATIONS } from "../src/schema"
import { createDb, DatabaseInitializationError, getDb, getDbPath } from "../src/db"
import path from "path"

describe("schema migrations", () => {
  let db: Database

  beforeEach(() => {
    db = new Database(":memory:")
    db.exec("PRAGMA journal_mode=WAL")
  })

  test("applies all migrations to a fresh database", () => {
    applyMigrations(db)
    const version = db.query("PRAGMA user_version").get() as { user_version: number }
    expect(version.user_version).toBe(MIGRATIONS.length)
  })

  test("creates team table", () => {
    applyMigrations(db)
    const row = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='team'").get()
    expect(row).toBeTruthy()
  })

  test("creates project table", () => {
    applyMigrations(db)
    const row = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='project'").get()
    expect(row).toBeTruthy()
  })

  test("creates team_member table", () => {
    applyMigrations(db)
    const row = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='team_member'").get()
    expect(row).toBeTruthy()
  })

  test("adds durable one-shot abort recovery state to team members", () => {
    applyMigrations(db)
    const columns = db.query("PRAGMA table_info(team_member)").all() as Array<{ name: string; dflt_value: string | null }>

    expect(columns.find(column => column.name === "abort_recovery_state")?.dflt_value).toBe("'none'")
    expect(columns.some(column => column.name === "abort_recovery_message_id")).toBe(true)
    expect(columns.some(column => column.name === "abort_recovery_event_id")).toBe(true)
    expect(columns.some(column => column.name === "abort_recovery_started_at")).toBe(true)
    expect(columns.some(column => column.name === "abort_recovery_claim_token")).toBe(true)
    expect(columns.some(column => column.name === "abort_recovery_claim_expires_at")).toBe(true)
  })

  test("adds durable workflow and retry state in migration 12", () => {
    applyMigrations(db)
    const memberColumns = db.query("PRAGMA table_info(team_member)").all() as Array<{ name: string }>
    const teamColumns = db.query("PRAGMA table_info(team)").all() as Array<{ name: string }>
    const taskColumns = db.query("PRAGMA table_info(team_task)").all() as Array<{ name: string }>
    const projectColumns = db.query("PRAGMA table_info(project)").all() as Array<{ name: string }>

    expect(memberColumns.map(column => column.name)).toEqual(expect.arrayContaining([
      "retry_attempts", "retry_count", "retry_tripped", "merge_state", "merged_source_branch",
      "startup_recovery_token", "startup_recovery_state",
    ]))
    expect(teamColumns.map(column => column.name)).toEqual(expect.arrayContaining([
      "current_phase", "lead_brief", "lead_brief_updated_at",
    ]))
    expect(taskColumns.map(column => column.name)).toContain("phase")
    expect(taskColumns.map(column => column.name)).toContain("required_capabilities")
    expect(projectColumns.map(column => column.name)).toContain("slug")
  })

  test("migration 12 backfills a resource-safe fallback for non-ASCII project names", () => {
    for (let i = 0; i < 11; i++) {
      db.exec(MIGRATIONS[i]!)
      db.exec(`PRAGMA user_version = ${i + 1}`)
    }
    db.run(
      "INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES (?, ?, ?, 'active', 1, 1)",
      ["/tmp/chinese-project", "银色河流项目", "/tmp/chinese-project"],
    )

    applyMigrations(db)

    expect(db.query("SELECT slug FROM project WHERE id = ?").get("/tmp/chinese-project"))
      .toEqual({ slug: "project" })
  })

  test("migration 15 backfills profiles from existing runtime agents", () => {
    for (let i = 0; i < 14; i++) {
      db.exec(MIGRATIONS[i]!)
      db.exec(`PRAGMA user_version = ${i + 1}`)
    }
    db.run(
      "INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('project-1', 'project-1', '/tmp/project-1', 'active', 1, 1)",
    )
    db.run(
      "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('team-1', 'team-1', 'project-1', 'lead', 'active', 0, 1, 1)",
    )
    const legacyMembers: Array<[string, string]> = [
      ["legacy-scout", "explore"],
      ["legacy-planner", "plan"],
      ["legacy-builder", "build"],
    ]
    for (const [name, agent] of legacyMembers) {
      db.run(
        "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES ('team-1', ?, ?, ?, 'ready', 'idle', 1, 1)",
        [name, `${name}-session`, agent],
      )
    }

    applyMigrations(db)

    expect(db.query("SELECT name, profile FROM team_member ORDER BY name").all()).toEqual([
      { name: "legacy-builder", profile: "general" },
      { name: "legacy-planner", profile: "planner" },
      { name: "legacy-scout", profile: "scout" },
    ])
  })

  test("migration 16 preserves legacy event coverage as unknown and creates aggregate telemetry", () => {
    for (let i = 0; i < 15; i++) {
      db.exec(MIGRATIONS[i]!)
      db.exec(`PRAGMA user_version = ${i + 1}`)
    }
    db.run(
      "INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('project-1', 'project-1', '/tmp/project-1', 'active', 1, 1)",
    )
    db.run(
      "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('team-1', 'team-1', 'project-1', 'lead', 'active', 0, 1, 1)",
    )
    db.run(
      "INSERT INTO team_event (id, team_id, kind, payload, cause_event_id, time_created) VALUES ('event-legacy', 'team-1', 'team.created', '{}', NULL, 1)",
    )

    applyMigrations(db)

    expect(db.query("SELECT instrumentation_version FROM team_event WHERE id = 'event-legacy'").get())
      .toEqual({ instrumentation_version: null })
    expect(db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'team_usage_aggregate'").get())
      .toEqual({ name: "team_usage_aggregate" })
    const indexes = db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'team_event'").all() as Array<{ name: string }>
    expect(indexes.map(index => index.name)).toEqual(expect.arrayContaining([
      "team_event_kind_time_idx", "team_event_version_time_idx",
    ]))
  })

  test("creates team_task table", () => {
    applyMigrations(db)
    const row = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='team_task'").get()
    expect(row).toBeTruthy()
  })

  test("creates team_message table", () => {
    applyMigrations(db)
    const row = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='team_message'").get()
    expect(row).toBeTruthy()
  })

  test("migration 18 creates immutable artifacts and exact task contract columns", () => {
    applyMigrations(db)
    const artifact = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='team_artifact'").get()
    const purgeGuard = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='team_purge_guard'").get()
    const taskColumns = db.query("PRAGMA table_info(team_task)").all() as Array<{ name: string }>
    const indexes = db.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='team_artifact'").all() as Array<{ name: string }>
    const triggers = db.query("SELECT name FROM sqlite_master WHERE type='trigger'").all() as Array<{ name: string }>

    expect(artifact).toBeTruthy()
    expect(purgeGuard).toBeTruthy()
    expect(taskColumns.map(column => column.name)).toEqual(expect.arrayContaining([
      "contract_artifact_id", "contract_artifact_sha256",
    ]))
    expect(indexes.map(index => index.name)).toEqual(expect.arrayContaining([
      "team_artifact_team_time_idx", "team_artifact_team_kind_time_idx", "team_artifact_team_task_time_idx",
    ]))
    expect(triggers.map(trigger => trigger.name)).toEqual(expect.arrayContaining([
      "team_artifact_no_update", "team_artifact_no_delete", "team_task_contract_binding_pair_insert",
      "team_artifact_authorized_insert", "team_task_contract_binding_validate_insert",
      "team_task_contract_binding_no_update", "team_event_no_delete",
    ]))
    const eventDeleteTrigger = db.query(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='team_event_no_delete'",
    ).get() as { sql: string }
    expect(eventDeleteTrigger.sql).toContain("team_purge_guard")
  })

  test("migration 19 separates controller ownership and adds writer baselines", () => {
    for (let i = 0; i < 18; i++) {
      db.exec(MIGRATIONS[i]!)
      db.exec(`PRAGMA user_version = ${i + 1}`)
    }
    db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('p1', 'p1', '/repo', 'active', 1, 1)")
    db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t1', 't1', 'p1', 'lead', 'active', 0, 1, 1)")
    db.run("INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, worktree_branch, time_created, time_updated) VALUES ('t1', 'writer', 's1', 'build', 'ready', 'idle', 'ensemble-writer', 1, 1)")
    db.run("INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, worktree_branch, time_created, time_updated) VALUES ('t1', 'preserved', 's2', 'build', 'shutdown', 'completed', 'ensemble/preserved/p/t/m', 1, 1)")

    applyMigrations(db)

    expect(db.query("SELECT controller_directory FROM team WHERE id = 't1'").get()).toEqual({ controller_directory: "/repo" })
    expect(db.query("SELECT git_identity FROM project WHERE id = 'p1'").get()).toEqual({ git_identity: null })
    expect(db.query("SELECT name, worktree_source_branch, worktree_baseline_oid FROM team_member ORDER BY name").all()).toEqual([
      { name: "preserved", worktree_source_branch: null, worktree_baseline_oid: null },
      { name: "writer", worktree_source_branch: "ensemble-writer", worktree_baseline_oid: null },
    ])
  })

  test("migration 20 adds per-writer repository binding and durable spawn attempts", () => {
    for (let i = 0; i < 19; i++) {
      db.exec(MIGRATIONS[i]!)
      db.exec(`PRAGMA user_version = ${i + 1}`)
    }
    db.run("INSERT INTO project (id, name, path, git_identity, status, time_created, time_updated) VALUES ('p1', 'p1', '/repo', '/repo/.git', 'active', 1, 1)")
    db.run("INSERT INTO team (id, name, project_id, controller_directory, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t1', 't1', 'p1', '/controller', 'lead', 'active', 0, 1, 1)")
    db.run("INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES ('t1', 'legacy', 's1', 'build', 'ready', 'idle', 1, 1)")

    applyMigrations(db)

    expect(db.query("SELECT repository_root, repository_git_identity FROM team_member WHERE name = 'legacy'").get())
      .toEqual({ repository_root: null, repository_git_identity: null })
    db.run(
      `INSERT INTO team_spawn_attempt
         (team_id, name, repository_root, repository_git_identity, worktree_name,
          claim_task_id, claim_event_id, time_created, time_updated)
       VALUES ('t1', 'writer', '/controller/child', '/controller/child/.git', 'writer-wt', 'task-1', 'event-1', 1, 1)`,
    )
    expect(db.query("SELECT repository_root, repository_git_identity, worktree_name FROM team_spawn_attempt").get())
      .toEqual({ repository_root: "/controller/child", repository_git_identity: "/controller/child/.git", worktree_name: "writer-wt" })
  })

  test("migration 21 adds immutable merged source cleanup evidence", () => {
    for (let i = 0; i < 20; i++) {
      db.exec(MIGRATIONS[i]!)
      db.exec(`PRAGMA user_version = ${i + 1}`)
    }
    expect(db.query("PRAGMA table_info(team_member)").all())
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "merged_source_oid" })]))

    applyMigrations(db)

    expect(db.query("PRAGMA table_info(team_member)").all())
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: "merged_source_oid" })]))
  })

  test("migration 22 adds durable spawn recovery stage without rewriting migration 20", () => {
    for (let i = 0; i < 21; i++) {
      db.exec(MIGRATIONS[i]!)
      db.exec(`PRAGMA user_version = ${i + 1}`)
    }
    expect(db.query("PRAGMA table_info(team_spawn_attempt)").all())
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "stage" })]))

    applyMigrations(db)

    expect(db.query("PRAGMA table_info(team_spawn_attempt)").all())
      .toEqual(expect.arrayContaining([expect.objectContaining({ name: "stage" })]))
  })

  test("artifact rows and task contract bindings are immutable", () => {
    applyMigrations(db)
    db.exec("PRAGMA foreign_keys=ON")
    db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('p1', 'p1', '/p1', 'active', 1, 1)")
    db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t1', 't1', 'p1', 'lead', 'active', 0, 1, 1)")
    db.run("INSERT INTO team_artifact (id, team_id, kind, task_id, created_by, sha256, media_type, byte_count, content, time_created) VALUES ('a1', 't1', 'contract', NULL, 'lead', ?, 'text/plain', 1, 'x', 1)", ["0".repeat(64)])
    db.run("INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated, contract_artifact_id, contract_artifact_sha256) VALUES ('task-1', 't1', 'task', 'pending', 'medium', 1, 1, 'a1', ?)", ["0".repeat(64)])

    expect(() => db.run("UPDATE team_artifact SET content = 'y' WHERE id = 'a1'")).toThrow("immutable")
    expect(() => db.run("DELETE FROM team_artifact WHERE id = 'a1'")).toThrow("immutable")
    expect(() => db.run("UPDATE team_task SET contract_artifact_id = NULL, contract_artifact_sha256 = NULL WHERE id = 'task-1'"))
      .toThrow("contract binding is immutable")
    expect(() => db.run("INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated, contract_artifact_id) VALUES ('task-2', 't1', 'task', 'pending', 'medium', 1, 1, 'a1')"))
      .toThrow("requires both")
    expect(() => db.run("INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated, contract_artifact_id, contract_artifact_sha256) VALUES ('task-3', 't1', 'task', 'pending', 'medium', 1, 1, 'a1', ?)", ["1".repeat(64)]))
      .toThrow("does not match")
    expect(() => db.run("INSERT INTO team_artifact (id, team_id, kind, task_id, created_by, sha256, media_type, byte_count, content, time_created) VALUES ('a2', 't1', 'contract', NULL, 'alice', ?, 'text/plain', 1, 'x', 1)", ["0".repeat(64)]))
      .toThrow("not authorized")
  })

  test("is idempotent — running twice does not error", () => {
    applyMigrations(db)
    applyMigrations(db)
    const version = db.query("PRAGMA user_version").get() as { user_version: number }
    expect(version.user_version).toBe(MIGRATIONS.length)
  })

  test("rejects databases from newer plugin versions", () => {
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`)
    expect(() => applyMigrations(db)).toThrow("newer than this plugin supports")
  })

  test("rolls back a failed migration without leaving half-migrated tables", () => {
    db.exec("PRAGMA foreign_keys=ON")
    db.exec(`
      CREATE TABLE team (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        lead_session_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        delegate INTEGER NOT NULL DEFAULT 0,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        lead_agent TEXT
      );
      INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated, lead_agent)
        VALUES ('t1', 'old-team', 'sess-1', 'active', 0, 1, 1, NULL);
      PRAGMA user_version = 7;
    `)

    expect(() => applyMigrations(db)).toThrow()

    const version = db.query("PRAGMA user_version").get() as { user_version: number }
    expect(version.user_version).toBe(7)
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='team'").get()).toBeTruthy()
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='team_old_m8'").get()).toBeNull()
    expect(db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='project'").get()).toBeNull()
    const row = db.query("SELECT name FROM team WHERE id = 't1'").get() as { name: string }
    expect(row.name).toBe("old-team")
    const foreignKeys = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }
    expect(foreignKeys.foreign_keys).toBe(1)
  })

  test("preserves disabled foreign key mode after migrations", () => {
    db.exec("PRAGMA foreign_keys=OFF")

    applyMigrations(db)

    const foreignKeys = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }
    expect(foreignKeys.foreign_keys).toBe(0)
  })

  test("upgrades a version 7 database to the current project schema", () => {
    for (let i = 0; i < 7; i++) {
      db.exec(MIGRATIONS[i]!)
      db.exec(`PRAGMA user_version = ${i + 1}`)
    }
    db.run(
      "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated, lead_agent) VALUES (?, ?, ?, 'active', 0, ?, ?, ?)",
      ["t1", "legacy-team", "sess-1", 1, 2, "build"]
    )
    db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, prompt, time_created, time_updated, worktree_dir, worktree_branch, plan_approval, workspace_id, reported_to_lead) VALUES (?, ?, ?, ?, 'ready', 'idle', ?, ?, ?, ?, ?, 'none', ?, 0)",
      ["t1", "alice", "sess-a", "build", "legacy prompt", 3, 4, "/tmp/wt", "ensemble-legacy-team-alice", "ws-1"]
    )
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES (?, ?, ?, 'pending', 'medium', ?, ?)",
      ["task-1", "t1", "legacy task", 5, 6]
    )
    db.run(
      "INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created, read) VALUES (?, ?, ?, ?, ?, 1, ?, 0)",
      ["msg-1", "t1", "alice", "lead", "legacy message", 7]
    )

    applyMigrations(db)

    const version = db.query("PRAGMA user_version").get() as { user_version: number }
    expect(version.user_version).toBe(MIGRATIONS.length)
    const project = db.query("SELECT id, name, slug FROM project WHERE id = 'default'").get() as { id: string; name: string; slug: string }
    expect(project.name).toBe("Default Project")
    expect(project.slug).toBe("project")
    const team = db.query("SELECT name, project_id, lead_agent FROM team WHERE id = 't1'").get() as { name: string; project_id: string; lead_agent: string }
    expect(team).toEqual({ name: "legacy-team", project_id: "default", lead_agent: "build" })
    const member = db.query("SELECT prompt, workspace_id, reported_to_lead FROM team_member WHERE team_id = 't1' AND name = 'alice'").get() as { prompt: string; workspace_id: string; reported_to_lead: number }
    expect(member).toEqual({ prompt: "legacy prompt", workspace_id: "ws-1", reported_to_lead: 0 })
    const task = db.query("SELECT content FROM team_task WHERE id = 'task-1'").get() as { content: string }
    expect(task.content).toBe("legacy task")
    const message = db.query("SELECT content, read FROM team_message WHERE id = 'msg-1'").get() as { content: string; read: number }
    expect(message).toEqual({ content: "legacy message", read: 0 })
  })

  test("enforces project foreign keys after migration 8", () => {
    applyMigrations(db)
    db.exec("PRAGMA foreign_keys=ON")

    expect(() =>
      db.run(
        "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t1', 'orphan', 'missing-project', 'sess1', 'active', 0, 1, 1)"
      )
    ).toThrow()
  })

  test("enforces active team name uniqueness within each project only", () => {
    applyMigrations(db)
    db.exec("PRAGMA foreign_keys=ON")
    db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('/tmp/project-a', 'project-a', '/tmp/project-a', 'active', 1, 1)")
    db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('/tmp/project-b', 'project-b', '/tmp/project-b', 'active', 1, 1)")
    db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t1', 'same-name', '/tmp/project-a', 'sess1', 'active', 0, 1, 1)")
    db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t2', 'same-name', '/tmp/project-b', 'sess2', 'active', 0, 1, 1)")
    db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t3', 'same-name', '/tmp/project-a', 'sess3', 'archived', 0, 1, 1)")

    expect(() =>
      db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t4', 'same-name', '/tmp/project-a', 'sess4', 'active', 0, 1, 1)")
    ).toThrow()
  })

  test("can insert and query a team", () => {
    applyMigrations(db)
    db.run(
      "INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES (?, ?, ?, 'active', ?, ?)",
      ["/tmp/test-project", "test-project", "/tmp/test-project", Date.now(), Date.now()]
    )
    db.run(
      "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["t1", "my-team", "/tmp/test-project", "sess1", "active", 0, Date.now(), Date.now()]
    )
    const row = db.query("SELECT * FROM team WHERE id = ?").get("t1") as Record<string, unknown>
    expect(row.name).toBe("my-team")
    expect(row.status).toBe("active")
  })

  test("can insert and query a team_member", () => {
    applyMigrations(db)
    db.run(
      "INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES (?, ?, ?, 'active', ?, ?)",
      ["/tmp/test-project", "test-project", "/tmp/test-project", Date.now(), Date.now()]
    )
    db.run(
      "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["t1", "my-team", "/tmp/test-project", "sess1", "active", 0, Date.now(), Date.now()]
    )
    db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["t1", "alice", "sess2", "build", "ready", "idle", Date.now(), Date.now()]
    )
    const row = db.query("SELECT * FROM team_member WHERE name = ?").get("alice") as Record<string, unknown>
    expect(row.agent).toBe("build")
    expect(row.status).toBe("ready")
  })

  test("migration 6 adds workspace_id column to team_member", () => {
    const freshDb = new Database(":memory:")
    freshDb.exec("PRAGMA journal_mode=WAL")
    freshDb.exec("PRAGMA foreign_keys=ON")
    applyMigrations(freshDb)

    freshDb.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('/tmp/test-project', 'test-project', '/tmp/test-project', 'active', 1, 1)")
    freshDb.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t1', 'test', '/tmp/test-project', 'sess-1', 'active', 0, 1, 1)")
    freshDb.run("INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES ('t1', 'alice', 'sess-a', 'build', 'ready', 'idle', 1, 1)")

    const row = freshDb.query("SELECT workspace_id FROM team_member WHERE name = 'alice'").get() as { workspace_id: string | null }
    expect(row.workspace_id).toBeNull()
    freshDb.close()
  })

  test("team_member cascade deletes when team is deleted", () => {
    applyMigrations(db)
    db.run("PRAGMA foreign_keys = ON")
    db.run(
      "INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES (?, ?, ?, 'active', ?, ?)",
      ["/tmp/test-project", "test-project", "/tmp/test-project", Date.now(), Date.now()]
    )
    db.run(
      "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["t1", "my-team", "/tmp/test-project", "sess1", "active", 0, Date.now(), Date.now()]
    )
    db.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["t1", "alice", "sess2", "build", "ready", "idle", Date.now(), Date.now()]
    )
    db.run("DELETE FROM team WHERE id = ?", ["t1"])
    const row = db.query("SELECT * FROM team_member WHERE team_id = ?").get("t1")
    expect(row).toBeNull()
  })
})

describe("createDb", () => {
  test("returns a database with migrations applied", () => {
    const db = createDb(":memory:")
    const version = db.query("PRAGMA user_version").get() as { user_version: number }
    expect(version.user_version).toBe(MIGRATIONS.length)
  })

  test("WAL mode is enabled", () => {
    const tmpPath = `/tmp/ensemble-test-${Date.now()}.db`
    const db = createDb(tmpPath)
    const mode = db.query("PRAGMA journal_mode").get() as { journal_mode: string }
    expect(mode.journal_mode).toBe("wal")
    db.close()
    // cleanup
    try { require("fs").unlinkSync(tmpPath) } catch {}
    try { require("fs").unlinkSync(tmpPath + "-wal") } catch {}
    try { require("fs").unlinkSync(tmpPath + "-shm") } catch {}
  })

  test("reports malformed databases without replacing or deleting the file", async () => {
    const tmpPath = `/tmp/ensemble-corrupt-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    const contents = "not a sqlite database"
    await Bun.write(tmpPath, contents)

    try {
      expect(() => createDb(tmpPath)).toThrow(DatabaseInitializationError)
      expect(() => createDb(tmpPath)).toThrow("Ensemble 数据库初始化失败")
      expect(await Bun.file(tmpPath).text()).toBe(contents)
      expect(() => getDb()).toThrow("Database not initialized")
    } finally {
      await Bun.file(tmpPath).unlink()
    }
  })

  test("keeps the original initialization error as an internal cause", async () => {
    const tmpPath = `/tmp/ensemble-corrupt-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    await Bun.write(tmpPath, "not a sqlite database")

    try {
      let failure: unknown
      try {
        createDb(tmpPath)
      } catch (error) {
        failure = error
      }

      expect(failure).toBeInstanceOf(DatabaseInitializationError)
      const diagnostic = failure as DatabaseInitializationError
      expect(diagnostic.phase).toBe("configure")
      expect(diagnostic.cause).toBeInstanceOf(Error)
      expect(diagnostic.message).not.toContain(tmpPath)
    } finally {
      await Bun.file(tmpPath).unlink()
    }
  })
})

describe("getDbPath", () => {
  test("resolves to ~/.config/opencode/ensemble.db using HOME", () => {
    const result = getDbPath({ HOME: "/home/testuser", USERPROFILE: undefined })
    expect(result).toBe(path.join("/home/testuser", ".config", "opencode", "ensemble.db"))
  })

  test("falls back to USERPROFILE when HOME is not set", () => {
    const result = getDbPath({ HOME: undefined, USERPROFILE: "C:\\Users\\testuser" })
    expect(result).toBe(path.join("C:\\Users\\testuser", ".config", "opencode", "ensemble.db"))
  })

  test("falls back to ~ when neither HOME nor USERPROFILE is set", () => {
    const result = getDbPath({ HOME: undefined, USERPROFILE: undefined })
    expect(result).toBe(path.join("~", ".config", "opencode", "ensemble.db"))
  })

  test("never includes the project directory in the path", () => {
    const result = getDbPath({ HOME: "/home/testuser", USERPROFILE: undefined })
    expect(result).not.toContain(".opencode/ensemble.db")
    expect(result).toContain(path.join(".config", "opencode", "ensemble.db"))
  })
})
