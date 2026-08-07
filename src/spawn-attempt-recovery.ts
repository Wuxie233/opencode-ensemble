import type { Database } from "./db"
import { immediateTransaction } from "./db"
import { sendLeadAlert } from "./messaging"
import { recomputeCurrentPhase } from "./task-phase"
import { appendTeamEvent } from "./team-event"
import type { PluginClient } from "./types"
import { normalizeWorktreeName, preserveBranch, preservedBranchName } from "./tools/merge-helper"

interface SpawnAttempt {
  team_id: string
  team_name: string
  project_name: string
  name: string
  repository_root: string
  worktree_name: string
  stage: "worktree_creating" | "workspace_creating" | "session_creating" | "registered"
  worktree_dir: string | null
  worktree_branch: string | null
  worktree_source_branch: string | null
  workspace_id: string | null
  session_id: string | null
  safe_branch: string | null
  claim_task_id: string | null
  claim_event_id: string | null
  preflight_error: string | null
}

/** Recover task-owned resources left by a spawn that did not reach member registration. */
export async function recoverSpawnAttempts(
  db: Database,
  client: PluginClient,
  controllerDirectory?: string,
  teamId?: string,
): Promise<{ recovered: number; blocked: number }> {
  const attempts = db.query(
    `SELECT a.*, t.name AS team_name, COALESCE(p.slug, p.name) AS project_name
     FROM team_spawn_attempt a
     JOIN team t ON t.id = a.team_id
     JOIN project p ON p.id = t.project_id
     WHERE t.status = 'active'
       AND (? IS NULL OR t.controller_directory = ?)
       AND (? IS NULL OR a.team_id = ?)
     ORDER BY a.time_created, a.name`,
  ).all(
    controllerDirectory ?? null,
    controllerDirectory ?? null,
    teamId ?? null,
    teamId ?? null,
  ) as SpawnAttempt[]

  let recovered = 0
  let blocked = 0
  for (const attempt of attempts) {
    if (attempt.preflight_error) {
      blocked++
      continue
    }
    if (attempt.stage === "session_creating" && !attempt.session_id) {
      blocked++
      continue
    }
    try {
      const worktrees = await client.worktree.list({ directory: attempt.repository_root })
      const normalizedWorktreeName = normalizeWorktreeName(attempt.worktree_name)
      const matchingWorktrees = (worktrees.data ?? []).filter(worktree =>
        worktree.name === normalizedWorktreeName || worktree.directory === attempt.worktree_dir
      )
      if (matchingWorktrees.length > 1) throw new Error("multiple matching worktrees were discovered")
      const worktree = matchingWorktrees[0]
      const branch = attempt.worktree_source_branch ?? attempt.worktree_branch ?? worktree?.branch ?? null
      const worktreeDir = attempt.worktree_dir ?? worktree?.directory ?? null
      if (attempt.stage === "worktree_creating" && !worktreeDir) {
        blocked++
        continue
      }

      const workspaces = branch ? await client.workspace.list({ directory: attempt.repository_root }) : { data: [] }
      const matchingWorkspaces = (workspaces.data ?? []).filter(workspace =>
        workspace.id === attempt.workspace_id || workspace.branch === branch
      )
      if (matchingWorkspaces.length > 1) throw new Error("multiple matching workspaces were discovered")
      const workspaceId = attempt.workspace_id ?? matchingWorkspaces[0]?.id ?? null
      if (attempt.stage === "workspace_creating" && !workspaceId) {
        blocked++
        continue
      }

      if (attempt.session_id) {
        if (!branch) throw new Error("the owned session has no source branch to preserve")
        const safeBranch = attempt.safe_branch
          ?? preservedBranchName(attempt.project_name, attempt.team_name, attempt.team_id, attempt.name)
        if (!await preserveBranch(branch, safeBranch, attempt.repository_root)) {
          throw new Error(`branch ${branch} could not be preserved before abort`)
        }
        await client.session.abort({ sessionID: attempt.session_id })
      }
      if (workspaceId) await client.workspace.remove({ directory: attempt.repository_root, id: workspaceId })
      if (worktreeDir) {
        await client.worktree.remove({
          directory: attempt.repository_root,
          worktreeRemoveInput: { directory: worktreeDir },
        })
      }
      settleAttempt(db, attempt)
      recovered++
    } catch (error) {
      blocked++
      const detail = error instanceof Error ? error.message : String(error)
      sendLeadAlert(db, client, {
        teamId: attempt.team_id,
        content: `Spawn recovery for teammate "${attempt.name}" remains blocked (${detail}). Its durable attempt, resources, and claimed task remain owned; retry recovery before cleanup or replacement.`,
        wakeText: `[System: Spawn recovery for ${attempt.name} remains blocked; guidance is available in team messages]`,
      })
    }
  }
  return { recovered, blocked }
}

function settleAttempt(db: Database, attempt: SpawnAttempt): void {
  immediateTransaction(db, () => {
    if (attempt.claim_task_id) {
      const now = Date.now()
      const released = db.run(
        `UPDATE team_task SET status = 'pending', assignee = NULL, time_updated = ?
         WHERE id = ? AND team_id = ? AND status = 'in_progress' AND assignee = ?`,
        [now, attempt.claim_task_id, attempt.team_id, attempt.name],
      )
      if (released.changes === 1) {
        appendTeamEvent(db, {
          teamId: attempt.team_id,
          kind: "task.released",
          payload: { task_id: attempt.claim_task_id, reason: "spawn_rollback" },
          causeEventId: attempt.claim_event_id ?? undefined,
        })
        recomputeCurrentPhase(db, attempt.team_id, now)
      }
    }
    const deleted = db.run(
      "DELETE FROM team_spawn_attempt WHERE team_id = ? AND name = ?",
      [attempt.team_id, attempt.name],
    )
    if (deleted.changes !== 1) throw new Error(`spawn attempt ${attempt.name} changed before settlement`)
  })
}
