<p align="center">
  <img src="social-preview.png" alt="OpenCode Ensemble - Parallel agents. One coordinated team." width="100%">
</p>

# OpenCode Ensemble

[![tests](https://img.shields.io/badge/tests-964%20passing-brightgreen.svg)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)]()
[![OpenCode SDK](https://img.shields.io/badge/deps-OpenCode%20SDK%20only-blue.svg)]()
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

This repository is the independently maintained fork at [Wuxie233/opencode-ensemble](https://github.com/Wuxie233/opencode-ensemble). It started from [`hueyexe/opencode-ensemble`](https://github.com/hueyexe/opencode-ensemble) and is no longer kept mergeable with upstream.

The original product runs parallel agents in OpenCode. Each agent gets its own session, context window, and task. They coordinate through messaging and a shared task board. Plugin built on the public OpenCode SDK, with no internal dependencies.

The bet in this fork is narrower: raw parallelism is not enough. Agents that work at the same time still need a coordination protocol — addressable peers, isolated writers, recoverable lifecycle, and state a human can inspect after a crash. Workflow conventions sit on top of that runtime; they are not the runtime. The lead owns integration and the final result. Writers stay in their own worktrees. Reviewers stay read-only. A teammate that dies mid-task should leave a branch and a structured result, not a hole in the working tree.

## Quick Start

This fork is loaded from a local build, not from the upstream npm package:

```json
{
  "plugin": ["/absolute/path/to/opencode-ensemble/dist/index.js"]
}
```

Build with `bun run build`, restart OpenCode, and ask it to do something that benefits from parallel work. See [Install](#install) for worktree permissions and runtime requirements.

The original package name `@hueyexe/opencode-ensemble` still appears in some docs as historical context. New installs of this fork should not point at that npm spec.

## What actually happens

You ask the agent to do something complex. It creates a team, spawns teammates, and they work in parallel. Each teammate runs in its own OpenCode session with a fresh context window.

A realistic development-team interaction:

```
You: "Fix checkout idempotency so duplicate Stripe webhooks cannot create
duplicate orders. Add regression tests and review the final diff for risk."

The lead agent:
1. Creates a team called "checkout-idempotency".
2. Adds one task DAG with batch-local keys, real dependencies, and workflow phases.
3. Records the returned key-to-ID mapping for assignment and later task batches.
4. Spawns teammates with broad capability profiles and distinct evidence or delivery ownership:
   - scout: read-only reconnaissance, worktree disabled, model openai/gpt-5.3-codex-spark
   - api-dev: backend writer, own worktree, model anthropic/claude-opus-4-7, plan_approval: true
   - qa: test writer, own worktree, model anthropic/claude-sonnet-4-6
   - reviewer: read-only risk review, worktree disabled, model openai/gpt-5.3-codex-spark
```

The lead uses the task board to make sequencing visible. A single batch can use local keys, including forward references:

```ts
team_tasks_add({
  tasks: [
    { key: "map-flow", content: "Map checkout webhook flow and identify idempotency risks", priority: "high", phase: "research" },
    { key: "implement", content: "Implement duplicate-webhook idempotency guard", priority: "high", depends_on: ["map-flow"], phase: "implementation" },
    { key: "regression", content: "Add regression tests for duplicate webhook delivery", priority: "high", depends_on: ["implement"], phase: "verification" },
    { key: "review", content: "Review final diff for order, payment, and retry risks", priority: "medium", depends_on: ["implement", "regression"], phase: "review" },
  ],
})
// -> Added 4 tasks: map-flow=task_abc123, implement=task_def456,
//    regression=task_ghi789, review=task_jkl012
```

It spawns only the ready frontier. Independent read-only teammates can be created concurrently; writer worktree creation remains serialized. After `map-flow` completes and unlocks `implement`, the lead starts the writer:

```ts
team_spawn({
  name: "scout",
  profile: "scout",
  worktree: false,
  model: "openai/gpt-5.3-codex-spark",
  claim_task: "task_abc123",
  prompt: "Trace the checkout webhook flow. Report the files, data model, existing tests, and the smallest safe implementation plan. Do not edit files.",
})

team_spawn({
  name: "api-dev",
  profile: "backend",
  model: "anthropic/claude-opus-4-7",
  plan_approval: true,
  claim_task: "task_def456",
  prompt: "After scout reports, implement the idempotency guard. Keep the change narrow, commit it, and atomically complete the claimed task with its result.",
})
```

The same Team continues through implementation, verification, review, and recovery. A completed Scout task result is injected into dependent teammate prompts, so evidence crosses the dependency edge without copying raw session history. The reviewer stays read-only (`worktree: false`) so it can inspect merged changes without producing another branch.

## Capability profiles

`team_spawn` accepts a broad `profile` and maps it to OpenCode's existing runtime agents. Profiles describe ownership and access; they do not add a second scheduler or restrict how many specialists a Team can create.

| Profile | Runtime agent | Access | Intended boundary |
|---------|---------------|--------|-------------------|
| `general` | `build` | write | Bounded work when no narrower profile fits |
| `scout` | `explore` | read | Code and evidence reconnaissance |
| `researcher` | `build` | write | Durable research at an explicitly owned documentation path |
| `planner` | `plan` | read | Dependency planning and technical contract consultation |
| `frontend` | `build` | write | Frontend implementation and browser-facing contracts |
| `backend` | `build` | write | Backend implementation and service contracts |
| `platform` | `build` | write | Build, runtime, and platform integration without deployment activation |
| `qa` | `build` | write | Test implementation and system verification |
| `reviewer` | `explore` | read | Named-risk review of an integrated delivery |

Omitting both `profile` and the legacy `agent` selects `general`. Legacy `agent: "explore"` and `agent: "plan"` infer `scout` and `planner`; an explicit agent must match its profile. Unknown profiles, malformed models, writer `worktree: false`, and nested writer worktrees fail before task claim, session creation, or worktree creation. Read-only profiles never create worktrees; every writer uses an isolated worktree.

A teammate that owns an in-progress task can call `team_consult` when a technical contract blocks only that boundary. An active `planner` replies with `team_consult_reply`; it may escalate a business decision to the Lead while the requester remains waiting, then close the same consultation after the Lead decides. Unrelated ready tasks continue throughout.

Teammates coordinate without the lead polling. Structured `progress` and `blocker` messages feed a bounded Lead Brief. A claimed task's terminal `result` is persisted atomically with completion through `team_tasks_complete`; raw logs stay in teammate sessions unless the lead retrieves them with `team_results`:

```xml
<task-result>
<kind>progress</kind>
<task_id>task_abc123</task_id>
<status>in_progress</status>
<summary>Mapped the checkout flow and found a pre-insert retry race</summary>
<details>src/webhooks/stripe.ts calls createOrderFromPayment(); coverage is in test/checkout-webhook.test.ts.</details>
</task-result>

<task-result>
<kind>result</kind>
<task_id>task_def456</task_id>
<status>completed</status>
<summary>Added event-id idempotency inside the order transaction</summary>
<details>Duplicate event inserts now return success without creating another order.</details>
</task-result>
```

When work is done, the lead reviews and integrates deliberately:

```
team_results({ from: "api-dev" })
team_shutdown({ member: "api-dev" })
team_merge({ member: "api-dev" })

team_results({ from: "qa" })
team_shutdown({ member: "qa" })
team_merge({ member: "qa" })

team_spawn({ name: "reviewer", profile: "reviewer", worktree: false, claim_task: "task_jkl012", prompt: "Review the merged diff for correctness, missed tests, and risky behavior. Do not edit files." })
```

The lead runs the repository verification commands, summarizes the result, and only then cleans up the team. All merged teammate changes remain in your working directory as unstaged changes for review with `git diff`.

## Agent Skill

Install the companion skill to teach your AI how to form useful Ensemble teams, write better teammate prompts, choose models, and avoid common coordination failures:

```bash
npx skills@latest add hueyexe/opencode-ensemble --skill opencode-ensemble
```

The skill is useful when you want the agent to choose a proportional workflow, split work into independent slices, use `depends_on` correctly, or pick a safe mix of capability profiles. The ready frontier contains pending tasks whose dependencies are complete; dependency-waiting tasks are normal queued work, not blockers.

Good team shapes:

- **Scout, builder, reviewer**: one `scout` maps the code, one writer profile changes it, and one `reviewer` checks a named risk after integration.
- **Parallel slices**: multiple writer profiles own independent files or vertical slices, then one risk-triggered reviewer checks the combined result when warranted.
- **Risky change**: use `plan_approval: true` on the implementing teammate, then approve or reject the plan through `team_message` before edits begin.

## Dashboard

A real-time mission control dashboard runs at `http://localhost:4747` while OpenCode is active.

![Ensemble Dashboard](docs/dashboard.png)

- **Health ring** — at-a-glance team health indicator in the header
- **Agent cards** — status, current task, activity sparklines, timing. Click to open detail drawer
- **Agent drawer** — full prompt, model, execution status, chat-style message history with markdown rendering
- **Task board** — progress bar, collapsible status groups, dependency arrows
- **Activity feed** — chat-style message bubbles with avatars, expandable with full markdown
- **Timeline** — horizontal event strip showing spawns, messages, completions, shutdowns
- **Keyboard shortcuts** — `j/k` navigate agents, `Enter` opens drawer, `Esc` closes, `?` shows help
- **Live clock** — current time + team session duration
- **Project outline** — collapsible per-project grouping when teams span multiple working directories

Configure the port in `.opencode/ensemble.json`:

```json
{
  "dashboardPort": 4747
}
```

Set to `0` to disable. The dashboard starts automatically when OpenCode loads the plugin.

## Install

Two steps: add the plugin, then allowlist worktree paths.

### Runtime requirements

The plugin uses SQLite via the host's runtime adapter:

- **Bun**: any version with `bun:sqlite` (Bun ≥ 1.0).
- **Node / Electron** (e.g. opencode Desktop): **Node ≥ 24** for stable `node:sqlite`. Older Node (20.x) lacks the module entirely; Node 22.5–23 has it behind `--experimental-sqlite`. If you load the plugin under an older Node and see `Cannot find module 'node:sqlite'` at startup, your runtime is too old.

### 1. Add the plugin

Add to your OpenCode config with a pinned version. Project-level or global.

**Project-level** (`opencode.json` in your project root):

```json
{
  "plugin": ["@hueyexe/opencode-ensemble@0.16.0"]
}
```

**Global** (`~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["@hueyexe/opencode-ensemble@0.16.0"]
}
```

OpenCode auto-installs npm plugins at startup. To update, bump the version number in your config and restart OpenCode.

**Why pin versions?** OpenCode has a [known bug](https://github.com/anomalyco/opencode/issues/6774) where unpinned plugins (e.g., `"@hueyexe/opencode-ensemble"`) get cached on first install and never auto-update, even after restarting. Pinning to a specific version avoids this — when you change the version string, OpenCode sees a new package spec and installs it fresh.

If you're stuck on an old version, clear the cache manually:

```bash
rm -rf ~/.cache/opencode/packages/@hueyexe
```

Then restart OpenCode.

### 2. Allow worktree directory access

Teammates work in git worktrees outside your project directory. Without this permission, OpenCode will prompt you to approve every file operation in a teammate's worktree.

Add to your OpenCode config (`~/.config/opencode/opencode.json`):

```json
{
  "permission": {
    "external_directory": {
      "~/.local/share/opencode/worktree/**": "allow"
    }
  }
}
```

This is required. Without it, you'll see "Permission required — Access external directory" prompts constantly.

### Local development

To test a local build, point your plugin config at the built output:

```json
{
  "plugin": ["/path/to/opencode-ensemble/dist/index.js"]
}
```

Build with `bun run build`, then restart OpenCode to pick up changes.

## Tools

21 tools. The lead can coordinate with all of them. Teammate sessions explicitly allow 12 communication, task, consultation, metrics, and artifact tools.

**Team lifecycle** (lead only, except archived-team purge may also be run from the main session)

| Tool | What it does |
|------|-------------|
| `team_create` | Create a team. Caller becomes the lead. Accepts an optional Unicode project display name while resource names use a safe internal slug. |
| `team_spawn` | Start a new teammate with a task. Supports `plan_approval`, `resume_from`, and an explicit writer `repository_root` under the Team controller directory. |
| `team_shutdown` | Ask a teammate to stop. Preserves their branch before aborting. Supports `force` flag. |
| `team_merge` | Merge a shutdown teammate's branch into working directory (unstaged). Blocks overlapping local changes and converges safely on repeated calls. |
| `team_cleanup` | Archive a fully integrated team. Refuses cleanup while a writer branch is unmerged or has an interrupted merge. With `purge`, previews archived-team deletion and returns exact approval labels plus a confirmation token. |
| `team_status` | See all members, their status, and a task summary. Session IDs are shown only to the lead. |
| `team_view` | Switch the TUI to a teammate's session. |
| `team_metrics` | Read bounded, privacy-safe aggregate telemetry across all projects and conversations, including active and archived Teams. |

Archived-team purge is intentionally two-step. First call `team_cleanup` with `purge` to get a preview, exact approval and denial option labels, and `confirm_token`; no data is deleted. Stale archived worktree/workspace references and stale Ensemble-owned branches are counted in the preview and cleaned during confirmed purge. Arbitrary non-Ensemble branches still block purge for safety. The lead must then use the question tool with those exact options. Only after the user selects the exact approval option should it call `team_cleanup` again with the same `purge`, `confirm_purge: true`, and the preview token.

**Communication** (everyone)

| Tool | What it does |
|------|-------------|
| `team_message` | Send a direct message to a teammate or the lead. Also handles plan approval/rejection. |
| `team_broadcast` | Message everyone on the team. |
| `team_results` | Atomically retrieve up to 20 unread messages for the caller without consuming another member's inbox. Repeat for the next batch or pass `message_id` for one specific unread message. |
| `team_consult` | Ask an active Planner to resolve a technical contract for the caller's owned in-progress task. |
| `team_consult_reply` | Let the assigned Planner answer the requester or escalate a business decision to the Lead. |

**Task board** (everyone)

| Tool | What it does |
|------|-------------|
| `team_tasks_list` | See all tasks with status and assignee. |
| `team_tasks_add` | Add a transactional DAG using existing same-Team IDs or batch-local keys; rejects missing, cross-Team, self, and cyclic dependencies. Supports workflow phases. |
| `team_tasks_complete` | Idempotently complete a task, optionally persist its structured terminal result in the same transaction, notify the Lead once, and unblock dependents. |
| `team_claim` | Claim a pending task. Atomic, prevents double-claims. |

**Team artifacts** (active Team members; publication is role/task constrained)

| Tool | What it does |
|------|-------------|
| `team_artifact_publish` | Publish immutable bounded UTF-8 `contract` or owned `task_result` content in SQLite. Only the Lead publishes contracts; task results require the current in-progress assignee. |
| `team_artifact_list` | List bounded same-Team artifact metadata without returning content. |
| `team_artifact_read` | Read one exact same-Team artifact by opaque ID with provenance and delimited content. |

Tasks may bind one exact contract artifact and stored SHA-256 digest before claim. Task list, claim, and spawn context expose that immutable binding; there is no implicit latest contract. Artifact storage is a coordination control plane for cooperative agents, not a security sandbox against arbitrary code running as the same operating-system user. v1 stores text only and intentionally excludes filesystem payloads, binary files, cross-Team sharing, aliases, Dashboard previews, and archived retrieval. Archived Team rows retain artifacts until explicit purge, when the preview includes artifact counts and logical bytes.

**Plugin feedback** (lead or standalone session)

| Tool | What it does |
|------|-------------|
| `team_report_issue` | File an Ensemble plugin defect or design observation on `Wuxie233/opencode-ensemble` for later triage. The target repository is fixed. |

**Metrics contract**

`team_metrics` accepts a strict request object with `summary`, `funnel`, `timeline`, or `compare` views. It is globally readable from any conversation: optional `project` and `team_ids` scopes filter results but do not authorize access. Windows accept RFC 3339 timestamps with `Z` or an explicit numeric timezone offset, are normalized to UTC, default to the previous 30 days, and are bounded to 100 results. Aggregate cohorts contain Teams whose `team.created` event falls inside the request window; a missing in-window archive is censored rather than unknown. Timeline requests require an explicit set of at most 10 Team IDs. Mechanism comparisons support one named mechanism versus `none`, recompute every requested metric per group, and suppress unscoped cells below five Teams. Usage aggregates are included only when their complete coverage span is contained in the request window. Every view reports request and actual telemetry coverage, unknown and censored counts, sampling rate, and instrumentation versions. It never returns prompts, messages, branches, paths, sessions, raw payload strings, or free text. Unsupported quality, causal, active-time, and cost-per-success metrics return structured reasons rather than inferred values.

## What you see in the TUI

The plugin works within OpenCode's existing TUI. For deeper visibility, open the [dashboard](#dashboard) at `http://localhost:4747`.

What you get:

- **Toast notifications** when teammates spawn, finish, error, shut down, or get rate-limited
- **Working progress toasts** showing who's still active after every status change (e.g. "Working: alice, bob (2/3)")
- **Rich tool titles** in the sidebar (e.g. "Spawned alice (build)", "Message -> bob", "Task board (3 tasks)")
- **Session switching** via `team_view` to see any teammate's full chat log
- **Status checks** via `team_status` for a snapshot of the whole team

Teammate messages arrive in the lead's session as `[Team message from alice]: ...` blocks. They look like user messages because that's how `promptAsync` delivery works. Content is clearly labeled with the sender's name.

## Architecture

- **SQLite** (WAL mode) for teams, members, tasks, messages, and immutable bounded text artifacts. Uses `bun:sqlite` in Bun and `node:sqlite` in Node/Electron through the internal database adapter.
- **promptAsync** for message delivery: injects a message and starts the prompt loop in one call
- **Git worktree isolation**: each teammate gets their own worktree by default, so multiple agents can edit files without conflicts. Opt out with `worktree: false` for read-only agents.
- **System prompt injection**: the lead's system prompt includes team state (member statuses, task counts) on every LLM call. Teammates get a short role reminder.
- **Compaction safety**: team context is preserved when OpenCode compacts long conversations
- **Bounded Lead Brief**: structured milestone summaries, active work, blockers, and phases remain available without copying raw evidence into the Lead context
- **Shell environment**: teammate shells get `ENSEMBLE_TEAM`, `ENSEMBLE_MEMBER`, `ENSEMBLE_ROLE`, and `ENSEMBLE_BRANCH` variables
- **Sub-agent isolation**: teammates' sub-agents can't use team tools (parent chain tracking, max depth 10)
- **Crash recovery**: eligible unfinished teammates continue in their original Sessions after restart; missing or failed Sessions fall back to preserved replacement recovery, while orphaned worktrees are cleaned up and undelivered messages are redelivered
- **Spawn rollback**: if the initial prompt fails, the member, session, and worktree are all cleaned up
- **Timeout watchdog**: teammates stuck busy beyond the TTL are automatically timed out and aborted
- **Stall detection**: detects teammates making no progress (low output tokens or no communication) and escalates to the lead
- **Peer-to-peer communication**: teammates can message each other directly, with idle-flush delivery and chatty agent detection
- **Explicit integration gate**: writer branches are merged with `team_merge`, reviewed, and verified before cleanup can archive the Team
- **Overlap detection**: `team_merge` blocks when you have local changes to files the agent also modified, preventing silent overwrites
- **Private lifecycle ledger**: immutable, privacy-safe lifecycle rows record selected transactional Team events after schema v13; they are never used for runtime decisions and are removed with explicit Team purge
- **Spawn circuit breaker**: stops retrying after 3 consecutive spawn failures
- **Provider retry breaker**: without an alternate model, attempts one through five remain silent and the sixth distinct retry safely terminates; optional per-agent fallback chains can trigger an earlier preserved `resume_from` + model handoff
- **Graceful shutdown**: busy teammates receive a shutdown message and finish their current work. Use `force: true` to abort immediately.
- **Rate limiting**: token bucket (configurable via config file or `OPENCODE_ENSEMBLE_RATE_LIMIT`, default 10 tokens/sec)

## Model Selection

Control which AI models your agents use. By default, agents use whatever model OpenCode is configured with. You can override this per-agent, per-agent-type, or with automatic rotation.

**All agents use the same model:**
```json
{
  "defaultModel": "anthropic/claude-sonnet-4-6"
}
```

**Different models for different agent types:**
```json
{
  "modelsByAgent": {
    "build": "anthropic/claude-opus-4-7",
    "explore": "openai/gpt-5.3-codex-spark"
  }
}
```

**Rotate through a pool for diverse perspectives:**
```json
{
  "modelPool": ["anthropic/claude-opus-4-7", "anthropic/claude-sonnet-4-6", "openai/gpt-5.4"],
  "modelAssignment": "rotate"
}
```

**Ask the user before spawning:**
```json
{
  "promptForModels": true,
  "modelPool": ["anthropic/claude-opus-4-7", "opencode/big-pickle", "openai/gpt-5.3-codex-spark"]
}
```

When `promptForModels` is true, the lead uses the question tool to ask which models to use before spawning any agents. The user can pick the same model for all agents, mix from the pool, or choose per agent.

**Resolution order** — when an agent is spawned, the model is determined by:
1. Explicit `model` param on `team_spawn` (lead or user chose it)
2. `modelsByAgent` mapping for this agent type
3. `modelAssignment` strategy (`rotate` or `random` from `modelPool`)
4. `defaultModel`
5. OpenCode's default model

The lead can always override by passing `model` directly on `team_spawn`, regardless of config.

Model IDs use the `provider/model` format from [models.dev](https://models.dev) (e.g. `anthropic/claude-opus-4-7`, `openai/gpt-5.4`). For OpenCode Zen models, use the `opencode/` prefix (e.g. `opencode/big-pickle`).

## Configuration

Configure via JSON files, environment variables, or both. Project config overrides global config. Env vars override everything.

### Config file

**Global** (`~/.config/opencode/ensemble.json`):

```json
{
  "mergeOnCleanup": true,
  "stallThresholdMs": 300000,
  "stallMinSteps": 5,
  "stallTokenThreshold": 200,
  "timeoutMs": 1800000,
  "rateLimitCapacity": 10,
  "dashboardPort": 4747,
  "defaultModel": "anthropic/claude-sonnet-4-6",
  "modelPool": ["anthropic/claude-opus-4-7", "anthropic/claude-sonnet-4-6", "openai/gpt-5.4"],
  "modelsByAgent": {},
  "modelAssignment": "default",
  "promptForModels": false,
  "artifactMaxBytes": 262144,
  "artifactTeamMaxCount": 1000,
  "artifactTeamMaxBytes": 16777216,
  "artifactGlobalMaxBytes": 268435456
}
```

**Project** (`.opencode/ensemble.json` in your project root) — same shape, overrides global per-key.

All fields are optional. Missing fields use defaults.

| Key | Default | Description |
|-----|---------|-------------|
| `mergeOnCleanup` | `true` | Deprecated compatibility setting. Cleanup always requires explicit `team_merge`, review, and verification before archival. |
| `stallThresholdMs` | `300000` (5 min) | Time without communication before stall escalation. `0` disables. |
| `stallMinSteps` | `5` | Min model steps before token-based stall check kicks in |
| `stallTokenThreshold` | `200` | Output tokens per step below which the agent is considered stalled |
| `timeoutMs` | `1800000` (30 min) | Hard timeout for busy teammates. `0` disables. |
| `rateLimitCapacity` | `10` | Token bucket capacity for team tool calls. `0` disables. |
| `dashboardPort` | `4747` | Dashboard server port. `0` disables. |
| `defaultModel` | `""` | Default model for all agents (e.g. `"anthropic/claude-sonnet-4-6"`). Empty = OpenCode's default. |
| `modelPool` | `[]` | List of models for rotation/random assignment. |
| `modelsByAgent` | `{}` | Map agent type to model (e.g. `{"build": "anthropic/claude-opus-4-7"}`). |
| `modelAssignment` | `"default"` | How to assign models: `"default"`, `"rotate"`, or `"random"`. |
| `promptForModels` | `false` | Lead asks user about model preferences before spawning. |
| `artifactMaxBytes` | `262144` (256 KiB) | Maximum UTF-8 bytes in one immutable Team artifact. |
| `artifactTeamMaxCount` | `1000` | Maximum artifacts retained by one Team. |
| `artifactTeamMaxBytes` | `16777216` (16 MiB) | Maximum artifact content bytes retained by one Team. |
| `artifactGlobalMaxBytes` | `268435456` (256 MiB) | Maximum artifact content bytes retained across all Teams. |

### Environment variables

Env vars override config file values. Useful for CI or one-off overrides.

```bash
# Adjust teammate timeout (default: 1800000ms = 30 minutes)
OPENCODE_ENSEMBLE_TIMEOUT=3600000

# Disable timeout watchdog
OPENCODE_ENSEMBLE_TIMEOUT=0

# Adjust rate limit (default: 10 tokens, refills 2/sec)
OPENCODE_ENSEMBLE_RATE_LIMIT=20

# Disable rate limiting
OPENCODE_ENSEMBLE_RATE_LIMIT=0

# Adjust stall detection threshold (default: 300000ms = 5 minutes)
STALL_THRESHOLD_MS=300000

# Disable stall detection
STALL_THRESHOLD_MS=0
```

## Best practices

- Maximize useful parallelism across distinct evidence domains and delivery boundaries. Do not impose a fixed teammate or Scout count.
- Give each teammate specific, self-contained tasks. Vague prompts produce vague results.
- Spawn a `scout` profile first to understand the codebase, then spawn writer profiles with that context.
- Use `worktree: false` for read-only agents (research, review, code analysis).
- Use `plan_approval: true` for risky changes. The teammate sends a plan first, you review and approve before they write any code.
- Don't micromanage. Teammates message you when done or when they're blocked.
- Don't poll `team_status` in a loop. Wait for messages.
- Reuse one Team across research, implementation, review, verification, and recovery.

## Known limitations

- **Teammate messages may switch the lead's agent mode.** When a teammate sends a message back to the lead via `promptAsync`, OpenCode starts a new prompt loop that can switch the lead from plan/explore mode into build mode. This is a server-level behavior that the plugin cannot override. The lead's mode will restore when you send your next message.

## How this differs from Claude Code agent teams

Same coordination model (shared tasks, peer messaging, lead coordination) with some additions:

- **Git worktree isolation by default**: each teammate gets their own branch, no merge conflicts between parallel agents
- **System prompt injection**: the lead's system prompt is updated with team state so it stays aware across turns
- **Compaction safety**: team context is preserved when sessions get long
- **Team-aware shell environment**: `ENSEMBLE_TEAM`, `ENSEMBLE_MEMBER`, `ENSEMBLE_ROLE`, `ENSEMBLE_BRANCH`
- **Graceful shutdown**: teammates finish current work before stopping, with a force flag for emergencies
- **Plan approval mode**: review teammate plans before they write code
- **Works today as a plugin**: install and go, no upstream changes needed

## Development

```bash
bun install
bun run typecheck
bun test             # 623 tests
bun run build
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.

## License

MIT
