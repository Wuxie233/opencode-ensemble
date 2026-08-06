import { mkdtemp, realpath, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Database } from "../db"
import { log } from "../log"
import { runCommand } from "../process"

/** Result of merging a single branch. */
export interface MergeResult {
  ok: boolean
  error?: string
}

/** Injectable function for testing. */
export type MergeBranchFn = (branch: string, cwd: string) => Promise<MergeResult>

/** Injectable function for overlap detection before merge. */
export type OverlapCheckFn = (branch: string, cwd: string) => Promise<string[]>

/** Injectable function for preserving a branch before worktree deletion. */
export type PreserveBranchFn = (sourceBranch: string, targetBranch: string, cwd: string) => Promise<boolean>

/** Injectable function for resolving the branch currently checked out in a live worktree. */
export type ResolveWorktreeBranchFn = (worktreeDir: string) => Promise<string | null>

/** Injectable function for deleting a branch. */
export type DeleteBranchFn = (branch: string, cwd: string, expectedOid?: string) => Promise<boolean>

/** Persisted evidence available when recovering a failed writer branch. */
export interface FailedWriterEvidenceInput {
  repositoryRoot: string
  gitIdentity: string | null
  baselineOid: string | null
  sourceBranch: string | null
  preservedBranch: string | null
  worktreeDir: string | null
}

/** Fail-closed outcome of failed-writer branch evidence verification. */
export type FailedWriterEvidence =
  | { kind: "empty"; sourceBranch: string; sourceOid: string }
  | { kind: "merge"; sourceBranch: string; sourceOid: string }
  | { kind: "unverifiable"; reason: string }

/** Injectable failed-writer evidence verifier. */
export type VerifyFailedWriterEvidenceFn = (input: FailedWriterEvidenceInput) => Promise<FailedWriterEvidence>

/** Human-readable resource identity for a team. */
export interface TeamResourceParts {
  projectName: string
  teamName: string
  teamId: string
}

function shortTeamId(teamId: string): string {
  return (teamId.split("_").at(-1) || teamId).slice(0, 6)
}

function resourcePart(value: string): string {
  const part = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
  return part || "unnamed"
}

/** Load the human-readable pieces used to build team resource names. */
export function getTeamResourceParts(db: Database, teamId: string): TeamResourceParts {
  const row = db.query(
     `SELECT t.id as team_id, t.name as team_name, COALESCE(p.slug, p.name) as project_name
     FROM team t
     JOIN project p ON t.project_id = p.id
     WHERE t.id = ?`
  ).get(teamId) as { team_id: string; team_name: string; project_name: string } | null
  if (!row) throw new Error(`Team not found: ${teamId}`)
  return { projectName: row.project_name, teamName: row.team_name, teamId: row.team_id }
}

/** Build the readable namespace used for team-owned resources. */
export function teamResourceSlug(projectName: string, teamName: string, teamId: string): string {
  return `${resourcePart(projectName)}-${resourcePart(teamName)}#${shortTeamId(teamId)}`
}

/** Build the team-only resource segment used under project-scoped namespaces. */
export function teamResourceSegment(teamName: string, teamId: string): string {
  return `${resourcePart(teamName)}#${shortTeamId(teamId)}`
}

/** Build an OpenCode worktree name for a team member. */
export function teamWorktreeName(projectName: string, teamName: string, teamId: string, memberName: string): string {
  return normalizeWorktreeName(`ensemble-${teamResourceSlug(projectName, teamName, teamId)}-${memberName}`)
}

/** Normalize a requested worktree name exactly as OpenCode does before creation. */
export function normalizeWorktreeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/** Check whether a create response is the requested worktree or OpenCode's unique-name variant. */
export function matchesCreatedWorktreeName(requestedName: string, actualName: string): boolean {
  const normalizedName = normalizeWorktreeName(requestedName)
  return actualName === normalizedName || actualName.startsWith(`${normalizedName}-`)
}

/**
 * Copy a git branch to a new ref. Used to preserve worktree branches
 * before session.abort() which may delete the worktree and its branch.
 * Returns true if the branch was successfully copied.
 */
export async function preserveBranch(sourceBranch: string, targetBranch: string, cwd: string): Promise<boolean> {
  const source = await runCommand(["git", "rev-parse", "--verify", `refs/heads/${sourceBranch}`], { cwd })
  if (source.exitCode !== 0) {
    log(`merge-helper:preserve:failed src=${sourceBranch} target=${targetBranch} err=${source.stderr.trim()}`)
    return false
  }

  const sourceOid = source.stdout.trim()
  const targetRef = `refs/heads/${targetBranch}`
  const target = await runCommand(["git", "rev-parse", "--verify", targetRef], { cwd })
  const expectedTarget = target.exitCode === 0 ? target.stdout.trim() : ""
  if (expectedTarget) {
    const ancestor = await runCommand(["git", "merge-base", "--is-ancestor", expectedTarget, sourceOid], { cwd })
    if (ancestor.exitCode !== 0) {
      log(`merge-helper:preserve:diverged src=${sourceBranch} target=${targetBranch}`)
      return false
    }
  }

  // update-ref compares the old OID atomically, so a concurrent writer cannot
  // move the preserved ref between the ancestry check and the update.
  const result = await runCommand(["git", "update-ref", targetRef, sourceOid, expectedTarget], { cwd })
  if (result.exitCode !== 0) {
    log(`merge-helper:preserve:failed src=${sourceBranch} target=${targetBranch} err=${result.stderr.trim()}`)
    return false
  }
  return true
}

/** Resolve the branch currently checked out in a worktree. */
export async function resolveWorktreeBranch(worktreeDir: string): Promise<string | null> {
  const result = await runCommand(["git", "-C", worktreeDir, "branch", "--show-current"])
  if (result.exitCode !== 0) return null
  return result.stdout.trim() || null
}

/**
 * Delete a git branch. Returns true if successful.
 */
export async function deleteBranch(branch: string, cwd: string, expectedOid?: string): Promise<boolean> {
  const result = expectedOid
    ? await runCommand(["git", "update-ref", "-d", `refs/heads/${branch}`, expectedOid], { cwd })
    : await runCommand(["git", "branch", "-D", branch], { cwd })
  if (result.exitCode !== 0) {
    log(`merge-helper:delete:failed branch=${branch}`)
    return false
  }
  return true
}

async function gitOid(repositoryRoot: string, ref: string): Promise<string | null> {
  const result = await runCommand(["git", "rev-parse", "--verify", ref], { cwd: repositoryRoot })
  return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : null
}

async function symbolicBranch(repositoryRoot: string): Promise<string | null> {
  const result = await runCommand(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: repositoryRoot })
  return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : null
}

async function isAncestor(repositoryRoot: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await runCommand(["git", "merge-base", "--is-ancestor", ancestor, descendant], { cwd: repositoryRoot })
  return result.exitCode === 0
}

async function changedPaths(repositoryRoot: string, baseOid: string, sourceOid: string): Promise<string[] | null> {
  const result = await runCommand(["git", "diff-tree", "--no-commit-id", "--name-only", "-z", "-r", baseOid, sourceOid], { cwd: repositoryRoot })
  if (result.exitCode !== 0) return null
  return result.stdout.split("\0").filter(Boolean)
}

async function treeEntry(repositoryRoot: string, treeOid: string, filePath: string): Promise<string | null> {
  const result = await runCommand(["git", "ls-tree", "-z", "-r", "--full-tree", treeOid, "--", filePath], { cwd: repositoryRoot })
  if (result.exitCode !== 0) return null
  const entry = result.stdout.split("\0").find(Boolean)
  return entry ? entry.slice(0, entry.indexOf("\t")) : ""
}

async function repositoryGitIdentity(repositoryRoot: string): Promise<string | null> {
  const result = await runCommand(["git", "rev-parse", "--git-common-dir"], { cwd: repositoryRoot })
  if (result.exitCode !== 0 || !result.stdout.trim()) return null
  const common = result.stdout.trim()
  return realpath(path.isAbsolute(common) ? common : path.resolve(repositoryRoot, common))
}

/** Immutable commit and stable diagnostic label resolved from a source ref. */
export interface PinnedMergeSource {
  sourceBranch: string
  sourceOid: string
}

/** Result of proving whether a pinned source commit is already integrated. */
export type IntegratedSourceEvidence =
  | { kind: "integrated" }
  | { kind: "not-integrated" }
  | { kind: "conflict" }
  | { kind: "unverifiable"; reason: string }

/** Injectable source pinning function for team_merge tests. */
export type PinMergeSourceFn = (repositoryRoot: string, sourceBranch: string) => Promise<PinnedMergeSource | null>

/** Injectable already-integrated verifier for team_merge tests. */
export type VerifySourceAlreadyIntegratedFn = (
  repositoryRoot: string,
  gitIdentity: string,
  sourceOid: string,
  baselineOid: string | null,
) => Promise<IntegratedSourceEvidence>

/** Resolve a movable branch/ref once to an immutable commit OID. */
export async function pinMergeSource(repositoryRoot: string, sourceBranch: string): Promise<PinnedMergeSource | null> {
  const sourceOid = await gitOid(repositoryRoot, `${sourceBranch}^{commit}`)
  return sourceOid ? { sourceBranch, sourceOid } : null
}

/**
 * Prove that applying a source commit's net tree change to HEAD is a no-op.
 * A temporary index keeps both the Lead worktree and its real index untouched.
 */
export async function verifySourceAlreadyIntegrated(
  repositoryRoot: string,
  gitIdentity: string,
  sourceOid: string,
  baselineOid: string | null,
): Promise<IntegratedSourceEvidence> {
  let currentIdentity: string | null
  try {
    currentIdentity = await repositoryGitIdentity(repositoryRoot)
  } catch {
    currentIdentity = null
  }
  if (!currentIdentity || path.normalize(currentIdentity) !== path.normalize(gitIdentity)) {
    return { kind: "unverifiable", reason: "the Team repository Git identity no longer matches its persisted identity" }
  }

  const pinnedSource = await gitOid(repositoryRoot, `${sourceOid}^{commit}`)
  const headOid = await gitOid(repositoryRoot, "HEAD^{commit}")
  if (pinnedSource !== sourceOid || !headOid) {
    return { kind: "unverifiable", reason: "the source commit or current HEAD cannot be resolved" }
  }
  if (await isAncestor(repositoryRoot, sourceOid, headOid)) return { kind: "integrated" }

  let baseOid: string
  if (baselineOid) {
    const baseline = await gitOid(repositoryRoot, `${baselineOid}^{commit}`)
    if (baseline !== baselineOid) return { kind: "unverifiable", reason: "the persisted branch baseline is not a valid commit" }
    if (!(await isAncestor(repositoryRoot, baselineOid, sourceOid)) || !(await isAncestor(repositoryRoot, baselineOid, headOid))) {
      return { kind: "unverifiable", reason: "the source or current HEAD diverged from the persisted branch baseline" }
    }
    baseOid = baselineOid
  } else {
    const mergeBase = await runCommand(["git", "merge-base", sourceOid, headOid], { cwd: repositoryRoot })
    if (mergeBase.exitCode !== 0 || !mergeBase.stdout.trim()) {
      return { kind: "unverifiable", reason: "the legacy source commit has no verifiable merge base with current HEAD" }
    }
    baseOid = mergeBase.stdout.trim()
  }

  const temporary = await mkdtemp(path.join(tmpdir(), "ensemble-merge-proof-"))
  const indexFile = path.join(temporary, "index")
  const env = { GIT_INDEX_FILE: indexFile }
  try {
    const readTree = await runCommand(["git", "read-tree", "-m", baseOid, headOid, sourceOid], {
      cwd: repositoryRoot,
      env,
    })
    let hasConflicts = false
    if (readTree.exitCode !== 0) {
      const conflicts = await runCommand(["git", "ls-files", "-u"], { cwd: repositoryRoot, env })
      if (conflicts.exitCode === 0 && conflicts.stdout.trim()) hasConflicts = true
      else return { kind: "unverifiable", reason: "Git could not apply the source net change in an isolated index" }
    } else {
      const conflicts = await runCommand(["git", "ls-files", "-u"], { cwd: repositoryRoot, env })
      if (conflicts.exitCode !== 0) return { kind: "unverifiable", reason: "Git could not inspect the isolated merge index" }
      hasConflicts = conflicts.stdout.trim().length > 0
    }
    if (hasConflicts) {
      // Continue to the path proof: Git can report a deletion/delete conflict
      // even when both trees already have the same absent entry.
      const paths = await changedPaths(repositoryRoot, baseOid, sourceOid)
      if (paths === null) return { kind: "unverifiable", reason: "Git could not resolve the source net-change paths" }
      for (const filePath of paths) {
        const sourceEntry = await treeEntry(repositoryRoot, sourceOid, filePath)
        const headEntry = await treeEntry(repositoryRoot, headOid, filePath)
        if (sourceEntry === null || headEntry === null) {
          return { kind: "unverifiable", reason: "Git could not resolve a source net-change tree entry" }
        }
        if (sourceEntry !== headEntry) return { kind: "conflict" }
      }
      return { kind: "integrated" }
    }
    const resultTree = await runCommand(["git", "write-tree"], { cwd: repositoryRoot, env })
    const headTree = await gitOid(repositoryRoot, `${headOid}^{tree}`)
    if (!headTree) return { kind: "unverifiable", reason: "Git could not resolve the current HEAD tree" }
    if (resultTree.exitCode === 0 && resultTree.stdout.trim() === headTree) return { kind: "integrated" }

    // A path-wise comparison proves the writer's net content independently
    // of unrelated commits added to HEAD and represents deletions as no entry.
    const paths = await changedPaths(repositoryRoot, baseOid, sourceOid)
    if (paths === null) return { kind: "unverifiable", reason: "Git could not resolve the source net-change paths" }
    for (const filePath of paths) {
      const sourceEntry = await treeEntry(repositoryRoot, sourceOid, filePath)
      const headEntry = await treeEntry(repositoryRoot, headOid, filePath)
      if (sourceEntry === null || headEntry === null) {
        return { kind: "unverifiable", reason: "Git could not resolve a source net-change tree entry" }
      }
      if (sourceEntry !== headEntry) return { kind: "not-integrated" }
    }
    return { kind: "integrated" }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

/**
 * Verify the only evidence that can settle a failed writer whose preserved
 * branch may be missing. This never consults messages or other activity hints.
 */
export async function verifyFailedWriterEvidence(input: FailedWriterEvidenceInput): Promise<FailedWriterEvidence> {
  if (!input.gitIdentity) return { kind: "unverifiable", reason: "the Team has no persisted Git identity" }
  if (!input.sourceBranch && !input.preservedBranch) {
    return { kind: "unverifiable", reason: "the writer has no recorded source or preserved branch" }
  }

  let currentIdentity: string | null
  try {
    currentIdentity = await repositoryGitIdentity(input.repositoryRoot)
  } catch {
    currentIdentity = null
  }
  if (!currentIdentity || path.normalize(currentIdentity) !== path.normalize(input.gitIdentity)) {
    return { kind: "unverifiable", reason: "the Team repository Git identity no longer matches its persisted identity" }
  }

  if (input.baselineOid) {
    const baseline = await gitOid(input.repositoryRoot, `${input.baselineOid}^{commit}`)
    if (baseline !== input.baselineOid) {
      return { kind: "unverifiable", reason: "the persisted branch baseline is not a valid commit in the Team repository" }
    }
  }

  const branchNames = [...new Set([input.preservedBranch, input.sourceBranch].filter((branch): branch is string => Boolean(branch)))]
  const candidates: Array<{ branch: string; oid: string }> = []
  for (const branch of branchNames) {
    const pinned = await pinMergeSource(input.repositoryRoot, `refs/heads/${branch}`)
    if (!pinned) continue
    const oid = pinned.sourceOid
    if (input.baselineOid && !(await isAncestor(input.repositoryRoot, input.baselineOid, oid))) {
      return { kind: "unverifiable", reason: `candidate branch ${branch} does not descend from the persisted baseline` }
    }
    candidates.push({ branch, oid })
  }

  let liveBaseline = false
  if (input.worktreeDir) {
    let worktreeExists = false
    try {
      worktreeExists = (await stat(input.worktreeDir)).isDirectory()
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        return { kind: "unverifiable", reason: "the recorded writer worktree cannot be inspected" }
      }
    }
    if (worktreeExists) {
      let worktreeIdentity: string | null
      try {
        worktreeIdentity = await repositoryGitIdentity(input.worktreeDir)
      } catch {
        worktreeIdentity = null
      }
      if (!worktreeIdentity || path.normalize(worktreeIdentity) !== path.normalize(input.gitIdentity)) {
        return { kind: "unverifiable", reason: "the live writer worktree belongs to a different Git repository" }
      }
      const status = await runCommand(["git", "status", "--porcelain", "--untracked-files=all"], { cwd: input.worktreeDir })
      if (status.exitCode !== 0) return { kind: "unverifiable", reason: "the live writer worktree status cannot be inspected" }
      if (status.stdout.trim()) return { kind: "unverifiable", reason: "the live writer worktree has dirty or untracked changes" }
      const branch = await symbolicBranch(input.worktreeDir)
      if (input.sourceBranch && branch !== input.sourceBranch) {
        return { kind: "unverifiable", reason: "the live writer worktree is not attached to its immutable source branch" }
      }
      const head = await gitOid(input.worktreeDir, "HEAD")
      if (!head || (input.baselineOid && !(await isAncestor(input.repositoryRoot, input.baselineOid, head)))) {
        return { kind: "unverifiable", reason: "the live writer worktree does not descend from the persisted baseline" }
      }
      liveBaseline = input.baselineOid !== null && head === input.baselineOid
    }
  }

  if (candidates.length === 0) {
    return liveBaseline
      ? { kind: "empty", sourceBranch: input.sourceBranch ?? input.preservedBranch ?? "", sourceOid: input.baselineOid ?? "" }
      : { kind: "unverifiable", reason: "no recorded branch ref or live baseline worktree survives" }
  }

  let selected = candidates[0]
  if (!selected) return { kind: "unverifiable", reason: "no recorded branch evidence survives" }
  for (const candidate of candidates.slice(1)) {
    if (candidate.oid === selected.oid || await isAncestor(input.repositoryRoot, candidate.oid, selected.oid)) continue
    if (await isAncestor(input.repositoryRoot, selected.oid, candidate.oid)) {
      selected = candidate
      continue
    }
    return { kind: "unverifiable", reason: "recorded candidate branch tips have diverged" }
  }

  return input.baselineOid && selected.oid === input.baselineOid
    ? { kind: "empty", sourceBranch: selected.branch, sourceOid: selected.oid }
    : { kind: "merge", sourceBranch: selected.branch, sourceOid: selected.oid }
}

/**
 * Raw squash merge of a single branch. No stash/pop — caller handles that.
 * Used by mergeBranch (single) and mergeMultipleBranches (batch).
 */
export async function mergeBranchRaw(branch: string, cwd: string): Promise<MergeResult> {
  const result = await runCommand(["git", "merge", "--squash", branch], { cwd })

  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim()
    log(`merge-helper:merge:conflict branch=${branch} err=${stderr}`)
    await runCommand(["git", "merge", "--abort"], { cwd })
    return { ok: false, error: stderr || `merge exited with code ${result.exitCode}` }
  }

  return { ok: true }
}

/** Unstage all changes so merge results appear as unstaged. */
export async function gitReset(cwd: string): Promise<void> {
  await runCommand(["git", "reset", "HEAD"], { cwd })
}

/**
 * Squash merge a branch into the working directory as unstaged changes.
 * No stashing — existing unstaged changes from previous merges are preserved.
 * If the merge conflicts, the lead resolves it with git.
 */
export async function mergeBranch(branch: string, cwd: string): Promise<MergeResult> {
  const result = await mergeBranchRaw(branch, cwd)
  if (!result.ok) return result
  await gitReset(cwd)
  return { ok: true }
}

/**
 * Detect files that both the lead (local changes) and the agent (branch) modified.
 * Returns the list of overlapping file paths, or empty if safe to merge.
 */
export async function getOverlappingFiles(branch: string, cwd: string): Promise<string[]> {
  const run = async (args: string[]) => {
    const result = await runCommand(["git", ...args], { cwd })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed with exit code ${result.exitCode}`)
    return result.stdout.split("\n").filter(Boolean)
  }
  const agentFiles = new Set(await run(["diff", "--name-only", "HEAD", branch]))
  const localChanged = await run(["diff", "--name-only", "HEAD"])
  const localUntracked = await run(["ls-files", "--others", "--exclude-standard"])
  const localFiles = [...new Set([...localChanged, ...localUntracked])]
  return localFiles.filter(f => agentFiles.has(f))
}

/**
 * Build the preserved branch name for a team member.
 */
export function preservedBranchName(projectName: string, teamName: string, teamId: string, memberName: string): string {
  return `ensemble/preserved/${resourcePart(projectName)}/${teamResourceSegment(teamName, teamId)}/${resourcePart(memberName)}`
}
