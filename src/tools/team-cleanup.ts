import type { ToolDeps } from "../types"
import { requireLead, requireCanPurgeArchivedTeams, checkWorktreeDirty } from "./shared"
import type { IsDirtyFn } from "./shared"
import { spawnFailures } from "./team-spawn"
import { getTeamResourceParts, mergeBranch, deleteBranch, preserveBranch, preservedBranchName, getOverlappingFiles, resolveWorktreeBranch, teamResourceSegment } from "./merge-helper"
import type { MergeBranchFn, DeleteBranchFn, PreserveBranchFn, ResolveWorktreeBranchFn, OverlapCheckFn } from "./merge-helper"
import { appendTeamEvent, deleteArchivedTeamForExplicitPurge } from "../team-event"
import { log } from "../log"
import { runCommand } from "../process"
import { sendLeadAlert } from "../messaging"
import { recomputeCurrentPhase } from "../task-phase"
import { appendMemberTransition, releaseMemberTasks } from "../telemetry"
import { resolveAbortBranch, type AbortBranchResolution } from "../abort-preservation"
import { getTeamRepositoryBinding } from "../repository-binding"

type PurgeApprovalFn = (preview: string) => Promise<void>
type ListBranchesFn = (namespace: string, cwd: string) => Promise<string[]>
type BranchExistsFn = (branch: string, cwd: string) => Promise<boolean>

interface PurgeTarget {
  id: string
  name: string
  project_id: string
  project_name: string
  repository_root: string
  time_updated: number
}

interface PurgeStats extends PurgeTarget {
  members: number
  tasks: number
  messages: number
  artifacts: number
  artifactBytes: number
  branches: number
  staleResources: number
  staleBranches: number
}

interface PurgeMemberResource {
  team_id: string
  team_name: string
  project_name: string
  member_name: string
  worktree_dir: string | null
  workspace_id: string | null
  worktree_branch: string | null
}

async function listPreservedBranches(teamName: string, cwd: string): Promise<string[]> {
  try {
    const result = await runCommand(["git", "branch", "--list", `ensemble/preserved/${teamName}/*`, "--format", "%(refname:short)"], { cwd })
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git branch exited with code ${result.exitCode}`)
    return result.stdout.split("\n").map(branch => branch.trim()).filter(Boolean)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes("not a git repository")) return []
    throw new Error(`Failed to list preserved branches for ${teamName}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function branchExists(branch: string, cwd: string): Promise<boolean> {
  try {
    const result = await runCommand(["git", "branch", "--list", branch, "--format", "%(refname:short)"], { cwd })
    if (result.exitCode !== 0) {
      if (result.stderr.includes("not a git repository")) return false
      throw new Error(result.stderr.trim() || `git branch exited with code ${result.exitCode}`)
    }
    return result.stdout.split("\n").map(item => item.trim()).includes(branch)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message.includes("not a git repository")) return false
    throw new Error(`Failed to check stale Ensemble branch ${branch}: ${message}`)
  }
}

function normalizeBranchName(branch: string): string {
  return branch.trim().replace(/^\*\s*/, "")
}

function resolvePurgeTargets(deps: ToolDeps, purge: string[]): PurgeTarget[] {
  if (purge.length === 0) throw new Error("Pass at least one archived team name to purge, or ['*'] for all archived teams.")
  if (purge.includes("*") && purge.length !== 1) {
    throw new Error("Wildcard purge cannot be combined with explicit team names. Use purge: ['*'] by itself.")
  }

  if (purge.includes("*")) {
    return deps.db.query("SELECT t.id, t.name, t.project_id, COALESCE(p.slug, p.name) as project_name, p.path as repository_root, t.time_updated FROM team t JOIN project p ON t.project_id = p.id WHERE t.status = 'archived' AND t.controller_directory = ? ORDER BY t.time_updated DESC, t.name ASC")
      .all(deps.directory) as PurgeTarget[]
  }

  const uniqueNames = [...new Set(purge)]
  const rows = uniqueNames.map(name => ({
    name,
    teams: deps.db.query("SELECT t.id, t.name, t.project_id, COALESCE(p.slug, p.name) as project_name, p.path as repository_root, t.status, t.time_updated FROM team t JOIN project p ON t.project_id = p.id WHERE t.name = ? AND t.controller_directory = ? ORDER BY t.time_updated DESC")
      .all(name, deps.directory) as Array<PurgeTarget & { status: string }>,
  }))

  const missing = rows.filter(row => row.teams.length === 0).map(row => row.name)
  if (missing.length > 0) throw new Error(`Team not found: ${missing.join(", ")}`)

  const active = rows.filter(row => row.teams.some(team => team.status === "active")).map(row => row.name)
  if (active.length > 0) throw new Error(`Cannot purge active team: ${active.join(", ")}`)

  return rows
    .flatMap(row => row.teams[0] ? [row.teams[0]] : [])
    .sort((a, b) => b.time_updated - a.time_updated || a.name.localeCompare(b.name))
}

function deleteArchivedTeams(deps: ToolDeps, targets: PurgeTarget[]): void {
  const transaction = deps.db.transaction((teams: PurgeTarget[]) => {
    teams.forEach(team => {
      const row = deps.db.query("SELECT status FROM team WHERE id = ?").get(team.id) as { status: string } | null
      if (!row) throw new Error(`Team not found: ${team.name}`)
      if (row.status === "active") throw new Error(`Cannot purge active team: ${team.name}`)
    })
    validatePurgeResources(deps, teams)
    teams.forEach(team => {
      deleteArchivedTeamForExplicitPurge(deps.db, team.id)
    })
  })
  transaction(targets)
  targets.forEach(team => {
    deps.registry.unregisterTeam(team.id)
    spawnFailures.delete(team.id)
  })
}

function getPurgeMemberResources(deps: ToolDeps, targets: PurgeTarget[]): PurgeMemberResource[] {
  return targets.flatMap(target => deps.db.query(
    `SELECT t.name as team_name,
            COALESCE(p.slug, p.name) as project_name,
            tm.team_id,
            tm.name as member_name,
            tm.worktree_dir,
            tm.workspace_id,
            tm.worktree_branch
     FROM team_member tm
     JOIN team t ON tm.team_id = t.id
     JOIN project p ON t.project_id = p.id
     WHERE tm.team_id = ?`
  ).all(target.id) as PurgeMemberResource[])
}

function preservedBranchPrefix(resource: PurgeMemberResource): string {
  return `ensemble/preserved/${resource.project_name}/${teamResourceSegment(resource.team_name, resource.team_id)}/`
}

function legacyPreservedBranchPrefix(resource: PurgeMemberResource): string {
  return `ensemble/preserved/${resource.team_name}/`
}

function staleEnsembleBranchNames(resource: PurgeMemberResource): string[] {
  return [
    `ensemble-${resource.team_id}-${resource.member_name}`,
    `ensemble-${resource.team_name}-${resource.member_name}`,
    `opencode/ensemble-${resource.team_name}-${resource.member_name}`,
  ]
}

function isPreservedBranch(resource: PurgeMemberResource): boolean {
  return resource.worktree_branch !== null && (
    resource.worktree_branch.startsWith(preservedBranchPrefix(resource)) ||
    resource.worktree_branch.startsWith(legacyPreservedBranchPrefix(resource))
  )
}

function isStaleEnsembleBranch(resource: PurgeMemberResource): boolean {
  return resource.worktree_branch !== null && staleEnsembleBranchNames(resource).includes(resource.worktree_branch)
}

function validatePurgeResources(deps: ToolDeps, targets: PurgeTarget[]): void {
  const resources = getPurgeMemberResources(deps, targets)
  const nonPreserved = resources.filter(resource =>
    resource.worktree_branch !== null && !isPreservedBranch(resource) && !isStaleEnsembleBranch(resource)
  )
  if (nonPreserved.length > 0) {
    const details = nonPreserved.map(resource => `${resource.team_name}/${resource.member_name} (${resource.worktree_branch})`).join(", ")
    throw new Error(`Cannot purge archived teams: ${details} has a non-preserved worktree branch or a branch outside its preserved namespace.`)
  }

  const activeResourceRefs = resources.flatMap(resource => {
    const worktreeRefs = resource.worktree_dir
      ? deps.db.query(
        `SELECT t.name as team_name, tm.name as member_name
         FROM team_member tm
         JOIN team t ON tm.team_id = t.id
         WHERE t.status = 'active' AND tm.worktree_dir = ?`
      ).all(resource.worktree_dir) as Array<{ team_name: string; member_name: string }>
      : []
    const workspaceRefs = resource.workspace_id
      ? deps.db.query(
        `SELECT t.name as team_name, tm.name as member_name
         FROM team_member tm
         JOIN team t ON tm.team_id = t.id
         WHERE t.status = 'active' AND tm.workspace_id = ?`
      ).all(resource.workspace_id) as Array<{ team_name: string; member_name: string }>
      : []
    return [
      ...worktreeRefs.map(ref => `${resource.team_name}/${resource.member_name} worktree is also referenced by active team ${ref.team_name}/${ref.member_name}`),
      ...workspaceRefs.map(ref => `${resource.team_name}/${resource.member_name} workspace is also referenced by active team ${ref.team_name}/${ref.member_name}`),
    ]
  })
  if (activeResourceRefs.length > 0) {
    throw new Error(`Cannot purge archived teams: ${[...new Set(activeResourceRefs)].join(", ")}.`)
  }
}

function collectStaleEnsembleBranches(deps: ToolDeps, targets: PurgeTarget[]): string[] {
  return [...new Set(
    getPurgeMemberResources(deps, targets)
      .flatMap(resource => isStaleEnsembleBranch(resource) && resource.worktree_branch ? [resource.worktree_branch] : [])
  )]
}

function countStaleResourceRefs(deps: ToolDeps, target: PurgeTarget): number {
  return getPurgeMemberResources(deps, [target]).reduce(
    (count, resource) => count + (resource.worktree_dir ? 1 : 0) + (resource.workspace_id ? 1 : 0),
    0,
  )
}

function countStaleBranchRefs(deps: ToolDeps, target: PurgeTarget): number {
  return collectStaleEnsembleBranches(deps, [target]).length
}

async function existingWorktreeDirs(deps: ToolDeps, resources: PurgeMemberResource[]): Promise<Set<string>> {
  if (!resources.some(resource => resource.worktree_dir)) return new Set()
  try {
    const roots = [...new Set(resources.map(resource => getTeamRepositoryBinding(deps.db, resource.team_id).repositoryRoot))]
    const listed = await Promise.all(roots.map(directory => deps.client.worktree.list({ directory })))
    return new Set(listed.flatMap(result => result.data ?? []).map(worktree => worktree.directory))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Cannot purge archived teams: failed to list worktrees before stale resource cleanup: ${message}`)
  }
}

async function existingWorkspaceIds(deps: ToolDeps, resources: PurgeMemberResource[]): Promise<Set<string>> {
  if (!resources.some(resource => resource.workspace_id)) return new Set()
  try {
    const roots = [...new Set(resources.map(resource => getTeamRepositoryBinding(deps.db, resource.team_id).repositoryRoot))]
    const listed = await Promise.all(roots.map(directory => deps.client.workspace.list({ directory })))
    return new Set(listed.flatMap(result => result.data ?? []).map(workspace => workspace.id))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Cannot purge archived teams: failed to list workspaces before stale resource cleanup: ${message}`)
  }
}

async function cleanupStalePurgeResources(deps: ToolDeps, targets: PurgeTarget[], isDirty: IsDirtyFn): Promise<void> {
  const resources = getPurgeMemberResources(deps, targets).filter(resource => resource.worktree_dir || resource.workspace_id)
  if (resources.length === 0) return

  const worktreeDirs = await existingWorktreeDirs(deps, resources)
  const workspaceIds = await existingWorkspaceIds(deps, resources)

  for (const resource of resources) {
    const repositoryRoot = getTeamRepositoryBinding(deps.db, resource.team_id).repositoryRoot
    if (resource.workspace_id) {
      if (workspaceIds.has(resource.workspace_id)) {
        try {
          await deps.client.workspace.remove({ directory: repositoryRoot, id: resource.workspace_id })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          throw new Error(`Failed to remove stale workspace for ${resource.team_name}/${resource.member_name}: ${message}`)
        }
      }
      deps.db.run("UPDATE team_member SET workspace_id = NULL WHERE team_id = ? AND name = ?", [resource.team_id, resource.member_name])
    }

    if (resource.worktree_dir) {
      if (worktreeDirs.has(resource.worktree_dir)) {
        let dirty: boolean
        try {
          dirty = await isDirty(resource.worktree_dir)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          throw new Error(`Cannot purge archived teams: failed to check archived worktree for uncommitted changes at ${resource.worktree_dir}: ${message}`)
        }
        if (dirty) {
          throw new Error(`Cannot purge archived teams: ${resource.team_name}/${resource.member_name} has uncommitted changes in archived worktree ${resource.worktree_dir}.`)
        }
        try {
          await deps.client.worktree.remove({ directory: repositoryRoot, worktreeRemoveInput: { directory: resource.worktree_dir } })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          throw new Error(`Failed to remove stale worktree for ${resource.team_name}/${resource.member_name}: ${message}`)
        }
      }
      deps.db.run("UPDATE team_member SET worktree_dir = NULL WHERE team_id = ? AND name = ?", [resource.team_id, resource.member_name])
    }
  }
}

async function deleteStaleEnsembleBranches(
  branches: string[],
  cwd: string,
  delBranch: DeleteBranchFn,
  exists: BranchExistsFn,
): Promise<void> {
  for (const branch of branches) {
    if (!await exists(branch, cwd)) continue
    const ok = await delBranch(branch, cwd)
    if (!ok) throw new Error(`Failed to delete stale Ensemble branch: ${branch}`)
  }
}

function validatePurgeTargetsStillArchived(deps: ToolDeps, targets: PurgeTarget[]): void {
  const missing: string[] = []
  const active: string[] = []
  targets.forEach(target => {
    const row = deps.db.query("SELECT status FROM team WHERE id = ?").get(target.id) as { status: string } | null
    if (!row) missing.push(target.name)
    else if (row.status === "active") active.push(target.name)
  })

  if (missing.length > 0) throw new Error(`Team not found: ${missing.join(", ")}`)
  if (active.length > 0) throw new Error(`Cannot purge active team: ${active.join(", ")}`)
}

async function collectPreservedBranches(
  targets: PurgeTarget[],
  cwd: string,
  listBranches: ListBranchesFn,
): Promise<Map<string, string[]>> {
  const entries: Array<[string, string[]]> = await Promise.all(targets.map(async target => {
    const prefixes = [`ensemble/preserved/${target.project_name}/${teamResourceSegment(target.name, target.id)}/`, `ensemble/preserved/${target.name}/`]
    let listed: string[]
    try {
      listed = [...await listBranches(target.project_name, cwd), ...await listBranches(target.name, cwd)]
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes("not a git repository")) listed = []
      else throw new Error(`Failed to list preserved branches for ${target.id}: ${message}`)
    }
    const branches = listed.map(normalizeBranchName).filter(branch => prefixes.some(prefix => branch.startsWith(prefix)))
    return [target.id, [...new Set(branches)]]
  }))
  return new Map(entries)
}

async function deletePreservedBranches(
  branchesByTeam: Map<string, string[]>,
  cwd: string,
  delBranch: DeleteBranchFn,
): Promise<void> {
  const branches = [...branchesByTeam.values()].flat()
  for (const branch of branches) {
    const ok = await delBranch(branch, cwd)
    if (!ok) throw new Error(`Failed to delete preserved branch: ${branch}`)
  }
}

function formatCount(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`
}

function buildPurgePreview(deps: ToolDeps, targets: PurgeTarget[], branchesByTeam: Map<string, string[]>): string {
  const rows = targets.map(target => {
    const members = (deps.db.query("SELECT COUNT(*) as c FROM team_member WHERE team_id = ?").get(target.id) as { c: number }).c
    const tasks = (deps.db.query("SELECT COUNT(*) as c FROM team_task WHERE team_id = ?").get(target.id) as { c: number }).c
    const messages = (deps.db.query("SELECT COUNT(*) as c FROM team_message WHERE team_id = ?").get(target.id) as { c: number }).c
    const artifactUsage = deps.db.query(
      "SELECT COUNT(*) AS artifacts, COALESCE(SUM(byte_count), 0) AS artifact_bytes FROM team_artifact WHERE team_id = ?",
    ).get(target.id) as { artifacts: number; artifact_bytes: number }
    const branches = branchesByTeam.get(target.id)?.length ?? 0
    const staleResources = countStaleResourceRefs(deps, target)
    const staleBranches = countStaleBranchRefs(deps, target)
    return {
      ...target,
      members,
      tasks,
      messages,
      artifacts: artifactUsage.artifacts,
      artifactBytes: artifactUsage.artifact_bytes,
      branches,
      staleResources,
      staleBranches,
    }
  }) satisfies PurgeStats[]
  const totals = rows.reduce(
    (acc, row) => ({
      members: acc.members + row.members,
      tasks: acc.tasks + row.tasks,
      messages: acc.messages + row.messages,
      artifacts: acc.artifacts + row.artifacts,
      artifactBytes: acc.artifactBytes + row.artifactBytes,
      branches: acc.branches + row.branches,
      staleResources: acc.staleResources + row.staleResources,
      staleBranches: acc.staleBranches + row.staleBranches,
    }),
    { members: 0, tasks: 0, messages: 0, artifacts: 0, artifactBytes: 0, branches: 0, staleResources: 0, staleBranches: 0 }
  )
  const details = rows.slice(0, 10).map(row =>
    `- ${row.name}: ${formatCount(row.members, "member")}, ${formatCount(row.tasks, "task")}, ${formatCount(row.messages, "message")}, ${formatCount(row.artifacts, "artifact")} (${row.artifactBytes} bytes), ${formatCount(row.branches, "preserved branch", "preserved branches")}, ${formatCount(row.staleResources, "stale resource")}, ${formatCount(row.staleBranches, "stale branch", "stale branches")}`
  )
  const hidden = rows.length > 10 ? [`...and ${rows.length - 10} more archived team${rows.length - 10 === 1 ? "" : "s"}`] : []

  return [
    "Permanently delete archived teams?",
    "This will logically delete archived team records and cascade-delete their members, tasks, messages, and artifacts. It does not promise secure erasure from storage snapshots or backups.",
    "",
    ...details,
    ...hidden,
    "",
    `Total: ${formatCount(rows.length, "team")}, ${formatCount(totals.members, "member")}, ${formatCount(totals.tasks, "task")}, ${formatCount(totals.messages, "message")}, ${formatCount(totals.artifacts, "artifact")} (${totals.artifactBytes} bytes), ${formatCount(totals.branches, "preserved branch", "preserved branches")}, ${formatCount(totals.staleResources, "stale resource")}, ${formatCount(totals.staleBranches, "stale branch", "stale branches")}`,
  ].join("\n")
}

function buildPurgeConfirmationInstructions(preview: string, confirmToken: string): string {
  const approvalLabel = `Approve purge ${confirmToken.slice(0, 8)}`
  const denialLabel = `Deny purge ${confirmToken.slice(0, 8)}`
  return [
    "Purge preview only — no teams were deleted.",
    "",
    preview,
    "",
    "Use the question tool to ask the user whether to permanently delete these archived teams.",
    `The approval option label must be exactly: ${approvalLabel}`,
    `The denial option label must be exactly: ${denialLabel}`,
    `Confirmation token: ${confirmToken}`,
    `Only if the user selects "${approvalLabel}", call team_cleanup again with the same purge value, confirm_purge: true, and confirm_token set to this token.`,
  ].join("\n")
}

/**
 * Execute the team_cleanup tool. Archives the team after every writer branch
 * has completed explicit integration and cleans up its resources.
 */
export async function executeTeamCleanup(
  deps: ToolDeps,
  args: { force: boolean; acknowledge_uncommitted?: boolean; purge?: string[]; confirm_purge?: boolean; confirm_token?: string },
  sessionId: string,
  isDirty: IsDirtyFn = checkWorktreeDirty,
  _merge: MergeBranchFn = mergeBranch,
  delBranch: DeleteBranchFn = deleteBranch,
  _mergeOnCleanup = true,
  _overlapCheck: OverlapCheckFn = getOverlappingFiles,
  _approvePurge?: PurgeApprovalFn,
  _listBranches?: ListBranchesFn,
  _branchExists?: BranchExistsFn,
  preserve: PreserveBranchFn = preserveBranch,
  resolveBranch: ResolveWorktreeBranchFn = resolveWorktreeBranch,
): Promise<string> {
  if (args.purge && args.purge.length > 0) {
    requireCanPurgeArchivedTeams(deps, sessionId)
    const targets = resolvePurgeTargets(deps, args.purge)
    if (targets.length === 0) return "No archived teams to purge."

    validatePurgeTargetsStillArchived(deps, targets)
    validatePurgeResources(deps, targets)
    const branchesByTeam = new Map<string, string[]>()
    for (const target of targets) {
      const branches = await collectPreservedBranches([target], target.repository_root, _listBranches ?? listPreservedBranches)
      branchesByTeam.set(target.id, branches.get(target.id) ?? [])
    }
    const preview = buildPurgePreview(deps, targets, branchesByTeam)
    if (!args.confirm_purge) {
      const confirmToken = deps.purgeApprovals.create(sessionId, targets.map(target => target.id))
      return buildPurgeConfirmationInstructions(preview, confirmToken)
    }

    if (!args.confirm_token) {
      throw new Error("A purge confirmation token is required. First call team_cleanup without confirm_purge, then use the question tool before confirming.")
    }
    deps.purgeApprovals.consume(sessionId, args.confirm_token, targets.map(target => target.id))

    validatePurgeTargetsStillArchived(deps, targets)
    validatePurgeResources(deps, targets)
    await cleanupStalePurgeResources(deps, targets, isDirty)

    validatePurgeResources(deps, targets)
    for (const target of targets) {
      await deleteStaleEnsembleBranches(collectStaleEnsembleBranches(deps, [target]), target.repository_root, delBranch, _branchExists ?? branchExists)
      const finalBranches = await collectPreservedBranches([target], target.repository_root, _listBranches ?? listPreservedBranches)
      await deletePreservedBranches(finalBranches, target.repository_root, delBranch)
    }

    deleteArchivedTeams(deps, targets)

    const noun = targets.length === 1 ? "archived team" : "archived teams"
    return `Permanently deleted ${targets.length} ${noun}: ${targets.map(target => target.name).join(", ")}.`
  }

  let teamInfo: ReturnType<typeof requireLead>
  try {
    teamInfo = requireLead(deps, sessionId)
  } catch (error) {
    const archived = deps.db.query(
      "SELECT name FROM team WHERE lead_session_id = ? AND controller_directory = ? AND status = 'archived' ORDER BY time_updated DESC LIMIT 1",
    ).get(sessionId, deps.directory) as { name: string } | null
    if (archived) return `Team "${archived.name}" was already cleaned up. No action was needed.`
    throw error
  }
  const repositoryRoot = getTeamRepositoryBinding(deps.db, teamInfo.teamId).repositoryRoot

  const members = deps.db.query(
    `SELECT name, session_id, status, worktree_dir, worktree_branch,
            worktree_source_branch, worktree_baseline_oid, workspace_id,
            merge_state, merged_source_branch
     FROM team_member WHERE team_id = ?`,
  ).all(teamInfo.teamId) as Array<{
    name: string
    session_id: string
    status: string
    worktree_dir: string | null
    worktree_branch: string | null
    worktree_source_branch: string | null
    worktree_baseline_oid: string | null
    workspace_id: string | null
    merge_state: string
    merged_source_branch: string | null
  }>

  const active = members.filter(m => m.status !== "shutdown" && m.status !== "error")
  const abortable = members.filter(m => m.status !== "shutdown" && m.status !== "error")

  if (active.length > 0 && !args.force) {
    const names = active.map(m => m.name).join(", ")
    throw new Error(`Cannot clean up team "${teamInfo.teamName}": ${active.length} member(s) still active: ${names}. Use team_shutdown on each member first, or call team_cleanup with force: true to abort them immediately.`)
  }

  // Check for uncommitted changes BEFORE aborting sessions
  if (!args.acknowledge_uncommitted) {
    const dirty: Array<{ name: string; branch: string }> = []
    for (const member of members) {
      if (member.worktree_dir) {
        try {
          if (await isDirty(member.worktree_dir)) {
            dirty.push({ name: member.name, branch: member.worktree_branch ?? "unknown" })
          }
        } catch {
          log(`cleanup:dirty-check:failed name=${member.name}`)
        }
      }
    }
    if (dirty.length > 0) {
      const warnings = dirty.map(d => `  - ${d.name} (branch: ${d.branch})`).join("\n")
      return `Warning: ${dirty.length} teammate(s) have uncommitted changes in their worktrees:\n${warnings}\n\nCommit or merge their work first, then call team_cleanup with acknowledge_uncommitted: true to proceed.`
    }
  }

  // Force-abort active members — preserve branches BEFORE aborting
  if (args.force) {
    const preserved = new Map<string, string>()
    for (const member of abortable) {
      let resolution: AbortBranchResolution
      try {
        resolution = await resolveAbortBranch(member.worktree_branch, member.worktree_dir, resolveBranch)
      } catch (error) {
        log(`cleanup:branch:resolve-failed name=${member.name} err=${error instanceof Error ? error.message : String(error)}`)
        resolution = { ok: false as const, reason: "its live source branch could not be resolved" }
      }
      if (!resolution.ok) {
        sendLeadAlert(deps.db, deps.client, {
          teamId: teamInfo.teamId,
          content: `Force cleanup for team "${teamInfo.teamName}" was blocked because ${member.name} ${resolution.reason}. No sessions were aborted and the team remains active. Inspect the worktree and retry force cleanup.`,
          wakeText: `[System: Force cleanup for ${teamInfo.teamName} could not verify ${member.name}'s live branch; guidance is available in team messages]`,
        })
        throw new Error(`Cannot clean up team "${teamInfo.teamName}": failed to resolve the live branch for ${member.name}: ${resolution.reason}. No sessions were aborted; retry after resolving the worktree branch.`)
      }
      const sourceBranch = resolution.sourceBranch
      if (!sourceBranch) continue
      const resource = getTeamResourceParts(deps.db, teamInfo.teamId)
      const safeBranch = preservedBranchName(resource.projectName, resource.teamName, resource.teamId, member.name)
      const ok = await preserve(sourceBranch, safeBranch, repositoryRoot)
      if (!ok) {
        sendLeadAlert(deps.db, deps.client, {
          teamId: teamInfo.teamId,
          content: `Force cleanup for team "${teamInfo.teamName}" was blocked because ${member.name}'s branch ${sourceBranch} could not be preserved. No sessions were aborted and the team remains active.`,
          wakeText: `[System: Force cleanup for ${teamInfo.teamName} was blocked by branch preservation failure; guidance is available in team messages]`,
        })
        throw new Error(`Cannot clean up team "${teamInfo.teamName}": failed to preserve ${member.name}'s branch ${sourceBranch}. No sessions were aborted; retry after resolving the branch.`)
      }
      preserved.set(member.name, safeBranch)
    }

    if (abortable.length > 0) {
      deps.db.transaction(() => {
        deps.db.run(
          `UPDATE team_member SET status = 'shutdown_requested', time_updated = ?
           WHERE team_id = ? AND status NOT IN ('shutdown', 'shutdown_requested', 'error')`,
          [Date.now(), teamInfo.teamId],
        )
        preserved.forEach((safeBranch, memberName) => {
          const recorded = deps.db.run(
            `UPDATE team_member SET worktree_branch = ?, time_updated = ?
             WHERE team_id = ? AND name = ? AND status = 'shutdown_requested'`,
            [safeBranch, Date.now(), teamInfo.teamId, memberName],
          )
          if (recorded.changes !== 1) {
            throw new Error(`Cannot clean up team "${teamInfo.teamName}": ${memberName}'s safe branch reference could not be recorded before abort.`)
          }
        })
      })()
    }
    for (const member of abortable) {
      try {
        await deps.client.session.abort({ sessionID: member.session_id })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        sendLeadAlert(deps.db, deps.client, {
          teamId: teamInfo.teamId,
          content: `Force cleanup for team "${teamInfo.teamName}" could not abort ${member.name}. The team remains active; no branches were merged and no worktrees or workspaces were removed. The live source branch ${member.worktree_branch ?? "(none)"} remains assigned to ${member.name}, and its latest preserved snapshot is ${preserved.get(member.name) ?? "(none)"}. Resolve the abort failure, then retry force cleanup. Error: ${message}.`,
          wakeText: `[System: Force cleanup for ${teamInfo.teamName} could not abort ${member.name}; guidance is available in team messages]`,
        })
        throw new Error(`Cannot clean up team "${teamInfo.teamName}": failed to abort ${member.name}. The team remains active and its live source branch is retained; retry force cleanup after resolving the abort failure. Error: ${message}`)
      }

      const safeBranch = preserved.get(member.name)
      deps.db.transaction(() => {
        const now = Date.now()
        const settled = deps.db.run(
          `UPDATE team_member
           SET status = 'shutdown', execution_status = 'idle', worktree_branch = COALESCE(?, worktree_branch), time_updated = ?
           WHERE team_id = ? AND name = ? AND status = 'shutdown_requested'`,
          [safeBranch ?? null, now, teamInfo.teamId, member.name],
        )
        if (settled.changes !== 1) {
          throw new Error(`Cannot clean up team "${teamInfo.teamName}": ${member.name}'s shutdown state changed after abort.`)
        }
        appendMemberTransition(deps.db, teamInfo.teamId, member.name, "shutdown_requested", "shutdown", "cancelling", "idle", "force_cleanup")
        releaseMemberTasks(deps.db, teamInfo.teamId, member.name, "force_cleanup", now)
        recomputeCurrentPhase(deps.db, teamInfo.teamId, now)
      })()
      member.status = "shutdown"
      if (safeBranch) member.worktree_branch = safeBranch
    }
  }

  const isWriter = (member: (typeof members)[number]) => member.worktree_branch !== null
    || member.worktree_source_branch !== null
    || member.worktree_baseline_oid !== null
  const awaitingMerge = members.filter(member => isWriter(member) && member.merge_state === "none")
  const interruptedMerges = members.filter(member => isWriter(member) && member.merge_state === "merging")
  const invalidMissingRefSettlements = members.filter(member => {
    if (member.worktree_branch !== null || !isWriter(member) || member.merge_state !== "merged") return false
    if (!member.merged_source_branch) return true
    const completed = deps.db.query(
      "SELECT 1 AS present FROM team_event WHERE team_id = ? AND kind = 'merge.completed' AND payload = ? LIMIT 1",
    ).get(teamInfo.teamId, JSON.stringify({ member_name: member.name })) as { present: number } | null
    return !completed
  })
  if (awaitingMerge.length > 0 || interruptedMerges.length > 0 || invalidMissingRefSettlements.length > 0) {
    const guidance = [`Team "${teamInfo.teamName}" was not cleaned up. Writer branches require explicit merge verification before resources can be removed or the team archived.`]
    if (awaitingMerge.length > 0) {
      const names = awaitingMerge.map(member => `${member.name} (${member.worktree_branch ?? member.worktree_source_branch ?? "missing branch evidence"})`).join(", ")
      guidance.push(`Call team_merge for: ${names}. Review the resulting unstaged changes, then retry team_cleanup.`)
    }
    if (interruptedMerges.length > 0) {
      const names = interruptedMerges.map(member => `${member.name} (${member.worktree_branch ?? member.worktree_source_branch ?? "missing branch evidence"})`).join(", ")
      guidance.push(`Merge already started for: ${names}. Inspect git diff and each source branch, verify the integration result, and settle the merge explicitly before retrying team_cleanup; Ensemble will not reapply it automatically.`)
    }
    if (invalidMissingRefSettlements.length > 0) {
      const names = invalidMissingRefSettlements.map(member => member.name).join(", ")
      guidance.push(`Missing-ref merge settlement is incomplete for: ${names}. Retry team_merge after restoring verifiable branch or worktree evidence.`)
    }
    return guidance.join("\n")
  }

  const mergedWithBranch = members.filter(member => member.worktree_branch !== null && member.merge_state === "merged")
  const residualBranches: string[] = []
  for (const member of mergedWithBranch) {
    const branch = member.worktree_branch
    if (!branch) continue
    if (await delBranch(branch, repositoryRoot)) {
      deps.db.run("UPDATE team_member SET worktree_branch = NULL WHERE team_id = ? AND name = ?", [teamInfo.teamId, member.name])
      member.worktree_branch = null
    } else {
      residualBranches.push(`${member.name} (${branch})`)
    }
  }

  // Remove workspaces and worktrees
  for (const member of members) {
    if (member.workspace_id) {
      try {
        await deps.client.workspace.remove({ directory: repositoryRoot, id: member.workspace_id })
        deps.db.run("UPDATE team_member SET workspace_id = NULL WHERE team_id = ? AND name = ?", [teamInfo.teamId, member.name])
      } catch { /* best effort */ }
    }
    if (member.worktree_dir) {
      try {
        await deps.client.worktree.remove({ directory: repositoryRoot, worktreeRemoveInput: { directory: member.worktree_dir } })
        deps.db.run("UPDATE team_member SET worktree_dir = NULL WHERE team_id = ? AND name = ?", [teamInfo.teamId, member.name])
      } catch { /* best effort */ }
    }
  }

  // Archive the team and consume residual messages atomically. A failed
  // fire-and-forget delivery cannot reopen messages after this boundary.
  deps.db.transaction(() => {
    const archived = deps.db.run(
      "UPDATE team SET status = 'archived', time_updated = ? WHERE id = ? AND status = 'active'",
      [Date.now(), teamInfo.teamId],
    )
    if (archived.changes === 1) {
      appendTeamEvent(deps.db, { teamId: teamInfo.teamId, kind: "team.archived", payload: {} })
    }
    deps.db.run("UPDATE team_message SET delivered = 1, delivery_claimed_at = NULL WHERE team_id = ? AND delivered = 0", [teamInfo.teamId])
  })()

  // Clean up in-memory state
  deps.registry.unregisterTeam(teamInfo.teamId)
  spawnFailures.delete(teamInfo.teamId)

  // Build response
  const parts: string[] = [`Team "${teamInfo.teamName}" cleaned up.`]
  if (residualBranches.length > 0) {
    parts.push(`Branch cleanup failed after integration; these branches remain recorded and will not be merged twice: ${residualBranches.join(", ")}.`)
  }
  return parts.join("\n")
}
