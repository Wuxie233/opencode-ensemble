import type { ToolDeps } from "../types"
import { generateId, generateProjectName, resourceSlug, validateProjectName, validateTeamName } from "../util"
import { findTeamBySession } from "../types"
import { immediateTransaction } from "../db"
import { appendTeamEvent } from "../team-event"
import { repositoryBindingOps } from "../repository-binding"

/**
 * Execute the team_create tool. Creates a new team with the caller as lead.
 */
export async function executeTeamCreate(
  deps: ToolDeps,
  args: { name: string; project_name?: string; repository_root?: string },
  sessionId: string,
): Promise<string> {
  const nameError = validateTeamName(args.name)
  if (nameError) throw new Error(nameError)
  if (args.project_name) {
    const projectNameError = validateProjectName(args.project_name)
    if (projectNameError) throw new Error(projectNameError)
  }

  const repositoryOps = deps.repositoryBindingOps ?? repositoryBindingOps
  const controllerDirectory = await repositoryOps.canonicalControllerDirectory(deps.directory)
  const repository = await repositoryOps.verifyRepositoryRoot(args.repository_root ?? controllerDirectory, args.repository_root !== undefined)
  const projectId = repository.repositoryRoot
  const existingProject = deps.db.query("SELECT git_identity FROM project WHERE id = ?").get(projectId) as { git_identity: string | null } | null
  if (existingProject?.git_identity && existingProject.git_identity !== repository.gitIdentity) {
    throw new Error(`repository_root Git identity changed for ${projectId}; existing Teams remain bound to ${existingProject.git_identity}`)
  }
  const existing = deps.db.query("SELECT id FROM team WHERE name = ? AND project_id = ? AND status = 'active'").get(args.name, projectId)
  if (existing) throw new Error(`Team "${args.name}" already exists`)

  // Check if session already leads a team
  const lead = findTeamBySession(deps.db, deps.registry, sessionId)
  if (lead) throw new Error(`This session already belongs to team "${lead.teamName}"`)

  const id = generateId("team")
  const now = Date.now()
  const projectName = args.project_name ?? generateProjectName()
  immediateTransaction(deps.db, () => {
    deps.db.run(
      `INSERT INTO project (id, name, slug, path, git_identity, status, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT(id) DO UPDATE SET git_identity = excluded.git_identity, time_updated = excluded.time_updated`,
      [projectId, projectName, resourceSlug(projectName, "project"), projectId, repository.gitIdentity, now, now]
    )
    deps.db.run(
      "INSERT INTO team (id, name, project_id, controller_directory, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?)",
      [id, args.name, projectId, controllerDirectory, sessionId, now, now]
    )
    appendTeamEvent(deps.db, { teamId: id, kind: "team.created", payload: {} })
  })

  return `Team "${args.name}" created. You are the lead. Use team_spawn to add teammates.`
}
