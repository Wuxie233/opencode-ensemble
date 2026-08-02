# Lead Checklists

Use these gates to prevent common coordination failures.

## Pre-Spawn Checklist

- The user goal is one sentence.
- A Team will be used unless the user explicitly opted out for this request.
- Each teammate has one clear owner area.
- Every Scout has a distinct evidence domain; there is no fixed Scout limit.
- No two builders are expected to edit the same files.
- Read-only work uses `scout`, `planner`, or `reviewer` profiles and `worktree: false`.
- Every writer uses `worktree: true`; a writer never falls back to the Lead directory after worktree creation failure.
- Risky implementation work uses `plan_approval: true`.
- Task dependencies are represented with `depends_on`.
- Every shared execution contract is published as an immutable Team artifact and bound by exact ID, or committed to Git before an isolated writer is spawned.
- No task relies on an uncommitted file that exists only in the Lead worktree.
- Batch-local task `key` values are unique; all dependencies resolve within the current Team and form an acyclic graph.
- Research, implementation, review, verification, and recovery will reuse the same Team.
- Verification commands are known before work starts.

## Spawning Checklist

- Call `team_create` before `team_spawn`.
- Add shared tasks with `team_tasks_add` before assigning task IDs.
- Spawn teammates one at a time and wait for each tool result.
- Treat writer worktree creation failure as a blocked spawn. Do not retry it with `worktree: false` unless the task is reclassified as strictly read-only.
- Keep teammate prompts focused and under one clear responsibility.
- Tell teammates what to report, not just what to do.
- Delegate raw logs, broad searches, and experiments; ask the teammate to send concise structured milestone summaries.
- Do not describe lead-only tools in teammate prompts.

## While Running Checklist

- Wait for `team_message` updates instead of polling `team_status` repeatedly.
- Use `team_status` only for a requested snapshot or a concrete stall/recovery check.
- Use `team_results` for full content when a message is truncated or consequential.
- Expect messages to declare `progress`, `result`, or `blocker` and include `task_id` when applicable.
- Forward relevant findings between teammates when it changes their work.
- Reject unclear plans instead of approving them under time pressure.
- Stop and ask the user if teammate outputs conflict with each other or with the user's goal.

## Merge Checklist

- Read the teammate's task result.
- Shut down the teammate with `team_shutdown`.
- If shutdown warns about uncommitted changes, resolve that before merging.
- Merge with `team_merge`, not manual git commands.
- Inspect `git diff` after each merge.
- If two branches overlap in surprising files, review before merging the next branch.
- Treat repeated shutdown and merge calls as convergence checks; investigate only when the result is not an idempotent no-op.

## Retry Recovery Checklist

- Attempts one through five remain silent and keep task ownership unchanged.
- The sixth distinct consecutive retry must preserve the branch and complete abort before task release.
- Preservation or abort failure leaves the member and task owned; do not start a competing replacement.
- After successful termination, spawn a fresh session with `resume_from` and the released task.
- The replacement inspects actual state before continuing and does not replay predecessor side effects.

## Cleanup Checklist

- All active teammates are complete, shut down, or intentionally force-stopped.
- Every writer branch has been explicitly merged and its integration reviewed; cleanup must not archive a deliberately omitted writer branch.
- Verification commands have passed or blockers are clearly reported.
- `team_cleanup` has run after review and verification.
- Repeated cleanup converges without duplicate merge effects.
- Final user summary includes what changed, tests run, and any residual risks.

## Verification Checklist

Use the repository's own commands. For opencode-ensemble itself, run:

```bash
bun run typecheck && bun test && bun run build
```

If a command fails, report the failure with the command and error summary. Do not claim the team completed successfully.
