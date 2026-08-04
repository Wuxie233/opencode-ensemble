import { realpath, stat } from "node:fs/promises"
import path from "node:path"
import type { Database } from "./db"
import { immediateTransaction } from "./db"
import { runCommand } from "./process"

/** Persisted repository and controller paths owned by one Team. */
export interface TeamRepositoryBinding {
  repositoryRoot: string
  controllerDirectory: string
  gitIdentity: string | null
}

/** Fully verified repository identity used when creating a Team. */
export interface VerifiedRepositoryBinding {
  repositoryRoot: string
  gitIdentity: string
}

/** Repository identity persisted for one writer member. */
export interface MemberRepositoryBinding {
  repositoryRoot: string
  gitIdentity: string | null
}

/** Injectable repository operations used by tools and focused tests. */
export interface RepositoryBindingOps {
  canonicalControllerDirectory(directory: string): Promise<string>
  verifyRepositoryRoot(directory: string, explicit: boolean): Promise<VerifiedRepositoryBinding>
  resolveGitRefOid(repositoryRoot: string, ref: string): Promise<string | null>
  resolveWorktreeIdentity(worktreeDir: string): Promise<{ gitIdentity: string; headOid: string }>
}

/** Production repository operations. */
export const repositoryBindingOps: RepositoryBindingOps = {
  canonicalControllerDirectory,
  verifyRepositoryRoot,
  resolveGitRefOid,
  resolveWorktreeIdentity,
}

/** Load the persisted repository binding for a Team. */
export function getTeamRepositoryBinding(db: Database, teamId: string): TeamRepositoryBinding {
  const row = db.query(
    `SELECT p.path AS repository_root, p.git_identity,
            COALESCE(t.controller_directory, p.path, t.project_id) AS controller_directory
     FROM team t JOIN project p ON p.id = t.project_id WHERE t.id = ?`,
  ).get(teamId) as {
    repository_root: string
    controller_directory: string
    git_identity: string | null
  } | null
  if (!row) throw new Error(`Team not found: ${teamId}`)
  if (!path.isAbsolute(row.repository_root) || !path.isAbsolute(row.controller_directory)) {
    throw new Error(`Team ${teamId} has an invalid repository binding; both paths must be absolute`)
  }
  return {
    repositoryRoot: path.normalize(row.repository_root),
    controllerDirectory: path.normalize(row.controller_directory),
    gitIdentity: row.git_identity ? path.normalize(row.git_identity) : null,
  }
}

/** Load a writer's repository binding, falling back only for legacy member rows. */
export function getMemberRepositoryBinding(db: Database, teamId: string, memberName: string): MemberRepositoryBinding {
  const row = db.query(
    `SELECT repository_root, repository_git_identity
     FROM team_member WHERE team_id = ? AND name = ?`,
  ).get(teamId, memberName) as {
    repository_root: string | null
    repository_git_identity: string | null
  } | null
  if (!row) throw new Error(`Teammate "${memberName}" not found in team ${teamId}`)
  if (row.repository_root === null && row.repository_git_identity === null) {
    const team = getTeamRepositoryBinding(db, teamId)
    return { repositoryRoot: team.repositoryRoot, gitIdentity: team.gitIdentity }
  }
  if (!row.repository_root || !row.repository_git_identity) {
    throw new Error(`Teammate "${memberName}" has an incomplete repository binding`)
  }
  if (!path.isAbsolute(row.repository_root) || !path.isAbsolute(row.repository_git_identity)) {
    throw new Error(`Teammate "${memberName}" has an invalid repository binding; both paths must be absolute`)
  }
  return {
    repositoryRoot: path.normalize(row.repository_root),
    gitIdentity: path.normalize(row.repository_git_identity),
  }
}

/**
 * Verify a Team's persisted exact repository root and recover a legacy null
 * Git identity with a conditional write. Existing identities remain immutable.
 */
export async function recoverTeamRepositoryBinding(
  db: Database,
  teamId: string,
  ops: RepositoryBindingOps = repositoryBindingOps,
): Promise<TeamRepositoryBinding> {
  const binding = getTeamRepositoryBinding(db, teamId)
  const verified = await ops.verifyRepositoryRoot(binding.repositoryRoot, true)
  if (path.normalize(verified.repositoryRoot) !== binding.repositoryRoot) {
    throw new Error(`Team ${teamId} repository root no longer matches its persisted exact root`)
  }
  if (binding.gitIdentity) {
    if (path.normalize(verified.gitIdentity) !== binding.gitIdentity) {
      throw new Error(`Team ${teamId} repository Git identity no longer matches its persisted identity`)
    }
    return binding
  }

  immediateTransaction(db, () => {
    db.run(
      `UPDATE project SET git_identity = ?, time_updated = ?
       WHERE id = (SELECT project_id FROM team WHERE id = ?)
         AND path = ? AND git_identity IS NULL`,
      [verified.gitIdentity, Date.now(), teamId, binding.repositoryRoot],
    )
  })
  const recovered = getTeamRepositoryBinding(db, teamId)
  if (recovered.repositoryRoot !== binding.repositoryRoot || recovered.gitIdentity !== path.normalize(verified.gitIdentity)) {
    throw new Error(`Team ${teamId} legacy Git identity recovery lost its conditional repository binding`)
  }
  return recovered
}

/** Verify and load one writer's persisted repository binding. */
export async function recoverMemberRepositoryBinding(
  db: Database,
  teamId: string,
  memberName: string,
  ops: RepositoryBindingOps = repositoryBindingOps,
): Promise<MemberRepositoryBinding> {
  const member = getMemberRepositoryBinding(db, teamId, memberName)
  const row = db.query(
    "SELECT repository_root, repository_git_identity FROM team_member WHERE team_id = ? AND name = ?",
  ).get(teamId, memberName) as { repository_root: string | null; repository_git_identity: string | null } | null
  if (!row) throw new Error(`Teammate "${memberName}" not found in team ${teamId}`)
  if (row.repository_root === null && row.repository_git_identity === null) {
    const team = await recoverTeamRepositoryBinding(db, teamId, ops)
    return { repositoryRoot: team.repositoryRoot, gitIdentity: team.gitIdentity }
  }

  const verified = await ops.verifyRepositoryRoot(member.repositoryRoot, true)
  if (path.normalize(verified.repositoryRoot) !== member.repositoryRoot) {
    throw new Error(`Teammate "${memberName}" repository root no longer matches its persisted exact root`)
  }
  if (!member.gitIdentity || path.normalize(verified.gitIdentity) !== member.gitIdentity) {
    throw new Error(`Teammate "${memberName}" repository Git identity no longer matches its persisted identity`)
  }
  return member
}

/** Canonicalize a controller directory without changing its repository scope. */
export async function canonicalControllerDirectory(directory: string): Promise<string> {
  if (!path.isAbsolute(directory)) throw new Error("Controller directory must be an absolute path")
  return realpath(directory)
}

/** Resolve and verify an exact Git repository root and its common-dir identity. */
export async function verifyRepositoryRoot(directory: string, explicit: boolean): Promise<VerifiedRepositoryBinding> {
  if (!path.isAbsolute(directory)) throw new Error("repository_root must be an absolute path")
  let canonical: string
  try {
    const info = await stat(directory)
    if (!info.isDirectory()) throw new Error("repository_root must identify a directory")
    canonical = await realpath(directory)
  } catch (error) {
    if (error instanceof Error && error.message === "repository_root must identify a directory") throw error
    throw new Error(`repository_root does not exist or cannot be read: ${directory}`)
  }

  const top = await runCommand(["git", "rev-parse", "--show-toplevel"], { cwd: canonical })
  if (top.exitCode !== 0) throw new Error(`repository_root is not inside a Git repository: ${canonical}`)
  const repositoryRoot = await realpath(top.stdout.trim())
  if (explicit && repositoryRoot !== canonical) {
    throw new Error(`repository_root must be the exact Git repository root: ${repositoryRoot}`)
  }

  const common = await runCommand(["git", "rev-parse", "--git-common-dir"], { cwd: repositoryRoot })
  if (common.exitCode !== 0 || !common.stdout.trim()) {
    throw new Error(`Could not resolve Git identity for repository_root: ${repositoryRoot}`)
  }
  const commonPath = path.isAbsolute(common.stdout.trim())
    ? common.stdout.trim()
    : path.resolve(repositoryRoot, common.stdout.trim())
  return { repositoryRoot, gitIdentity: await realpath(commonPath) }
}

/** Resolve a Git ref to its commit OID. */
export async function resolveGitRefOid(repositoryRoot: string, ref: string): Promise<string | null> {
  const result = await runCommand(["git", "rev-parse", "--verify", ref], { cwd: repositoryRoot })
  return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : null
}

/** Resolve a worktree's common-dir identity and HEAD OID. */
export async function resolveWorktreeIdentity(worktreeDir: string): Promise<{ gitIdentity: string; headOid: string }> {
  const common = await runCommand(["git", "rev-parse", "--git-common-dir"], { cwd: worktreeDir })
  const head = await runCommand(["git", "rev-parse", "--verify", "HEAD"], { cwd: worktreeDir })
  if (common.exitCode !== 0 || head.exitCode !== 0 || !common.stdout.trim() || !head.stdout.trim()) {
    throw new Error("created worktree Git identity or HEAD could not be verified")
  }
  const commonPath = path.isAbsolute(common.stdout.trim())
    ? common.stdout.trim()
    : path.resolve(worktreeDir, common.stdout.trim())
  return { gitIdentity: await realpath(commonPath), headOid: head.stdout.trim() }
}
