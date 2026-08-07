import type { ToolDeps } from "../types"
import { requireLead } from "./shared"
import {
  mergeBranch,
  deleteBranch,
  getOverlappingFiles,
  pinMergeSource,
  verifyFailedWriterEvidence,
  verifySourceAlreadyIntegrated,
} from "./merge-helper"
import type {
  MergeBranchFn,
  DeleteBranchFn,
  OverlapCheckFn,
  PinMergeSourceFn,
  VerifyFailedWriterEvidenceFn,
  VerifySourceAlreadyIntegratedFn,
} from "./merge-helper"
import { log } from "../log"
import { immediateTransaction } from "../db"
import { appendTeamEvent } from "../team-event"
import type { MergeDisposition } from "../team-event"
import { recoverMemberRepositoryBinding, repositoryBindingOps } from "../repository-binding"

/**
 * Execute the team_merge tool. Merges a shutdown teammate's preserved
 * branch into the working directory as unstaged changes.
 */
export async function executeTeamMerge(
  deps: ToolDeps,
  args: { member: string; disposition?: "superseded" | "evidence_missing"; evidence?: string; baseline_oid?: string },
  sessionId: string,
  merge: MergeBranchFn = mergeBranch,
  delBranch: DeleteBranchFn = deleteBranch,
  overlapCheck: OverlapCheckFn = getOverlappingFiles,
  verifyFailedWriter: VerifyFailedWriterEvidenceFn = verifyFailedWriterEvidence,
  pinSource: PinMergeSourceFn = deps.mergeEvidenceOps?.pinSource ?? pinMergeSource,
  verifyIntegrated: VerifySourceAlreadyIntegratedFn = deps.mergeEvidenceOps?.verifyIntegrated ?? verifySourceAlreadyIntegrated,
): Promise<string> {
  const teamInfo = requireLead(deps, sessionId)
  const member = deps.db.query(
    `SELECT status, worktree_dir, worktree_branch, worktree_source_branch,
            worktree_baseline_oid, merge_state, merged_source_branch, merged_source_oid,
            merge_disposition, merge_disposition_evidence
     FROM team_member WHERE team_id = ? AND name = ?`,
  ).get(teamInfo.teamId, args.member) as {
    status: string
    worktree_dir: string | null
    worktree_branch: string | null
    worktree_source_branch: string | null
    worktree_baseline_oid: string | null
    merge_state: string
    merged_source_branch: string | null
    merged_source_oid: string | null
    merge_disposition: MergeDisposition
    merge_disposition_evidence: string | null
  } | null
  if (!member) throw new Error(`Teammate "${args.member}" not found in team "${teamInfo.teamName}"`)

  if (member.status !== "shutdown" && member.status !== "error") {
    throw new Error(`Teammate "${args.member}" is still active (status: ${member.status}). Shut them down first with team_shutdown.`)
  }

  if (args.disposition) {
    const disposition = args.disposition
    const evidence = args.evidence?.trim()
    if (!evidence) throw new Error(`A written evidence rationale is required when settling "${args.member}" as ${args.disposition}.`)
    if (member.merge_state === "merging") {
      return `Merge for "${args.member}" was already started. Inspect git diff before recording a terminal disposition.`
    }
    if (member.merge_state === "merged") {
      return `Teammate "${args.member}" already has a verified merge settlement; no alternate disposition was recorded.`
    }
    if (args.disposition === "evidence_missing" && member.status !== "error") {
      throw new Error(`Evidence-missing settlement is only valid for an error teammate; "${args.member}" has status ${member.status}.`)
    }
    if (member.merge_disposition !== "none") {
      return `Teammate "${args.member}" already has terminal disposition ${member.merge_disposition}. No changes were made.`
    }
    immediateTransaction(deps.db, () => {
      deps.db.run(
        "UPDATE team_member SET merge_disposition = ?, merge_disposition_evidence = ?, time_updated = ? WHERE team_id = ? AND name = ? AND merge_state = 'none' AND merge_disposition = 'none'",
        [disposition, evidence, Date.now(), teamInfo.teamId, args.member],
      )
      appendTeamEvent(deps.db, {
        teamId: teamInfo.teamId,
        kind: "merge.disposed",
        payload: { member_name: args.member, disposition, evidence },
      })
    })
    return `Recorded terminal disposition ${disposition} for "${args.member}". No Git integration was claimed; the branch remains preserved for audit and cleanup.`
  }

  const failedWriter = member.status === "error" && (
    member.worktree_branch !== null || member.worktree_source_branch !== null || member.worktree_baseline_oid !== null
  )
  if (!member.worktree_branch && !failedWriter) {
    return `No branch to merge for "${args.member}". Their work was already integrated or this was a read-only teammate.`
  }

  const binding = await recoverMemberRepositoryBinding(
    deps.db,
    teamInfo.teamId,
    args.member,
    deps.repositoryBindingOps ?? repositoryBindingOps,
  )
  const repositoryRoot = binding.repositoryRoot

  if (member.merge_state === "merged") {
    if (!member.worktree_branch) return `Teammate "${args.member}" was already merged.`
    if (!member.merged_source_oid) {
      return `Teammate "${args.member}" was already merged. This legacy record has no pinned source OID, so its remaining branch stays for manual cleanup.`
    }
    const deleted = await delBranch(member.worktree_branch, repositoryRoot, member.merged_source_oid)
    if (deleted) {
      deps.db.run("UPDATE team_member SET worktree_branch = NULL WHERE team_id = ? AND name = ?", [teamInfo.teamId, args.member])
    }
    return `Teammate "${args.member}" was already merged. ${deleted ? "The unchanged remaining branch reference was cleaned up." : "The branch tip changed and remains recorded for manual cleanup."}`
  }
  if (member.merge_state === "merging") {
    return `Merge for "${args.member}" was already started. Inspect git diff and the branch before retrying; Ensemble will not reapply it automatically.`
  }

  let branch = member.worktree_branch
  let sourceOid: string | null = null
  let verifiedEmpty = false
  const requestedBaseline = args.baseline_oid ?? member.worktree_baseline_oid
  if (failedWriter) {
    const evidence = await verifyFailedWriter({
      repositoryRoot,
      gitIdentity: binding.gitIdentity,
      baselineOid: requestedBaseline,
      sourceBranch: member.worktree_source_branch,
      preservedBranch: member.worktree_branch,
      worktreeDir: member.worktree_dir,
    })
    if (evidence.kind === "unverifiable") {
      return `Cannot verify merge safety for ${args.member}: ${evidence.reason}. No merge state was recorded; recover the branch or worktree evidence and retry team_merge.`
    }
    branch = evidence.sourceBranch
    sourceOid = evidence.sourceOid
    verifiedEmpty = evidence.kind === "empty"
  }
  if (!branch) {
    return `Cannot verify merge safety for ${args.member}: no immutable source branch is available. No merge state was recorded.`
  }
  if (!sourceOid) {
    const pinned = await pinSource(repositoryRoot, branch)
    if (!pinned) {
      return `Cannot verify merge safety for ${args.member}: the recorded source branch is not a valid commit. No merge state was recorded.`
    }
    sourceOid = pinned.sourceOid
  }

  const gitIdentity = binding.gitIdentity
  if (!gitIdentity) {
    return `Cannot verify merge safety for ${args.member}: the Team has no recoverable Git identity. No merge state was recorded.`
  }
  const integrated = await verifyIntegrated(
    repositoryRoot,
    gitIdentity,
    sourceOid,
    requestedBaseline,
  )
  if (integrated.kind === "unverifiable") {
    return `Cannot verify merge safety for ${args.member}: ${integrated.reason}. No merge state was recorded.`
  }
  const alreadyIntegrated = integrated.kind === "integrated"
  const immutableSourceOid = sourceOid
  let startedEventId: string | undefined
  const claimed = immediateTransaction(deps.db, () => {
    const result = deps.db.run(
      `UPDATE team_member SET merge_state = 'merging', merged_source_branch = ?,
              worktree_baseline_oid = COALESCE(?, worktree_baseline_oid)
       WHERE team_id = ? AND name = ? AND merge_state = 'none'`,
      [branch, args.baseline_oid ?? null, teamInfo.teamId, args.member],
    )
    if (result.changes !== 1) return false
    startedEventId = appendTeamEvent(deps.db, {
      teamId: teamInfo.teamId,
      kind: "merge.started",
      payload: { member_name: args.member },
    })
    if (args.baseline_oid && args.baseline_oid !== member.worktree_baseline_oid) {
      appendTeamEvent(deps.db, {
        teamId: teamInfo.teamId,
        kind: "merge.baseline_rebound",
        payload: { member_name: args.member, baseline_oid: args.baseline_oid },
        causeEventId: startedEventId,
      })
    }
    return true
  })
  if (!claimed) return `Merge for "${args.member}" is already being handled.`
  log(`merge:start member=${args.member} branch=${branch}`)

  if (verifiedEmpty || alreadyIntegrated) {
    recordMergeCompletion(deps, teamInfo.teamId, args.member, branch, immutableSourceOid, verifiedEmpty ? "verified_empty" : "already_integrated", startedEventId)
    const recordedBranch = member.worktree_branch
    const deleted = recordedBranch ? await delBranch(recordedBranch, repositoryRoot, immutableSourceOid) : false
    if (deleted) {
      deps.db.run("UPDATE team_member SET worktree_branch = NULL WHERE team_id = ? AND name = ?", [teamInfo.teamId, args.member])
    }
    log(`merge:${verifiedEmpty ? "verified-empty" : "already-integrated"} member=${args.member} source=${branch} oid=${immutableSourceOid}`)
    const outcome = verifiedEmpty
      ? `Verified ${args.member}'s failed writer branch is empty at its persisted baseline.`
      : `Verified ${args.member}'s source commit is already integrated into current HEAD.`
    return `${outcome} No changes were applied.${recordedBranch && !deleted ? ` Branch cleanup failed; ${recordedBranch} remains recorded but will not be merged.` : ""}`
  }

  // Block merge if lead has local changes to files the agent also modified
  try {
    const overlap = await overlapCheck(immutableSourceOid, repositoryRoot)
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

  const result = await merge(immutableSourceOid, repositoryRoot)
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
  recordMergeCompletion(deps, teamInfo.teamId, args.member, branch, immutableSourceOid, "merged", startedEventId)
  const recordedBranch = member.worktree_branch
  const deleted = recordedBranch ? await delBranch(recordedBranch, repositoryRoot, immutableSourceOid) : false
  if (deleted) {
    deps.db.run("UPDATE team_member SET worktree_branch = NULL WHERE team_id = ? AND name = ?", [teamInfo.teamId, args.member])
  }

  log(`merge:done member=${args.member} branch=${branch}`)
  return `Merged ${args.member}'s changes into your working directory (unstaged).${deleted ? "" : ` Branch cleanup failed; ${branch} remains recorded but will not be merged twice.`} Review with: git diff`
}

function recordMergeCompletion(
  deps: ToolDeps,
  teamId: string,
  memberName: string,
  sourceBranch: string,
  sourceOid: string,
  disposition: "merged" | "verified_empty" | "already_integrated",
  causeEventId?: string,
): void {
  immediateTransaction(deps.db, () => {
    const merged = deps.db.run(
      `UPDATE team_member SET merge_state = 'merged', merged_source_branch = ?, merged_source_oid = ?, merge_disposition = ?
       WHERE team_id = ? AND name = ? AND merge_state = 'merging'`,
      [sourceBranch, sourceOid, disposition, teamId, memberName],
    )
    if (merged.changes !== 1) throw new Error(`Merge state for "${memberName}" changed before completion could be recorded.`)
    appendTeamEvent(deps.db, {
      teamId,
      kind: "merge.completed",
      payload: { member_name: memberName },
      causeEventId,
    })
  })
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
