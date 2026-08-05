# opencode-ensemble — Agent Guidelines

## Private Customization

This checkout is the user's private customization source. `origin` points to
`Wuxie233/opencode-ensemble`; `upstream` points to the official
`hueyexe/opencode-ensemble` repository. Keep private behavior in small tested
commits and never patch the installed npm cache.

This fork has diverged far enough from upstream that it is treated as an
independent product, not a patch series awaiting rebase. Do not plan work around
upstream parity, do not file issues or open PRs against `hueyexe/*`, and do not
weaken private behavior to stay mergeable upstream. `upstream` is kept only as a
read-only reference for occasionally reading how the official implementation
solved something. All feedback, issues, and iteration belong on `origin`.

The active OpenCode configuration loads `/root/CODE/opencode-ensemble/dist/index.js`.
Build it locally after verified source changes, but do not commit `dist/`.
OpenCode must be restarted manually by the user before plugin code or config
changes take effect.

The private dashboard uses Simplified Chinese for fixed UI copy. Preserve
project, team, member, task, prompt, message, model, branch, path, command,
output, and raw runtime-error content verbatim. The canonical terminology is in
`CONTEXT.md`.

## What This Is

opencode-ensemble is an OpenCode plugin that enables agent teams: multiple
agents running in parallel with peer-to-peer communication, shared task
management, and coordinated execution. Built entirely on the public OpenCode
plugin SDK (@opencode-ai/plugin) with zero internal dependencies.

## Design Context

### Users

OpenCode Ensemble is for developers using OpenCode to coordinate multiple AI
agents on implementation, research, review, and test work. The dashboard is
primarily for live triage: quickly seeing which agents are working, idle,
blocked, errored, or done, then drilling into the right agent, task, or message
without losing context.

### Brand Personality

Focused, operational, and precise. The product should feel like a developer
mission control surface: high-signal, technically credible, calm under pressure,
and alive enough to make parallel work visible.

### Aesthetic Direction

Use a mission-control visual language: dark, disciplined, status-rich, and
spatially clear. Favor crisp hierarchy, meaningful status color, compact but
readable density, and purposeful motion for live updates. Avoid generic AI
dashboard tropes: decorative glow, arbitrary glassmorphism, identical metric
cards, gradient-text hero treatments, and ornamental charts that do not support
triage.

### Design Principles

1. Prioritize live triage over decoration: every region should answer who needs
   attention, what changed, and what the lead can inspect next.
2. Preserve developer context: keep agents, tasks, activity, and timeline
   connected instead of scattering related signals across unrelated cards.
3. Use status redundantly: pair color with text, shape, grouping, and accessible
   state labels so status is understandable without relying on color alone.
4. Support both first glance and deep inspection: show a clear overview first,
   then reveal prompts, messages, dependencies, branches, and timing in focused
   detail views.
5. Keep the interface fast and resilient: keyboard navigation, visible focus,
   responsive layout, reduced-motion support, and empty/error/loading states are
   baseline requirements.

## Architecture

### Plugin SDK Constraint

This is a plugin, not a core contribution. We only use APIs from
@opencode-ai/plugin and @opencode-ai/sdk. No access to OpenCode internals
(Storage, Bus, Lock, SessionPrompt, etc.).

Key SDK primitives:
- client.session.create() — create teammate sessions
- client.session.promptAsync() — inject messages + auto-wake (fire-and-forget)
- client.session.abort() — cancel/shutdown teammates
- client.session.status() — poll session idle/busy state
- event hook — subscribe to session.status events for state transitions
- tool hook — register the 18 team tools
- tool.execute.before hook — rate limiting + sub-agent isolation

### Storage

SQLite via the internal database adapter (zero external dependencies): `bun:sqlite`
when running on Bun, `node:sqlite` when running on Node/Electron. Six tables:
- project — directory identity, display name, and resource slug
- team — team config (name, lead session, status, delegate mode)
- team_member — member registry (name, session ID, agent, status)
- team_task — shared task board (content, status, priority, assignee, deps)
- team_message — message log (from, to, content, delivered flag)
- team_event — privacy-safe immutable lifecycle rows retained until explicit Team purge; observation only, never a runtime source of truth

`project.path` is the Team's default data-plane repository root.
`team.controller_directory` is the Lead plugin directory that owns recovery,
watchdog, and purge lifecycle. A writer may persist an exact child Git root and
common-dir identity on `team_member`; every later SDK worktree/workspace call and
Git preservation, merge, recovery, or cleanup operation for that writer must use
the member binding. Legacy both-null member bindings fall back to the Team root;
partial bindings fail closed. Lifecycle discovery remains scoped to the
controller directory.

`team_spawn_attempt` durably owns external resources between task claim and
member registration. Create it before the first SDK side effect, update its
stage and discovered identifiers before crossing the next boundary, and remove
it only after member ownership transfers or cleanup is proven. Timeouts retain
the attempt and task because the SDK request may complete late; startup recovery
and `team_cleanup` reconcile attempts before releasing tasks or archiving.

The SQLite connection, dashboard listener, and `ActivityBuffer` are process-shared across directory plugin instances. Directory-local watchdogs, registries, trackers, and rate limiters remain isolated. Release shared resources only after the final directory and any in-flight recovery task finish.

Main-directory recovery is deduplicated per resolved project and starts after registry rehydration. Keep recovery asynchronous so SDK calls back into OpenCode cannot block directory bootstrap; worktree instances continue to skip recovery entirely.

WAL mode. Migrations via PRAGMA user_version.

### Dashboard Triage

The dashboard is a live triage surface. Keep attention items risk-first and
actionable: agent alerts open the matching agent context, while unassigned task
alerts focus the exact task. Polling is single-flight and retains the last good
snapshot on failure. Interactive state must be keyed by stable member, task,
message, or timeline source IDs rather than render indexes so polling and risk
sorting cannot move focus or activate a different object.

At 320px and browser text zoom, summary status must wrap without horizontal
scrolling, project navigation must remain independently scrollable, and runtime
identifiers must wrap or truncate with the full value still available. Browser
acceptance for dashboard changes should cover slow and failed polls, focus
restoration, attention navigation, timeline state, long identifiers, and body
overflow in addition to `test/dashboard-ui-contract.test.ts`.

### Message Delivery

All messages delivered via client.session.promptAsync(). Single atomic
operation: injects user message + starts prompt loop if idle. No polling,
no file watching, no custom pub/sub.

The idle peer-message backstop atomically claims only the oldest stale message
for an active Team member whose status is `ready`. Keep one wake in flight per
recipient until that Session starts a new turn. Delivery failure may restore
the claim only while the Team and recipient remain eligible; cleanup archives
the Team and consumes residual messages in the same transaction.

Asynchronous peer delivery uses `team_message.delivery_claimed_at` as a
recoverable lease. Keep `delivered=0` until `promptAsync` resolves, exclude
leased rows from system-prompt injection, and allow startup recovery to reclaim
expired leases. Never use `delivered=1` as an in-flight claim.

### State Machines

Two-level per member:
- Member status: ready | busy | shutdown_requested | shutdown | error
- Execution status: idle | starting | running | cancel_requested |
  cancelling | cancelled | completing | completed | failed | timed_out

Driven by session.status events and terminal session.error events from the
plugin event hook. The first error for an active ready/busy teammate must
atomically mark it `error`/`failed`, return its in-progress tasks to
pending/unassigned, and persist an actionable system message to the Lead before
attempting a fire-and-forget wake. Error members stay terminal across later
idle/busy events. Every Ensemble-initiated abort must first record
`shutdown_requested` so the resulting `MessageAbortedError` is not reported as
an unexpected failure. Only transition a member to `shutdown` after
`session.abort()` resolves; preservation or abort failures must leave it
`shutdown_requested`, persist guidance for the Lead, and remain retryable.
Graceful shutdown records `shutdown_requested` before asking the member to
finish its current turn. When the session becomes idle, the controller refreshes
branch preservation, aborts the session, and settles the terminal state; a
Child is never told to stop itself. Ordinary peer, idle, stall, and chatty
prompts are allowed only for active `ready`/`busy` members outside cancelling
or terminal execution states.

OpenCode owns ordinary provider retry policy. Without an alternate model in
`modelFallbackByAgent`, keep attempts one through five silent and preserve the
member/task as running. With an alternate configured, the fallback threshold
may safely stop the current member and give the Lead an explicit
`resume_from` + model handoff. On the configured exhaustion attempt (six by
default), atomically claim termination, preserve the branch, await
`session.abort()`, then mark the member `error`/`failed`, release only its
in-progress tasks, and alert the Lead to create a fresh session with
`team_spawn(resume_from)`. Never release task ownership or recommend a
replacement before abort succeeds. Preservation or abort failure must retain
the member/task and the durable sixth-retry termination claim; later retry
events retry termination without incrementing past the configured limit. OpenCode dispatches
plugin event hooks fire-and-forget, so awaiting abort inside the hook is local
coordination, not provider-loop backpressure. Keep one process-shared
termination in flight per Session and use the durable claim plus a terminal
liveness guard to re-abort any late `busy`/`retry` event, including when the
terminal member is absent from the in-memory registry. Every such re-abort must
refresh branch preservation first. Reset a non-tripped sequence on idle,
meaningful assistant output, or terminal `session.error`; never append a new
teammate prompt as an automatic retry because it may repeat tool side effects.

The task graph accepts existing same-Team task IDs and batch-local keys only.
Reject missing, cross-Team, self, and cyclic dependencies transactionally.
Dependency-waiting tasks remain internally `blocked` but are presented as normal
waiting work and do not enter risk attention. `current_phase` is derived from the
active ready frontier and recomputed in every task claim, completion, rollback,
error, timeout, recovery, shutdown, and force-cleanup release transaction.
Reuse one Team across research, implementation, review, verification, and
recovery phases. Structured progress/result/blocker summaries and the bounded
rolling Lead Brief keep raw evidence out of Lead context; full details remain
available through `team_results` or the teammate session.
Lead Brief and dashboard risk use the latest structured state per task/member,
so later progress/result or task completion resolves an older blocker.

After the Lead dispatches asynchronous work and has no actionable work left,
it ends the current turn; teammate `team_message` delivery wakes a new turn via
`promptAsync`. Do not keep a Lead turn open with sleep or repeated status/task
polling, and do not send information-free check-ins. `team_status` and
`team_tasks_list` remain valid for a user-requested snapshot or a concrete
stall/recovery check.

The only terminal-error recovery exception is a one-shot unexpected
`MessageAbortedError` whose exact persisted assistant turn has zero tool parts.
Require an active, incomplete teammate with no completion report, keep the
member/task active, and send one silent recovery prompt that first inspects
actual state. Persist an owner-token lease for both inspection and asynchronous
prompt delivery across plugin instances; only the current owner may prompt or
fail closed, disposal must settle locally owned claims, and an unsettled prompt
must expire into normal terminal handling. A second
abort, ambiguous history, any tool part, shutdown/completion race, inspection
failure, or recovery-prompt failure must fail closed through the normal Lead
alert and task-release path.

The hard-timeout watchdog must honor recent process-shared `ActivityBuffer`
activity before claiming a busy member, including a second check after branch
preservation. A claimed timeout persists recovery guidance and wakes the Lead
with fire-and-forget `promptAsync` before aborting the teammate. A writer branch
without the project directory needed to preserve it fails closed and remains
owned; the same rule applies during startup recovery.

### Sub-Agent Isolation

Enforced via tool.execute.before hook. Maintains a Map<sessionID, parentSessionID>
populated from session events. When a team tool call arrives from an unknown
session, walks the parent chain (max depth 10). If any ancestor is a team
member, the call is blocked. This covers sub-agents at arbitrary depth.

## The 21 Tools

| Tool                | Who Can Use | Purpose                              |
|---------------------|-------------|--------------------------------------|
| team_create         | Any session | Create a new team, caller is lead    |
| team_spawn          | Lead only   | Spawn a teammate with a prompt (supports plan_approval mode) |
| team_message        | Any member  | Send message to teammate or lead (approve/reject plans) |
| team_broadcast      | Any member  | Send message to all team members     |
| team_tasks_list     | Any member  | View the shared team task board      |
| team_tasks_add      | Any member  | Add tasks to the shared board        |
| team_tasks_complete | Any member  | Atomically complete a task, persist an optional terminal result, and unblock deps |
| team_claim          | Any member  | Atomically claim a pending task      |
| team_results        | Any member  | Retrieve full message content        |
| team_consult        | Member only | Ask a Planner about an owned task's technical contract |
| team_consult_reply  | Planner only | Resolve a consultation or escalate it to the Lead |
| team_shutdown       | Lead only   | Request teammate shutdown, preserves branch |
| team_merge          | Lead only   | Merge a shutdown teammate's branch   |
| team_cleanup        | Lead only   | Archive only after every writer branch is explicitly merged and verified |
| team_status         | Any member  | View members, statuses, task summary |
| team_view           | Any member  | Navigate TUI to teammate's session   |
| team_metrics        | Any session | Read bounded, privacy-safe aggregate telemetry across projects and conversations; timeline requires explicit Team IDs |
| team_artifact_publish | Active Team member | Publish immutable text contracts or owned task results under role/task authorization |
| team_artifact_list  | Active Team member | List bounded same-Team artifact metadata without content |
| team_artifact_read  | Active Team member | Read one exact same-Team artifact by opaque ID |
| team_report_issue   | Lead only (or standalone) | File an Ensemble defect or design observation to the plugin's own tracker for later triage |

## Hooks

Three hooks wired in index.ts:

- `experimental.chat.system.transform` — injects team state into the lead's
  system prompt (member statuses, task counts, anti-polling guidance). Injects
  a short role reminder for teammates.
- `experimental.session.compacting` — preserves team context during session
  compaction so the model remembers it's leading/part of a team after long
  conversations are compressed.
- `shell.env` — sets ENSEMBLE_TEAM, ENSEMBLE_MEMBER, ENSEMBLE_ROLE, and
  ENSEMBLE_BRANCH in teammate shells.

## Settled Decisions (Do Not Re-Debate)

1. SQLite via the internal database adapter — not file JSON, not in-memory-only, not external native packages
2. promptAsync for message delivery — not session injection, not polling
3. 21 separate tools — not a unified action tool, no exceptions
4. Fire-and-forget spawn — not blocking, not tmux
5. tool.execute.before for rate limiting — token bucket, in-memory
6. tool.execute.before for sub-agent isolation — full descendant tracking via parent chain
7. Worktree isolation on by default — each teammate gets their own git
   worktree via client.worktree.create(). Opt out with worktree: false
   for read-only agents. Lead explicitly merges and verifies writer branches
   before cleanup.
8. Plan approval is prompt-enforced, not permission-based — the teammate's
   context message tells it to send a plan and wait for approval. No tool-level
   gating.
9. Controller-owned graceful shutdown — team_shutdown asks a busy teammate to
   report and end its current turn. The controller settles it when idle. Pass
   force: true to abort immediately after preservation.
10. Never await promptAsync — all promptAsync calls are fire-and-forget.
    Awaiting blocks the caller if the transport is slow or broken. Messages
    are persisted in the DB first; the idle-flush backstop handles delivery.
11. v1→v2 SDK transport extraction uses `._client` (underscore) — see
    "SDK Transport" section below. Do NOT change this property name.
12. Branch preservation before session.abort() is MANDATORY — see
    "Branch Preservation" section below. Every code path that calls
    session.abort() MUST preserve the worktree branch first.
13. `team_spawn(claim_task)` owns task coordination atomically. It must claim
    only a same-Team pending task before resource creation and conditionally
    roll the claim back on every spawn failure path.
14. `team_spawn(resume_from)` creates a fresh isolated session and transfers a
    bounded prompt context; it never forks or changes the predecessor session.
    The 32 KiB packet keeps the original task and early context plus recent
    progress/errors when truncation is required.
15. `team_merge` pins a source ref to an immutable commit OID before overlap,
    integration proof, merge, or deletion. Persist that OID with merge
    completion; delayed cleanup may delete the branch only with an atomic
    expected-OID check. A moved ref and legacy merged rows without an OID remain
    preserved for manual cleanup.

## Branch Preservation (Critical — Do Not Skip)

`session.abort()` triggers OpenCode's internal session cleanup, which
asynchronously deletes the worktree AND its git branch. This is a race
condition — sometimes the branch survives, sometimes it doesn't.

### The invariant

**Every code path that calls `session.abort()` MUST call
`preserveBranch()` first.** No exceptions. This copies the worktree
branch to `ensemble/preserved/{team}/{name}`, a standalone git ref
that is not tied to any worktree. OpenCode cannot delete it.

### Call sites (audit these if you change shutdown/cleanup)

1. `team-shutdown.ts` → `preserveAndAbort()` — idle/force shutdown
2. `team-shutdown.ts` → graceful path — preserves before sending
   shutdown message (covers crash during shutdown_requested)
3. `team-cleanup.ts` → force-abort path — preserves before aborting
   active members
4. `recovery.ts` → `recoverStaleMembers()` — preserves before aborting
   stale busy members on crash recovery
5. `watchdog.ts` → timeout abort — preserves before aborting
   timed-out members
6. `index.ts` → `idle_while_shutdown` / `busy_while_shutdown` events —
   verify/re-preserve before controller settlement or a late re-abort
7. `team-spawn.ts` → prompt or post-create registration failure — preserves
   any created worktree branch before aborting the child session
8. `spawn-attempt-recovery.ts` → late or interrupted spawn cleanup — preserves
   an owned source branch before aborting a durably recorded child session

### What goes wrong if you skip it

The worktree branch is deleted by OpenCode's session cleanup. Without the
preserved ref, the Lead has no branch to pass to `team_merge`, and cleanup
correctly refuses archival. The agent's committed work is permanently lost. This happened in v0.9.0
and earlier — agent work was silently destroyed on shutdown.

### How to verify

After any `session.abort()` call, check that the preserved branch
exists: `git branch --list ensemble/preserved/*`. If it's missing,
the preservation was skipped or failed.

A missing failed-writer ref is never evidence that the writer was empty.
`team_merge` may record a verified-empty settlement only from the persisted Git
identity and spawn baseline plus a surviving matching ref or a clean matching
worktree. `team_cleanup` consumes that explicit settlement and never infers it
from missing messages, refs, or worktrees.

Legacy Teams may recover a null Git identity only by exact-verifying the
persisted repository root and conditionally recording the matching common-dir.
An already-integrated branch settles only when its pinned commit is an ancestor
of HEAD or isolated-index Git plumbing proves applying its net tree change is a
no-op. Messages, branch names, patch IDs, and missing refs are never sufficient.

## SDK Transport (Critical — Do Not Change)

The plugin framework provides a v1 SDK client (`input.client`). We need
the v2 SDK for flat params, `permission` on `session.create`, and `agent`
on `promptAsync`. The v2 client is created by extracting the HeyAPI
transport from the v1 client:

```typescript
const transport = (input.client as unknown as { _client: V2Transport })._client
const rawClient = new OpencodeClient({ client: transport })
```

### Why `_client` not `client`

The v1 SDK stores its HeyAPI transport as `this._client` (underscore).
The v2 SDK stores it as `this.client` (no underscore). These are
DIFFERENT property names on DIFFERENT classes.

- Reading FROM v1: `input.client._client` (underscore — v1 convention)
- Passing TO v2 constructor: `{ client: transport }` (no underscore — v2 param name)

### What goes wrong if you change this

- Using `.client` instead of `._client`: returns `undefined`, v2 falls
  back to a default HTTP transport that cannot reach the server (Unix
  socket, auth headers are missing). Every `session.create()` fails with
  "Unable to connect".
- Using `createOpencodeClient({ baseUrl })`: creates a standalone HTTP
  client. Same failure — the server may not be reachable via plain HTTP
  from inside a plugin.

### Biome compliance

The cast uses `as unknown as { _client: V2Transport }` — no `any` type.
The `V2Transport` type is inferred from the v2 `OpencodeClient`
constructor parameter. Biome's `noExplicitAny` rule is satisfied.

### How to verify

If `session.create()` returns "Unable to connect", the transport
extraction is broken. Check that `._client` is being read, not `.client`.

## promptAsync Is Fire-and-Forget (Critical — Do Not Await)

All `promptAsync` calls MUST be fire-and-forget (no `await`). This
applies to `team_spawn`, `team_message`, and `team_broadcast`.

### Why

`promptAsync` is HTTP 204 on the server (returns immediately, no body).
But if the transport is slow, the proxy buffers, or the connection has
latency, `await`ing it blocks the tool call. The lead's `team_spawn`
never returns, the TUI shows a loading spinner, and the lead hangs
indefinitely — even though the child session IS running.

### The pattern

```typescript
// CORRECT — fire-and-forget with async error handling
deps.client.session.promptAsync({ ... }).catch(() => { /* rollback */ })

// WRONG — blocks the caller
await deps.client.session.promptAsync({ ... })
```

### Safety net

Messages are persisted in the DB with `delivered=0` BEFORE the
`promptAsync` call. If delivery fails:
- team_spawn: async `.catch()` rolls back the member + notifies lead
- team_message: idle-flush backstop redelivers when recipient goes idle
- team_broadcast: partial delivery is expected and handled

## Lessons from Anthropic (Applied)

These are first-hand lessons from the Claude Code team that directly
apply to this plugin's design:

1. Separate tools beat unified action tools. A tool that does one
   thing has a clearer description, a tighter schema, and models
   call it more reliably. Do not consolidate tools to reduce count.

2. Teammates only see their tools. The context message injected by
   team_spawn should describe only the tools a teammate can use:
   team_message, team_broadcast, team_tasks_list, team_tasks_add,
   team_tasks_complete, team_claim. Do not describe lead-only tools
   to teammates.

3. Do not add periodic system reminders. Do not inject "remember
   your task" messages into teammate sessions on a timer or turn
   count. Trust the model to manage its own context. Reminders
   constrain rather than help capable models.

4. The task list is a coordination primitive, not a to-do list.
   Frame tasks as the way agents communicate work status to each
   other, not as a checklist for the individual agent.

5. If a feature can be implemented via a better prompt rather than
   a new tool, prefer the prompt. Every new tool is cognitive load.

## Teammate Context Message Design

The prompt injected by team_spawn is the teammate's entire world.
Keep it concise and include:

1. Their name and role in the team
2. The task they are working on
3. The 12 tools they can use (team_message, team_broadcast,
   team_tasks_list, team_tasks_add, team_tasks_complete, team_claim,
   team_consult, team_consult_reply, team_metrics, team_artifact_publish,
   team_artifact_list, team_artifact_read)
   with a one-line description of each
4. How to report completion (`team_tasks_complete` with `result` for a claimed
   task; one `team_message` result only when no task was claimed)
5. How to get unblocked (team_message to lead with the blocker)

Add only short task-relevant coordination, plan-approval, worktree, structured
progress/result/blocker, and recovery guidance. No system architecture or full
Team history. Keep the fixed context under 500 tokens, excluding bounded
`resume_from` context and the Lead-supplied task.

The lead's AGENTS.md and system prompt handle everything else.
Teammates do not need to know how agent teams work internally.

## Code Standards

- TypeScript strict mode
- Biome linter with `noExplicitAny: error` — no `any` types, no `as any` casts
- Zero external deps beyond @opencode-ai/sdk and @opencode-ai/plugin; SQLite access stays behind src/db.ts
- Every exported function has a JSDoc comment
- const over let, early returns over else
- snake_case for SQL columns, camelCase for TypeScript
- Functional array methods over for loops

## Build/Test Commands

- Install: `bun install`
- Typecheck: `bun run typecheck`
- Test: `bun test`
- Build: `bun run build`

## Verification Ownership

An implementation Builder validates only its owned slice before reporting completion:

- run the narrowest relevant test file or test filter;
- run only directly affected lint or typecheck targets when the repository exposes them;
- inspect the owned diff and report broader checks deferred to the Lead; and
- do not run `bun run typecheck && bun test && bun run build` unless the task explicitly owns terminal repository verification.

After all writer branches are merged, the Lead runs the full repository gate once:

```
bun run typecheck && bun test && bun run build
```

All three must pass before final delivery. Additionally:
- No TypeScript `any` types introduced
- No new `TODO` comments without a linked open question number (`OQ-<N>`)
- Test coverage for the happy path AND at least one error path per tool
- JSDoc on every exported function

## Bun Runtime

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.
- Use the database adapter in `src/db.ts` for SQLite. It selects `bun:sqlite` on Bun and `node:sqlite` on Node/Electron. Don't use `better-sqlite3`, and don't import runtime-specific SQLite modules outside `src/db.ts`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile

## Publishing

Publishing is restricted to admin contributors (hueyexe). Do not publish
unless explicitly asked by the admin.

To publish a new version:

```
bun run typecheck && bun test && bun run build && bun publish --access public
```

Then create a GitHub release:

```
gh release create v<version> --repo hueyexe/opencode-ensemble --title "v<version>" --notes "<release notes>"
```

Use `gh auth switch --user hueyexe` first if the active gh account is not hueyexe.

### Release notes format

Every release MUST have a proper description. Do not use `--generate-notes`.
Follow this format:

- Main feature gets a `### Heading` describing what changed
- Bullet points for specific changes under the heading
- Secondary changes go under `### Also in this release` or `### Improvements`
- End with `**Full Changelog**: https://github.com/hueyexe/opencode-ensemble/compare/vPREV...vNEW`

Example:

```
### Git Worktree Isolation

Each teammate now gets their own git worktree by default.

- Worktree created automatically on `team_spawn` (opt out with `worktree: false`)
- Each teammate works on their own branch (`ensemble-{team}-{name}`)
- Orphaned worktrees cleaned up on plugin init

**Full Changelog**: https://github.com/hueyexe/opencode-ensemble/compare/v0.3.1...v0.4.0
```

## Testing

- bun test runs all tests
- In-memory SQLite (:memory:) — no disk, no cleanup
- Mock OpencodeClient for integration tests
- Race condition tests via Promise.all()
- No mocks for business logic

## Open Question Handling

For open questions (Section 9 of .opencode/plans/architecture-plan.md):
- Make the conservative choice
- Add `// OQ-<number>: <assumption made>` comment at the call site
- Write a corresponding test that will fail if the assumption is wrong
- Do not silently resolve open questions without a comment

## Reference Material

docs/reference contains two PR implementations:
- opencode-pr-ugo/ — Event-driven, Storage-based (9 tools, auto-wake, inbox)
- opencode-pr-dxm/ — SQLite/Drizzle-based (unified action tool, blocking wait)

Both are core contributions importing OpenCode internals. Our plugin achieves
the same functionality using only the public SDK.

### Internal API Blocklist

When reading reference code, if you see any of these identifiers, they are
internal OpenCode APIs that we CANNOT use from a plugin:

- `Storage` (Storage.read, Storage.write, Storage.update, Storage.list)
- `Bus` (Bus.subscribe, Bus.publish)
- `Lock` (Lock.read, Lock.write)
- `SessionPrompt` (SessionPrompt.loop, SessionPrompt.cancel)
- `SessionStatus` (SessionStatus.get)
- `Identifier` (Identifier.ascending)
- `Instance` (Instance.project, Instance.directory)
- `Database` (Database.use)

Find the equivalent plugin SDK approach in
.opencode/plans/architecture-plan.md Section 1 (Gap Analysis table)
before proceeding.
