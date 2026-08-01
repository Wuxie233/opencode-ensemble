# Ensemble Metrics Design

## Purpose and Boundary

The measurement unit is one Team from `team.created` to `team.archived`. A
workflow may add a typed run label, but Core Ensemble metrics must remain
domain-agnostic. The primary question is whether Ensemble improves verified
end-to-end outcomes, not whether it creates more tasks or model activity.

Use medians and p90s per project, workflow kind, model family, profile mix, and
complexity band. Compare like-for-like cohorts or matched sequential baselines.
Never infer causality from an unadjusted before/after chart.

Three evidence classes must remain distinct:

- **Available now:** SQLite Team, Member, Task, Message, immutable versioned
  `team_event` rows, and aggregate-only numeric Team/Member usage counters.
  These survive restart until explicit Team purge. Coverage begins at migration
  16; legacy events remain explicitly unversioned and are never backfilled.
- **Ephemeral now:** tool calls and shell results in the process-shared
  `ActivityBuffer`; SDK session messages can be fetched on demand. Neither
  source is suitable for historical metrics.
- **Missing:** explicit outcome labels, baseline identity, active/blocked spans,
  workflow or complexity classification, and complete incident correlation.

## Metric Catalog

`T0` is `team.created.time_created`; `T1` is `team.archived.time_created`.
Durations use monotonic event order when available and wall-clock milliseconds
only for elapsed-time reporting. A missing terminal event produces a censored
run, not a zero.

### Result

| Metric | Formula | Source and instrumentation | Cost and cautions |
|---|---|---|---|
| Verified outcome rate | `verified_success Teams / eligible terminal Teams` | **Missing:** append a privacy-safe terminal outcome such as `verified_success`, `verified_failure`, or `abandoned`, plus evidence-kind counts. Delivery Run may derive this from its verification state; generic teams require an explicit owner label. | Low, one terminal row. Task completion or archive alone does not establish quality. Exclude still-running and unknown outcomes from the denominator; report their rate separately. |
| First-pass acceptance | `Teams accepted without reopened task, corrective teammate, or failed verification / verified Teams` | **Missing:** stable run ID, verification attempts, task reopen/correction relation. Existing `task.completed` and `merge.completed` provide partial ordering only. | Low to medium. A stricter gate lowers this rate even when product quality improves. Segment by workflow and risk. |
| Durable-work recovery | `incidents ending with preserved and integrated work / work-at-risk incidents` | Current `merge.completed`, `merge.failed`, Member `merge_state`, and preserved branch reference are partial evidence. **Missing:** enumerated `work_at_risk`, `preservation_succeeded`, `preservation_failed`, `recovery_integrated`, and `work_lost` events. | Low, incident-only. A missing branch can mean a read-only member; define the denominator from explicit incidents, not all Members. |
| Outcome lift versus baseline | `(Ensemble success rate - baseline success rate)` and `median(baseline cycle time) / median(Ensemble cycle time)` within matched strata | **Missing:** `execution_mode` (`ensemble` or baseline), workflow kind, complexity band, repository revision, and terminal outcome. | Medium because baseline collection requires comparable non-Ensemble runs. Parallelism is beneficial only when quality does not regress; report lift with confidence intervals and sample counts. |

### Efficiency

| Metric | Formula | Source and instrumentation | Cost and cautions |
|---|---|---|---|
| End-to-end cycle time | `T1 - T0`; also time to verified outcome when that precedes archive | Current `team_event` has both boundary events; `team.time_created/time_updated` is a fallback snapshot. **Missing:** verified-outcome timestamp. | Near zero. Cleanup delay can dominate `T1`; report outcome time and archive lag separately. |
| Critical-path task time | `max(path sum of task active durations)` over `depends_on` DAG | Current Task dependencies and lifecycle events identify creation, claim, completion, unblock, and reason-coded releases for runtime-owned failure/shutdown paths. **Missing:** pause/block transitions and active-span IDs. | Medium event volume. `time_updated - time_created` mixes waiting and work and must not be called active time. |
| Parallelism utilization | `integral(active Members) dt / (wall time * peak concurrent Members)` | Versioned Member status/execution transition events cover spawn-time and runtime-owned state changes after migration 16. | Medium, transition-only. Legacy and incomplete instrumentation must remain unknown, not inferred. High utilization can indicate useful overlap or excess fan-out; pair with outcome and merge/rework metrics. |
| Coordination wait share | `sum(task ready-to-claim + consultation wait + plan approval wait + merge wait) / sum(task elapsed time)` | Current task/plan/consult/merge states expose the latest state; lifecycle events cover plan and merge but not consultation or every task transition. **Missing:** transition events with stable correlation IDs. | Medium. Overlapping waits must be assigned to mutually exclusive states before summing. |
| Cost per verified outcome | `sum(model cost) / verified_success Teams`; report tokens similarly | Aggregate input/output token and cost counters are durable per opaque Team/Member identity when SDK step events provide numeric usage. **Missing:** verified outcomes, provider/model attribution, cache token classes, and price-version metadata. | Low storage. Coverage is best-effort and versioned; provider prices and cache accounting change, so aggregate dollars alone are not a normalized comparison. |
| Wasted execution share | `(tokens or cost after terminal result + failed/replaced Member usage + abandoned-task usage) / total usage` | **Missing:** durable usage deltas, terminal-result timestamp, replacement lineage (`resume_from`), and reason-coded abandoned work. Retry counters give only a partial signal. | Medium. Failed exploration can be necessary learning. Label this avoidable waste only when a reason code establishes duplication, late execution, or discarded output. |

### Reliability

| Metric | Formula | Source and instrumentation | Cost and cautions |
|---|---|---|---|
| Team completion reliability | `Teams reaching verified terminal state / Teams started`; separately `Teams archived cleanly / Teams started` | `team.created` and `team.archived` exist. **Missing:** verified/abandoned terminal outcome and cleanup-blocked events. | Low. Archived is an operational state, not proof of successful delivery. Apply a cohort cutoff and show censored Teams. |
| Member failure rate | `Members ending failed, timed_out, or unexpected error / Members registered` | `member.registered` plus versioned Member terminal transitions and reason codes cover runtime-owned failure, timeout, and recovery paths after migration 16. | Low. User-requested shutdown is not failure. Count one terminal incident per Member, not every retry event; legacy members remain unknown. |
| Retry exhaustion and fallback recovery | `retry-tripped Members / Members with retry`; `fallback Members later completed / fallback Members` | Versioned distinct retry-attempt, fallback, and exhaustion events supplement current retry fields. **Missing:** completion linkage and latency. | Low, retry-only. Provider incidents cluster in time; model attribution is intentionally absent; group by incident window before blaming orchestration. |
| Recovery latency | `terminal recovery settled time - incident detected time`, by timeout, unexpected abort, restart, or late terminal event | Versioned recovery-stage events cover detection, preservation, prompting, re-abort, and settlement for watchdog, startup, safe-abort, and late-terminal paths. **Missing:** shared incident ID and complete abort/replacement linkage. | Low, incident-only. Failed-safe behavior may be slower because it protects work; always pair latency with work-loss rate. |
| Message delivery reliability | `messages delivered within SLO / attempted messages`; lease recovery rate is `expired claims recovered / expired claims` | `team_message` has creation, `delivered`, and `delivery_claimed_at`. **Missing:** delivery-settled timestamp, attempt count, failure/reclaim reason, and channel (`lead`, peer, broadcast). | Medium for per-attempt events; low for aggregate counters. `delivered=1` can be set during archive consumption, so it is not currently proof of recipient delivery. |
| Merge reliability | `merge.completed / merge.started`; recovery rate after `merge.failed` | Immutable merge events already support starts, completions, failures, and causal linkage for the immediate attempt; Member `merge_state` is the current guard. | Near zero. A merge can complete mechanically and still fail verification. Report verification outcome separately. |

### Mechanism Effectiveness

Mechanism metrics answer both adoption and conditional value. For mechanism
`M`, report `adoption(M) = eligible Teams using M / eligible Teams` and compare
matched outcome, time, cost, and failure distributions for `M` used versus not
used. Do not rank mechanisms by invocation count.

| Mechanism | Usage and effectiveness measures | Source and missing evidence | Main pitfall |
|---|---|---|---|
| Task DAG and ready frontier | DAG adoption; blocked-to-ready latency; critical-path ratio; duplicate-claim prevention incidents | Task `depends_on`, statuses, and `task.created/claimed/unblocked/completed` exist. **Missing:** claim-conflict and invalid-dependency counters, all release/reclaim events, active spans. | Complex work selects into DAG usage, so raw completion rates will make DAGs look worse. |
| Structured progress, result, blocker, and Lead Brief | Structured-message adoption; blocker resolution latency; Lead context bytes avoided; result-to-completion atomicity failures | Message bodies can be parsed today, and Lead Brief is persisted, but analytics should not scan bodies by default. **Missing:** content-free message kind, task ID, byte count, projection/replacement relation, and brief size/update counters. | Message count rewards chatter. Measure resolved blockers and bounded context, not volume. |
| Plan approval | Eligible risky-writer adoption; rejection/revision count; post-approval rework and verified outcome | `plan.approved/rejected` events and Member `plan_approval` exist. **Missing:** eligibility/risk label, revision correlation, decision latency, and post-approval correction relation. | Plan approval is intentionally selected for risky work; compare within risk strata. |
| Technical consultation | Adoption by eligible blocked task; answer/escalation latency; resolution without Lead interruption; downstream rework | Append-only requested/resolved/escalated events now carry only opaque consultation/task/member IDs. **Missing:** consumed events and eligibility reason. | Consultations may increase elapsed time while preventing larger rework. |
| Worktree isolation and explicit merge | Writer isolation adoption; merge success; overlap-block incidents; preserved-work recovery; integration time | Worktree/branch and merge state persist; merge lifecycle events exist. **Missing:** writer/read-only declaration event, overlap-block event, preservation events, integration verification result. | Read-only members correctly use no worktree. Never use all Members as the denominator. |
| `resume_from`, model fallback, and abort recovery | Recovery mechanism adoption; recovered completion rate; duplicated-work cost; recovery latency | Versioned retry-attempt/fallback/exhaustion, recovery-stage, and predecessor-successor events provide partial sequence evidence without Session, model, branch, path, or error strings. **Missing:** shared incident ID, preserved context byte count, and verified terminal disposition. | These mechanisms activate after failure. Compare recovery options within incident type, not against healthy Members. |
| Risk-triggered review and terminal verification | Eligible-risk review adoption; defect catch rate; escaped defect rate; review/verification time | **Missing:** risk class, Reviewer assignment, finding severity/disposition, verification commands/results, and final outcome. Profiles alone do not prove a review occurred. | More findings may mean better detection or worse inputs. Pair catch rate with escaped defects and first-pass acceptance. |

## Collection Plan

Prefer allowlisted, append-only events with identifiers, timestamps, enum reason
codes, counts, durations, and byte sizes. Keep `team_event` observational and
out of runtime decision paths, matching its current contract in
`src/schema.ts` and `src/team-event.ts`. Never backfill synthetic events from a
latest-state snapshot.

Collection tiers:

1. **Always-on, low cost:** Team/Task/Member transitions, incident and recovery
   stages, mechanism usage, aggregate numeric usage, and instrumentation
   version. Outcome labels, model ID, workflow kind, and complexity band remain
   owner-supplied or unavailable. Emit only on a
   real state transition; estimated storage is tens to low hundreds of rows per
   Team.
2. **Sampled diagnostics:** 5-10% of Teams, stratified by workflow and failure
   state, may retain tool-name counts, per-step latency histograms, and bounded
   error categories. Increase incident sampling temporarily with an explicit
   expiry.
3. **Explicit investigation only:** raw messages, prompts, commands, tool
   inputs/outputs, diffs, and session transcripts. Keep these outside metrics
   storage and require a separate, auditable user-approved path.

Every aggregate must expose `sample_size`, `unknown_count`, `censored_count`,
`coverage_start`, `coverage_end`, and `instrumentation_version`. Retain current
Team events until explicit purge. Cross-Team rollups should use the same
retention boundary or irreversible daily aggregates that cannot reconstruct a
small Team.

## Privacy and Access

Metrics collection must not persist or return reasoning, full prompts, message
bodies, response text, tool inputs or outputs, shell commands, file paths,
file contents, diffs, consultation questions/replies, or raw runtime errors by
default. These fields already exist in `ActivityEntry`, `team_message`, Member
prompt state, and SDK session history, but their operational availability does
not make them analytics data.

Allowlisted metric payloads may contain opaque Team/Task/Member IDs, enum
states and reasons, timestamps, token counts, dollar cost, model/provider ID,
byte counts, and boolean mechanism flags. Hashing sensitive text is not safe
anonymization because low-entropy values can be guessed. Suppress groups with
fewer than five Teams in project-wide comparisons and omit free-text labels.

An occasional analysis agent receives `team_metrics`, not database access or
`session.messages`. It should start with aggregates, request bounded event
timelines only for identified operational anomalies, state uncertainty, and
never attempt to infer hidden reasoning or employee performance.

## Future `team_metrics` Tool

The tool is read-only and aggregate-first. It cannot mutate Team state, fetch
session content, accept SQL, or return stored text fields.

```ts
team_metrics({
  scope: { project?: string; team_ids?: string[] },
  window: { from: string; to: string },
  filters?: {
    workflow_kind?: string[],
    status?: string[],
    profile?: string[],
    model?: string[],
    mechanism?: string[],
    complexity_band?: string[],
    instrumentation_version?: string[],
  },
  view: "summary" | "funnel" | "timeline" | "compare",
  metrics: string[],
  group_by?: "day" | "week" | "workflow_kind" | "profile" | "model" | "mechanism" | "complexity_band",
  compare?: { dimension: "execution_mode" | "mechanism" | "model"; values: [string, string] },
  percentile?: 50 | 90 | 95,
  limit?: number,
  cursor?: string,
})
```

Contract rules:

- Authorize the caller against the requested project and explicit Team set.
- Default to completed cohorts in the last 30 days, UTC, with `limit <= 100`.
- Return metric definitions, units, numerator, denominator, unknown/censored
  counts, sampling rate, coverage, and instrumentation version with every view.
- `summary` returns aggregate values; `funnel` returns ordered lifecycle counts;
  `compare` returns matched strata and uncertainty; `timeline` returns only
  allowlisted event kinds, opaque IDs, enum payloads, and timestamps for at
  most ten explicit Teams.
- Apply small-cell suppression before pagination. Reject free-text search,
  arbitrary grouping, reasoning fields, raw messages, prompts, tool payloads,
  commands, file data, and error text.

Example aggregate request:

```json
{
  "scope": { "project": "opencode-ensemble" },
  "window": { "from": "2026-05-01T00:00:00Z", "to": "2026-08-01T00:00:00Z" },
  "view": "compare",
  "metrics": ["verified_outcome_rate", "cycle_time_ms_p50", "cost_per_verified_outcome"],
  "filters": { "workflow_kind": ["delivery"] },
  "compare": { "dimension": "mechanism", "values": ["plan_approval", "none"] },
  "group_by": "complexity_band"
}
```

```json
{
  "view": "compare",
  "cohort": { "eligible": 84, "unknown": 7, "censored": 3 },
  "groups": [
    { "key": "plan_approval", "n": 41, "verified_outcome_rate": { "value": 0.88, "numerator": 36, "denominator": 41 } },
    { "key": "none", "n": 43, "verified_outcome_rate": { "value": 0.81, "numerator": 35, "denominator": 43 } }
  ],
  "warning": "Observational comparison; risk-stratified, not causal.",
  "coverage": { "sampling_rate": 1, "instrumentation_version": ["2"] }
}
```

Example incident inspection:

```json
{
  "scope": { "team_ids": ["team_opaque_id"] },
  "window": { "from": "2026-07-31T00:00:00Z", "to": "2026-08-02T00:00:00Z" },
  "view": "timeline",
  "metrics": ["recovery_incidents", "recovery_latency_ms"],
  "filters": { "status": ["failed", "timed_out"] },
  "limit": 50
}
```

The response may show `member.failure_detected`,
`branch.preservation_succeeded`, `member.replacement_started`, and
`task.completed` with timestamps and opaque correlation IDs. It must not show
the Member prompt, error text, preserved branch name, task content, or session
messages.

## Evidence Map

- `src/schema.ts`: persistent Team, Member, Task, Message, retry, merge,
  consultation, Lead Brief, and immutable `team_event` fields and retention.
- `src/team-event.ts`: versioned allowlisted event kinds, typed value validators,
  2 KiB payload ceiling, append-only insertion, and best-effort observation helper.
- `src/telemetry.ts`: aggregate-only numeric usage collection and transaction-
  coupled Member transition/task release helpers.
- `src/activity.ts`: in-memory rolling tokens, cost, tool activity, reasoning,
  text, commands, and file data; the buffer is capped per session.
- `src/dashboard.ts`: on-demand SDK session/message fallback, demonstrating why
  dashboard visibility must not become default analytics collection.
- `src/tools/team-tasks-complete.ts`: atomic Task completion, terminal result
  message, Member completion, and dependent Task unblocking.
- `src/tools/team-merge.ts` and `src/tools/team-cleanup.ts`: merge lifecycle,
  explicit integration requirement, archival boundary, and archive-time
  message consumption.
- `src/retry-breaker.ts`, `src/safe-abort-recovery.ts`, `src/watchdog.ts`, and
  `src/terminal-liveness.ts`: retry, fallback, timeout, recovery, preservation,
  and late-terminal mechanisms that need reason-coded incident telemetry.
- `docs/roadmap.md`: Core Ensemble is domain-agnostic; Delivery Run owns
  software-specific verification and shipping evidence.
