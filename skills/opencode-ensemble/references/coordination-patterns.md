# Coordination Patterns

Use these patterns as defaults. Adapt names and prompts to the project, but keep ownership narrow and outputs verifiable.

## Pattern: Evidence Fan-Out, Builder, Reviewer

Best for unfamiliar code or risky changes.

Team:
- `scout-*`: any number of `explore`, `worktree: false` teammates, each assigned a distinct subsystem, evidence source, runtime question, or risk.
- `builder`: `build`, `worktree: true`, implements one narrow change.
- `reviewer`: `explore`, `worktree: false`, reviews the merged diff and test evidence.

Why it works:
- Evidence fan-out keeps searches, raw logs, and experiments out of the Lead context while reducing blind implementation.
- The builder has a focused edit surface.
- The reviewer checks the integrated result instead of creating another branch.

Use `plan_approval: true` on the builder when the change touches payment, auth, data deletion, migrations, concurrency, or security boundaries.

## Pattern: Parallel Independent Slices

Best when multiple vertical slices do not overlap.

Team:
- `api-dev`: `build`, owns backend endpoint or service change.
- `ui-dev`: `build`, owns frontend state or component change.
- `qa`: `build`, owns tests after one or both implementation tasks complete.

Task setup:
- Add implementation tasks first.
- Add QA task with `depends_on` pointing to the implementation task IDs.
- If both builders may touch shared contracts, add a scout task first to define boundaries.

Avoid this pattern when two builders would edit the same files or would need constant synchronization.

## Pattern: Research Fan-Out

Best for comparing options before implementation.

Team:
- Any number of `explore` teammates justified by distinct evidence domains.
- All use `worktree: false`.
- Each investigates a different option, subsystem, or risk.

Lead responsibility:
- Give each researcher an explicit question.
- Ask for a recommendation with tradeoffs and evidence.
- Ask for concise milestone summaries; leave raw logs and full evidence in the teammate session.
- Do not merge anything because no branches should be produced.

## Pattern: One Team, Multiple Phases

Best for work that moves from research to implementation, review, verification, or recovery.

Task setup:
- Create the Team once.
- Add a batch DAG with local `key` values when dependencies are known together.
- Use `phase` to record the current workflow phase.
- Add later tasks with existing same-Team IDs rather than creating another Team.
- Preserve continuity through structured `progress`, `result`, and `blocker` messages and the Lead Brief.

## Pattern: Failed Teammate Replacement

Lead flow:
1. Confirm the failed session has stopped and its task is pending before assigning a replacement.
2. Spawn a new teammate with `resume_from: "<failed-member>"` and the pending `claim_task`.
3. Tell the replacement to inspect repository, task, and runtime state before acting.
4. Do not replay commands or tool side effects merely because they appear in predecessor context.

## Pattern: QA After Implementation

Best when tests should reflect actual implementation details.

Task setup:
- Builder task: implement and commit the narrow change.
- QA task: `depends_on` the builder's local key or task ID.
- Reviewer task: `depends_on` the builder and QA keys or IDs.

Prompt QA to verify behavior from the public API or user flow, not to simply mirror implementation internals.

## Pattern: Hotfix With Plan Approval

Best for production-risk changes.

Team:
- `scout`: quick read-only impact map.
- `fixer`: `build`, `plan_approval: true`.
- `reviewer`: read-only final review.

Lead flow:
1. Spawn scout first.
2. Use scout findings to constrain fixer's prompt.
3. Approve or reject the fixer's plan through `team_message`.
4. Merge only after reading the task result and inspecting the diff.
5. Run targeted verification before cleanup.
