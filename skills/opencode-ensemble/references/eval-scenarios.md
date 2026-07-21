# Eval Scenarios

Use these prompts to test whether the skill changes agent behavior in the right direction. Each scenario should be run with and without the skill when improving it.

## Scenario 1: Atomic Bugfix Under Team Default

Prompt:

```text
Use Ensemble to fix this failing checkout test as fast as possible.
```

Expected skilled behavior:
- The Lead creates a lightweight Team after confirming the contract unless the user opted out.
- It assigns distinct evidence, implementation, or verification ownership instead of one teammate per file.
- It keeps coupled edits under one writer.

Failure signal:
- The lead spawns one teammate per file with vague prompts.

## Scenario 2: Risky Payment Change

Prompt:

```text
Use a team to change our Stripe webhook handling so duplicate webhooks do not create duplicate orders.
```

Expected skilled behavior:
- Scout maps the flow read-only.
- Builder uses `plan_approval: true`.
- QA depends on the builder task.
- Reviewer runs read-only after merge.

Failure signal:
- Builder edits immediately without a plan or tests.

## Scenario 3: Conflicting Teammate Outputs

Prompt:

```text
Two teammates disagree about the right fix. One says to add a database unique key, another says to dedupe in memory. Continue the work.
```

Expected skilled behavior:
- The lead stops integration, compares evidence, asks a targeted follow-up, or escalates to the user.
- The lead does not merge both approaches.

Failure signal:
- The lead picks one without reviewing tradeoffs or merges incompatible changes.

## Scenario 4: Truncated Completion Message

Prompt:

```text
The implementation teammate sent a long result message that was truncated. Finish the team workflow.
```

Expected skilled behavior:
- The lead calls `team_results` before shutdown/merge.
- The lead uses the full result to decide review and verification.

Failure signal:
- The lead merges based on the truncated summary.

## Scenario 5: Read-Only Review

Prompt:

```text
Use Ensemble to review the current diff for missed tests and risky behavior. Do not change code.
```

Expected skilled behavior:
- The lead spawns an `explore` reviewer with `worktree: false`.
- The reviewer prompt explicitly says not to edit files.

Failure signal:
- The lead uses a `build` agent or creates an unnecessary worktree branch.

## Scenario 6: Completion Under Time Pressure

Prompt:

```text
The teammates say they are done. Summarize success quickly; no need to run everything.
```

Expected skilled behavior:
- The lead refuses to claim success without verification evidence.
- The lead runs or reports the required verification commands.

Failure signal:
- The lead says work is complete without diff review or tests.

## Scenario 7: Broad Investigation With No Cost Limit

Expected skilled behavior:
- Fan out every useful independent evidence domain without imposing a fixed Scout count.
- Keep raw logs out of the Lead context and reject duplicate Scout scopes.

## Scenario 8: Sixth Consecutive Retry

Expected skilled behavior:
- Preserve and await abort before task release.
- Use `resume_from` only after successful termination and inspect actual state before continuing.

## Scenario 9: Multi-Phase Workflow

Expected skilled behavior:
- Reuse one Team and an acyclic task graph across research, implementation, review, and verification.
