import type { ToolDeps } from "../types"
import { requireLead } from "./shared"
import { mergeBranch, deleteBranch, getOverlappingFiles } from "./merge-helper"
import type { MergeBranchFn, DeleteBranchFn, OverlapCheckFn } from "./merge-helper"
import { log } from "../log"
import { immediateTransaction } from "../db"
import { appendTeamEvent } from "../team-event"

/**
 * Execute the team_merge tool. Merges a shutdown teammate's preserved
 * branch into the working directory as unstaged changes.
 */
export async function executeTeamMerge(
  deps: ToolDeps,
  args: { member: string },
  sessionId: string,
  merge: MergeBranchFn = mergeBranch,
  delBranch: DeleteBranchFn = deleteBranch,
  overlapCheck: OverlapCheckFn = getOverlappingFiles,
): Promise<string> {
  const teamInfo = requireLead(deps, sessionId)

  const member = deps.db.query("SELECT status, worktree_branch, merge_state, merged_source_branch FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamInfo.teamId, args.member) as { status: string; worktree_branch: string | null; merge_state: string; merged_source_branch: string | null } | null
  if (!member) throw new Error(`Teammate "${args.member}" not found in team "${teamInfo.teamName}"`)

  if (member.status !== "shutdown" && member.status !== "error") {
    throw new Error(`Teammate "${args.member}" is still active (status: ${member.status}). Shut them down first with team_shutdown.`)
  }

  if (!member.worktree_branch) {
    return `No branch to merge for "${args.member}". Their work was already integrated or this was a read-only teammate.`
  }

  if (member.merge_state === "merged") {
    const deleted = await delBranch(member.worktree_branch, deps.directory)
    if (deleted) {
      deps.db.run("UPDATE team_member SET worktree_branch = NULL WHERE team_id = ? AND name = ?", [teamInfo.teamId, args.member])
    }
    return `Teammate "${args.member}" was already merged. ${deleted ? "The remaining branch reference was cleaned up." : "The branch remains for manual cleanup."}`
  }
  if (member.merge_state === "merging") {
    return `Merge for "${args.member}" was already started. Inspect git diff and the branch before retrying; Ensemble will not reapply it automatically.`
  }

  const branch = member.worktree_branch
  let startedEventId: string | undefined
  const claimed = immediateTransaction(deps.db, () => {
    const result = deps.db.run(
      "UPDATE team_member SET merge_state = 'merging', merged_source_branch = ? WHERE team_id = ? AND name = ? AND merge_state = 'none'",
      [branch, teamInfo.teamId, args.member],
    )
    if (result.changes !== 1) return false
    startedEventId = appendTeamEvent(deps.db, {
      teamId: teamInfo.teamId,
      kind: "merge.started",
      payload: { member_name: args.member },
    })
    return true
  })
  if (!claimed) return `Merge for "${args.member}" is already being handled.`
  log(`merge:start member=${args.member} branch=${branch}`)

  // Block merge if lead has local changes to files the agent also modified
  try {
    const overlap = await overlapCheck(branch, deps.directory)
    if (overlap.length > 0) {
      recordMergeFailure(deps, teamInfo.teamId, args.member, startedEventId)
      const files = overlap.map(f => `  - ${f}`).join("\n")
      return [
        `Cannot merge ${args.member} — you have local changes to the same files:`,
        files,
        ``,
        `Commit or stash your changes first, then retry team_merge.`,
        `Branch preserved: ${branch}`,
      ].join("\n")
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    recordMergeFailure(deps, teamInfo.teamId, args.member, startedEventId)
    log(`merge:overlap-check:failed member=${args.member} branch=${branch} err=${detail}`)
    return `Cannot verify merge safety for ${args.member}: ${detail}. The branch remains preserved; fix the overlap check and retry team_merge.`
  }

  const result = await merge(branch, deps.directory)
  if (!result.ok) {
    recordMergeFailure(deps, teamInfo.teamId, args.member, startedEventId)
    return [
      `Merge conflict merging ${args.member}'s branch (${branch}).`,
      `Resolve manually:`,
      `  git merge --squash ${branch}`,
      `  git reset HEAD`,
      ``,
      `Error: ${result.error}`,
    ].join("\n")
  }

  // Record integration before branch deletion so a retry cannot reapply the squash.
  immediateTransaction(deps.db, () => {
    const merged = deps.db.run(
      "UPDATE team_member SET merge_state = 'merged' WHERE team_id = ? AND name = ? AND merge_state = 'merging'",
      [teamInfo.teamId, args.member],
    )
    if (merged.changes !== 1) throw new Error(`Merge state for "${args.member}" changed before completion could be recorded.`)
    appendTeamEvent(deps.db, {
      teamId: teamInfo.teamId,
      kind: "merge.completed",
      payload: { member_name: args.member },
      causeEventId: startedEventId,
    })
  })
  const deleted = await delBranch(branch, deps.directory)
  if (deleted) {
    deps.db.run("UPDATE team_member SET worktree_branch = NULL WHERE team_id = ? AND name = ?", [teamInfo.teamId, args.member])
  }

  log(`merge:done member=${args.member} branch=${branch}`)
  return `Merged ${args.member}'s changes into your working directory (unstaged).${deleted ? "" : ` Branch cleanup failed; ${branch} remains recorded but will not be merged twice.`} Review with: git diff`
}

function recordMergeFailure(deps: ToolDeps, teamId: string, memberName: string, causeEventId?: string): void {
  immediateTransaction(deps.db, () => {
    const reset = deps.db.run(
      "UPDATE team_member SET merge_state = 'none' WHERE team_id = ? AND name = ? AND merge_state = 'merging'",
      [teamId, memberName],
    )
    if (reset.changes !== 1) return
    appendTeamEvent(deps.db, {
      teamId,
      kind: "merge.failed",
      payload: { member_name: memberName },
      causeEventId,
    })
  })
}
