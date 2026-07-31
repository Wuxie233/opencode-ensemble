import { resolveWorktreeBranch } from "./tools/merge-helper"
import type { ResolveWorktreeBranchFn } from "./tools/merge-helper"

export type AbortBranchResolution =
  | { ok: true; sourceBranch: string | null }
  | { ok: false; reason: string }

/** Resolve the live writer branch that must be preserved before an abort. */
export async function resolveAbortBranch(
  worktreeBranch: string | null,
  worktreeDir: string | null,
  resolveBranch: ResolveWorktreeBranchFn = resolveWorktreeBranch,
): Promise<AbortBranchResolution> {
  if (worktreeBranch && !worktreeBranch.startsWith("ensemble/preserved/")) {
    return { ok: true, sourceBranch: worktreeBranch }
  }

  if (worktreeDir) {
    let liveBranch: string | null
    try {
      liveBranch = await resolveBranch(worktreeDir)
    } catch {
      return { ok: false, reason: `the live source branch could not be resolved from worktree ${worktreeDir}` }
    }
    if (liveBranch && !liveBranch.startsWith("ensemble/preserved/")) {
      return { ok: true, sourceBranch: liveBranch }
    }
    return { ok: false, reason: `the live source branch could not be resolved from worktree ${worktreeDir}` }
  }

  if (worktreeBranch?.startsWith("ensemble/preserved/")) {
    return { ok: false, reason: `preserved branch ${worktreeBranch} has no live worktree metadata to refresh` }
  }

  return { ok: true, sourceBranch: null }
}
