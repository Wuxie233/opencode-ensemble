---
name: opencode-ensemble
description: "Use for development work with OpenCode Ensemble after requirements are confirmed: default Team orchestration, maximum useful parallelism, Lead context isolation, task DAGs, worktrees, results, recovery, merge, and verification."
license: MIT
compatibility: "OpenCode with the @hueyexe/opencode-ensemble plugin installed"
metadata:
  author: hueyexe
  version: "1.0.0"
---

# OpenCode Ensemble

Use OpenCode Ensemble as the default coordination system for development work after requirements are confirmed, unless the user explicitly opts out for the current request. The Lead owns requirements, decomposition, shared contracts, integration, verification, and the user-facing result. When material user decisions remain, complete `grill-with-docs` and confirm the requirement contract before `team_create`.

## Dispatch Priorities

Optimize in this order:

- shortest wall-clock critical path through independent work;
- a clean Lead context by delegating broad searches, raw logs, experiments, and detailed evidence;
- correctness through explicit contracts, write isolation, focused verification, and independent review; and
- efficient recovery by replacing failed sessions without replaying completed side effects.

Cost, token use, and teammate count are not optimization constraints. Do not impose a Scout limit or recommend a fixed team size. Every spawn must shorten the critical path, isolate substantial context, own a distinct write boundary, or independently review a named risk. More agents repeating the same search do not qualify. Never create nested teams.

## Team Shape

| Role | Agent | Worktree | Use for |
| --- | --- | ---: | --- |
| Scout | `explore` | `false` | One distinct evidence domain, subsystem, or external source |
| Planner | `plan` | `false` | A genuinely unresolved dependency graph or contract |
| Builder | `build` | `true` | One independent implementation slice |
| Reviewer | `explore` | `false` | One named high-risk boundary after merge |

Use `plan_approval: true` only for risky or costly-to-reverse writer work. Read-only teammates never need worktrees. Every writer keeps the default `worktree: true`; use `worktree: false` only for intentionally read-only work. Writer worktree creation failure cancels the spawn instead of silently sharing the Lead directory. Writers need exclusive path or vertical-slice ownership. Use Planner, QA, and Reviewer roles when they remove a real dependency or observe a named risk; do not make them ceremonial stages.

## Lead Workflow

1. Create one Team for the confirmed request and reuse it across research, implementation, review, verification, and recovery.
2. Build the coordination graph in `team_tasks_add`. One batch may assign local `key` values and use them in `depends_on`, including forward references. Use existing same-Team task IDs for later additions. Add `phase` when the workflow moves to a new phase.
3. Maximize useful concurrency across the ready frontier: pending tasks whose dependencies are complete. Dependency-waiting tasks are normal queued work, not blockers. Independent read-only `worktree: false` spawns may be issued concurrently; create writer worktrees one at a time, while created writers may execute concurrently.
4. Delegate broad searches, raw logs, trial-and-error, and detailed evidence so the Lead receives concise decision-ready summaries.
5. Use `worktree: false` only for read-only teammates. Keep `worktree: true` and exclusive write ownership for every writer.
6. Use `plan_approval: true` for risky implementation work.
7. Wait for messages instead of polling status. Use `team_status` only for a requested snapshot or a concrete stall/recovery check.
8. Ask for structured `progress` and `blocker` messages tied to `task_id`. Claimed tasks report terminal results atomically through `team_tasks_complete`; use one `team_message` result only for unclaimed work. Keep raw evidence in the teammate session; use `team_results` when full detail is consequential.
9. Shut down completed teammates with `team_shutdown`, merge writer branches with `team_merge`, inspect the integrated diff, and run project verification.
10. Use idempotent lifecycle calls freely when recovering from interrupted coordination; repeated completion, shutdown, merge, and cleanup calls should converge.
11. On the sixth distinct consecutive provider retry, expect the plugin to preserve and abort the failed teammate before releasing its in-progress tasks. Start a fresh teammate with `resume_from`; require it to inspect actual state before continuing.
12. Run `team_cleanup` only after integration and verification.

## Load References As Needed

- Need a team shape? Read `references/coordination-patterns.md`.
- Need prompts? Read `references/prompt-recipes.md`.
- Need a pre-spawn, merge, cleanup, or verification gate? Read `references/lead-checklists.md`.
- Something feels off or too chatty? Read `references/anti-patterns.md`.
- Creating or improving this skill? Read `references/eval-scenarios.md`.

## Guardrails

- Do not invent task IDs. `team_tasks_add` generates IDs; use the IDs returned by earlier calls when setting `depends_on` or `claim_task`.
- Within one `team_tasks_add` call, prefer readable batch-local `key` values for a DAG. Dependencies must resolve to a local key or an existing task in the same Team; missing, cross-Team, self, and cyclic dependencies are invalid.
- Keep teammate prompts short. The plugin already injects team role, allowed tools, worktree context, and the required task-result format.
- Do not pass `worktree: false` to a writer. Fix a failed isolated spawn instead of allowing concurrent writes in the Lead directory.
- Do not give teammates vague prompts like "fix the bug" or "work on tests".
- Do not ask teammates to use lead-only tools such as `team_spawn`, `team_shutdown`, `team_merge`, `team_cleanup`, or `team_view`.
- Do not tell teammates to report only in plain text. They must use `team_message`.
- Do not merge a teammate branch without reading its result and inspecting the diff.
- Do not call the work complete until the repository's verification commands pass or you have clearly reported the blocker.
- Do not duplicate an evidence lane or write boundary without a concrete reason. Parallelism requires distinct ownership, not an arbitrary headcount.
- Do not spawn or claim a dependency-waiting task. Wait until it enters the ready frontier.
- Do not call `team_cleanup` until every writer branch has been explicitly merged, reviewed, and verified.
- Do not create a new Team for each workflow phase. Add tasks and teammates to the active Team so its task graph, messages, and Lead Brief remain continuous.

## Minimal Example

```ts
team_create({ name: "checkout-idempotency" })

team_tasks_add({
  tasks: [
    { key: "map-flow", content: "Map checkout webhook flow and risky files", priority: "high", phase: "research" },
    { key: "idempotency", content: "Implement duplicate-webhook idempotency guard", priority: "high", depends_on: ["map-flow"], phase: "implementation" },
    { key: "regression", content: "Add duplicate-webhook regression tests", priority: "high", depends_on: ["idempotency"], phase: "verification" },
    { key: "review", content: "Review merged diff for correctness and missed tests", priority: "medium", depends_on: ["idempotency", "regression"], phase: "review" },
  ],
})
// Record the returned key-to-ID mapping for claim_task and later task batches.

team_spawn({
  name: "scout",
  agent: "explore",
  worktree: false,
  claim_task: "task_abc123",
  prompt: "Trace the checkout webhook flow. Report files, data model, existing tests, risks, and a smallest-safe-change plan. Do not edit files.",
})

team_spawn({
  name: "api-dev",
  agent: "build",
  plan_approval: true,
  claim_task: "task_def456",
  prompt: "Use scout's findings to implement only the idempotency guard. Commit your work and atomically complete the claimed task with its result.",
})
```
