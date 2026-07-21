import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"
import { generateId } from "../util"
import { immediateTransaction } from "../db"

interface TaskInput {
  key?: string
  content: string
  priority: string
  depends_on?: string[]
  phase?: string
}

/**
 * Execute the team_tasks_add tool. Adds tasks to the shared board.
 * Tasks with unresolved dependencies are marked as 'blocked'.
 */
export async function executeTeamTasksAdd(
  deps: ToolDeps,
  args: { tasks: TaskInput[] },
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)

  if (args.tasks.length === 0) return "Added 0 tasks."
  const ids = args.tasks.map(() => generateId("task"))
  const keyedIds = new Map<string, string>()
  args.tasks.forEach((task, index) => {
    if (!task.key) return
    if (!/^[a-z0-9][a-z0-9-_]{0,63}$/.test(task.key)) {
      throw new Error(`Task key "${task.key}" must be 1-64 lowercase alphanumeric, hyphen, or underscore characters`)
    }
    if (keyedIds.has(task.key)) throw new Error(`Duplicate task key "${task.key}"`)
    keyedIds.set(task.key, ids[index]!)
  })

  const now = Date.now()
  immediateTransaction(deps.db, () => {
    const active = deps.db.query("SELECT id FROM team WHERE id = ? AND status = 'active'").get(teamInfo.teamId)
    if (!active) throw new Error(`Team "${teamInfo.teamName}" is no longer active`)
    const existing = new Map(
      (deps.db.query("SELECT id, status FROM team_task WHERE team_id = ?").all(teamInfo.teamId) as Array<{ id: string; status: string }>)
        .map(task => [task.id, task.status]),
    )
    const resolvedDependencies = args.tasks.map((task, index) => (task.depends_on ?? []).map(reference => {
      const resolved = keyedIds.get(reference) ?? (existing.has(reference) ? reference : undefined)
      if (!resolved) throw new Error(`Dependency "${reference}" not found in this Team or task batch`)
      if (resolved === ids[index]) throw new Error(`Task dependency cycle: "${task.key ?? ids[index]}" depends on itself`)
      return resolved
    }))
    assertAcyclic(ids, resolvedDependencies)

    args.tasks.forEach((task, index) => {
      const dependencies = resolvedDependencies[index]!
      const resolved = dependencies.every(depId => {
        const batchIndex = ids.indexOf(depId)
        if (batchIndex >= 0) return false
        const status = existing.get(depId)
        return status === "completed" || status === "cancelled"
      })
      deps.db.run(
        `INSERT INTO team_task (id, team_id, content, status, priority, depends_on, phase, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ids[index], teamInfo.teamId, task.content, dependencies.length > 0 && !resolved ? "blocked" : "pending",
          task.priority, dependencies.length > 0 ? JSON.stringify(dependencies) : null, task.phase ?? null, now, now],
      )
    })
    const phase = args.tasks.map(task => task.phase?.trim()).filter((value): value is string => Boolean(value)).at(-1)
    if (phase) {
      deps.db.run("UPDATE team SET current_phase = ?, time_updated = ? WHERE id = ?", [phase, now, teamInfo.teamId])
    }
  })

  const mapping = [...keyedIds].map(([key, id]) => `${key}=${id}`)
  const detail = mapping.length > 0 ? mapping.join(", ") : ids.join(", ")
  return `Added ${ids.length} task${ids.length !== 1 ? "s" : ""}: ${detail}`
}

function assertAcyclic(ids: string[], dependencies: string[][]): void {
  const batch = new Set(ids)
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("Task dependency cycle detected")
    if (visited.has(id)) return
    visiting.add(id)
    const index = ids.indexOf(id)
    for (const dependency of dependencies[index] ?? []) {
      if (batch.has(dependency)) visit(dependency)
    }
    visiting.delete(id)
    visited.add(id)
  }
  ids.forEach(visit)
}
