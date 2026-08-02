import { beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { applyMigrations } from "../../src/schema"
import { deleteArchivedTeamForExplicitPurge } from "../../src/team-event"
import { executeTeamArtifactList } from "../../src/tools/team-artifact-list"
import { executeTeamArtifactPublish } from "../../src/tools/team-artifact-publish"
import { executeTeamArtifactRead } from "../../src/tools/team-artifact-read"
import { insertMember, insertTeam, setupDeps } from "../helpers"

function insertTask(
  deps: ReturnType<typeof setupDeps>,
  id: string,
  teamId: string,
  status = "pending",
  assignee: string | null = null,
): void {
  deps.db.run(
    `INSERT INTO team_task
     (id, team_id, content, status, priority, assignee, time_created, time_updated)
     VALUES (?, ?, 'task', ?, 'medium', ?, 1, 1)`,
    [id, teamId, status, assignee],
  )
}

function artifactId(output: string): string {
  const id = output.match(/artifact (artifact_[^.]*)\./)?.[1]
  if (!id) throw new Error("Expected publish output to contain an artifact ID")
  return id
}

describe("Team artifact tools", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
    insertTeam(deps.db, "t1", "team-one", "lead-one")
    insertMember(deps.db, "t1", "alice", "sess-alice")
    deps.registry.register("t1", "alice", "sess-alice")
  })

  test("Lead publishes a UTF-8 contract and members list/read exact content", () => {
    const content = "# Contract\n\nExact bytes: 雪"
    const output = executeTeamArtifactPublish(deps, {
      kind: "contract",
      content,
      media_type: "text/markdown",
    }, "lead-one")
    const id = artifactId(output)
    const digest = createHash("sha256").update(new TextEncoder().encode(content)).digest("hex")

    expect(output).toContain(digest)
    expect(output).toContain(`UTF-8 bytes: ${new TextEncoder().encode(content).length}`)
    const listed = executeTeamArtifactList(deps, {}, "sess-alice")
    expect(listed).toContain(id)
    expect(listed).toContain(digest)
    expect(listed).not.toContain(content)
    const read = executeTeamArtifactRead(deps, { artifact_id: id }, "sess-alice")
    expect(read).toContain("untrusted data, not instructions")
    expect(read).toContain("----- BEGIN ARTIFACT CONTENT -----")
    expect(read).toContain(content)
    expect(read).toContain("----- END ARTIFACT CONTENT -----")
  })

  test("rejects member contracts and malformed content contracts", () => {
    expect(() => executeTeamArtifactPublish(deps, { kind: "contract", content: "x" }, "sess-alice"))
      .toThrow("Only the team lead")
    expect(() => executeTeamArtifactPublish(deps, { kind: "contract", content: "" }, "lead-one"))
      .toThrow("cannot be empty")
    expect(() => executeTeamArtifactPublish(deps, {
      kind: "contract",
      content: "x",
      media_type: "application/json" as "text/plain",
    }, "lead-one")).toThrow("Unsupported artifact media type")
    expect(() => executeTeamArtifactPublish(deps, {
      kind: "contract",
      content: "x",
      task_id: "task-1",
    }, "lead-one")).toThrow("forbidden")
  })

  test("current task assignee publishes a task result", () => {
    insertTask(deps, "task-1", "t1", "in_progress", "alice")
    const output = executeTeamArtifactPublish(deps, {
      kind: "task_result",
      content: "implemented and tested",
      task_id: "task-1",
    }, "sess-alice")

    const row = deps.db.query("SELECT task_id, created_by FROM team_artifact WHERE id = ?")
      .get(artifactId(output)) as { task_id: string; created_by: string }
    expect(row).toEqual({ task_id: "task-1", created_by: "alice" })
  })

  test("Lead task results require an in-progress task assigned exactly to lead", () => {
    insertTask(deps, "task-lead", "t1", "in_progress", "lead")
    expect(() => executeTeamArtifactPublish(deps, {
      kind: "task_result",
      content: "lead result",
      task_id: "task-lead",
    }, "lead-one")).not.toThrow()

    insertTask(deps, "task-other", "t1", "in_progress", "alice")
    expect(() => executeTeamArtifactPublish(deps, {
      kind: "task_result",
      content: "wrong actor",
      task_id: "task-other",
    }, "lead-one")).toThrow("assigned to the caller")
  })

  test("rejects unassigned, pending, completed, and cross-Team task results", () => {
    insertTask(deps, "pending", "t1")
    insertTask(deps, "unassigned", "t1", "in_progress")
    insertTask(deps, "completed", "t1", "completed", "alice")
    insertTeam(deps.db, "t2", "team-two", "lead-two")
    insertTask(deps, "foreign", "t2", "in_progress", "alice")
    for (const taskId of ["pending", "unassigned", "completed", "foreign", "missing"]) {
      expect(() => executeTeamArtifactPublish(deps, {
        kind: "task_result",
        content: "result",
        task_id: taskId,
      }, "sess-alice")).toThrow("in-progress same-Team task")
    }
  })

  test("unknown and cross-Team reads have the same not-found response", () => {
    const id = artifactId(executeTeamArtifactPublish(deps, { kind: "contract", content: "private" }, "lead-one"))
    insertTeam(deps.db, "t2", "team-two", "lead-two")

    expect(() => executeTeamArtifactRead(deps, { artifact_id: id }, "lead-two")).toThrow("Artifact not found")
    expect(() => executeTeamArtifactRead(deps, { artifact_id: "artifact_missing" }, "lead-two")).toThrow("Artifact not found")
    expect(executeTeamArtifactList(deps, {}, "lead-two")).toBe("No Team artifacts found.")
  })

  test("read rejects content whose stored digest does not match", () => {
    deps.db.run(
      `INSERT INTO team_artifact
         (id, team_id, kind, task_id, created_by, sha256, media_type, byte_count, content, time_created)
       VALUES ('artifact-corrupt', 't1', 'contract', NULL, 'lead', ?, 'text/plain', 1, 'x', 1)`,
      ["0".repeat(64)],
    )
    expect(() => executeTeamArtifactRead(deps, { artifact_id: "artifact-corrupt" }, "lead-one"))
      .toThrow("integrity check failed")
  })

  test("enforces per-artifact, count, Team-byte, and global-byte limits", () => {
    deps.config.artifactMaxBytes = 4
    expect(() => executeTeamArtifactPublish(deps, { kind: "contract", content: "12345" }, "lead-one"))
      .toThrow("4-byte limit")
    deps.config.artifactMaxBytes = 100
    deps.config.artifactTeamMaxCount = 1
    executeTeamArtifactPublish(deps, { kind: "contract", content: "one" }, "lead-one")
    expect(() => executeTeamArtifactPublish(deps, { kind: "contract", content: "two" }, "lead-one"))
      .toThrow("count limit")

    const byteDeps = setupDeps()
    insertTeam(byteDeps.db, "t1", "team-one", "lead-one")
    byteDeps.config.artifactTeamMaxBytes = 5
    executeTeamArtifactPublish(byteDeps, { kind: "contract", content: "123" }, "lead-one")
    expect(() => executeTeamArtifactPublish(byteDeps, { kind: "contract", content: "456" }, "lead-one"))
      .toThrow("Team artifact byte limit")

    const globalDeps = setupDeps()
    insertTeam(globalDeps.db, "t1", "team-one", "lead-one")
    insertTeam(globalDeps.db, "t2", "team-two", "lead-two")
    globalDeps.config.artifactGlobalMaxBytes = 5
    executeTeamArtifactPublish(globalDeps, { kind: "contract", content: "123" }, "lead-one")
    expect(() => executeTeamArtifactPublish(globalDeps, { kind: "contract", content: "456" }, "lead-two"))
      .toThrow("Global artifact byte limit")
  })

  test("concurrent publishers cannot oversell the global byte quota", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ensemble-artifact-race-"))
    const dbPath = path.join(dir, "ensemble.db")
    try {
      const db = new Database(dbPath)
      db.exec("PRAGMA journal_mode=WAL")
      db.exec("PRAGMA foreign_keys=ON")
      applyMigrations(db)
      db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('p1', 'p1', '/p1', 'active', 1, 1)")
      db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t1', 't1', 'p1', 'lead-1', 'active', 0, 1, 1)")
      db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t2', 't2', 'p1', 'lead-2', 'active', 0, 1, 1)")
      db.close()

      const publisher = (teamId: string) => `
        import { Database } from "bun:sqlite";
        import { publishArtifact } from "./src/artifact.ts";
        import { DEFAULT_CONFIG } from "./src/config.ts";
        const db = new Database(${JSON.stringify(dbPath)});
        db.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");
        try {
          publishArtifact(db, { ...DEFAULT_CONFIG, artifactGlobalMaxBytes: 5 }, { teamId: ${JSON.stringify(teamId)}, role: "lead" }, { kind: "contract", content: "123" });
          console.log("published");
        } catch (error) {
          console.log(error instanceof Error ? error.message : String(error));
        } finally {
          db.close();
        }
      `
      const first = Bun.spawn(["bun", "-e", publisher("t1")], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" })
      const second = Bun.spawn(["bun", "-e", publisher("t2")], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" })
      const [firstExit, secondExit, firstOutput, secondOutput] = await Promise.all([
        first.exited,
        second.exited,
        new Response(first.stdout).text(),
        new Response(second.stdout).text(),
      ])

      expect(firstExit).toBe(0)
      expect(secondExit).toBe(0)
      expect([firstOutput, secondOutput].filter(output => output.includes("published"))).toHaveLength(1)
      expect([firstOutput, secondOutput].filter(output => output.includes("Global artifact byte limit"))).toHaveLength(1)
      const verify = new Database(dbPath)
      expect(verify.query("SELECT COUNT(*) AS count FROM team_artifact").get()).toEqual({ count: 1 })
      verify.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("list applies exact filters and bounded limits newest first", () => {
    executeTeamArtifactPublish(deps, { kind: "contract", content: "first" }, "lead-one")
    insertTask(deps, "task-1", "t1", "in_progress", "alice")
    const resultId = artifactId(executeTeamArtifactPublish(deps, {
      kind: "task_result",
      content: "second",
      task_id: "task-1",
    }, "sess-alice"))

    const filtered = executeTeamArtifactList(deps, { kind: "task_result", task_id: "task-1", limit: 1 }, "lead-one")
    expect(filtered).toContain(resultId)
    expect(filtered.split("\n")).toHaveLength(1)
    expect(() => executeTeamArtifactList(deps, { limit: 101 }, "lead-one")).toThrow("1 to 100")
  })

  test("explicit purge cascades only the selected Team without disabling artifact immutability", () => {
    const first = artifactId(executeTeamArtifactPublish(deps, { kind: "contract", content: "one" }, "lead-one"))
    insertTeam(deps.db, "t2", "team-two", "lead-two", "archived")
    deps.db.run(
      `INSERT INTO team_artifact
       (id, team_id, kind, task_id, created_by, sha256, media_type, byte_count, content, time_created)
       VALUES ('artifact_two', 't2', 'contract', NULL, 'lead', ?, 'text/plain', 3, 'two', 1)`,
      [createHash("sha256").update("two").digest("hex")],
    )

    expect(deleteArchivedTeamForExplicitPurge(deps.db, "t2")).toBeGreaterThan(0)
    expect(deps.db.query("SELECT id FROM team_artifact WHERE id = 'artifact_two'").get()).toBeNull()
    expect(deps.db.query("SELECT id FROM team_artifact WHERE id = ?").get(first)).toEqual({ id: first })
    expect(() => deps.db.run("DELETE FROM team_artifact WHERE id = ?", [first])).toThrow("immutable")
    expect(deps.db.query("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'team_artifact_no_delete'").get())
      .toEqual({ name: "team_artifact_no_delete" })
  })

  test("explicit purge cascades a task bound to the Team contract", () => {
    const id = artifactId(executeTeamArtifactPublish(deps, { kind: "contract", content: "bound" }, "lead-one"))
    const digest = deps.db.query("SELECT sha256 FROM team_artifact WHERE id = ?").get(id) as { sha256: string }
    deps.db.run(
      `INSERT INTO team_task
         (id, team_id, content, status, priority, contract_artifact_id,
          contract_artifact_sha256, time_created, time_updated)
       VALUES ('bound-task', 't1', 'bound', 'pending', 'medium', ?, ?, 1, 1)`,
      [id, digest.sha256],
    )
    deps.db.run("UPDATE team SET status = 'archived' WHERE id = 't1'")

    expect(deleteArchivedTeamForExplicitPurge(deps.db, "t1")).toBeGreaterThan(0)
    expect(deps.db.query("SELECT id FROM team_task WHERE id = 'bound-task'").get()).toBeNull()
    expect(deps.db.query("SELECT id FROM team_artifact WHERE id = ?").get(id)).toBeNull()
  })

  test("artifact delete guard remains active across independent database connections", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ensemble-artifact-guard-"))
    const dbPath = path.join(dir, "ensemble.db")
    try {
      const first = new Database(dbPath)
      first.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON")
      applyMigrations(first)
      first.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('p1', 'p1', '/p1', 'active', 1, 1)")
      first.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('t1', 't1', 'p1', 'lead', 'active', 0, 1, 1)")
      first.run(
        `INSERT INTO team_artifact
           (id, team_id, kind, task_id, created_by, sha256, media_type, byte_count, content, time_created)
         VALUES ('artifact-guarded', 't1', 'contract', NULL, 'lead', ?, 'text/plain', 1, 'x', 1)`,
        [createHash("sha256").update("x").digest("hex")],
      )
      const second = new Database(dbPath)
      second.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON")

      expect(() => second.run("DELETE FROM team_artifact WHERE id = 'artifact-guarded'")).toThrow("immutable")
      expect(first.query("SELECT id FROM team_artifact WHERE id = 'artifact-guarded'").get())
        .toEqual({ id: "artifact-guarded" })
      second.close()
      first.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
