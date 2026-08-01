import type { Database } from "./db"
import type { MemberRegistry } from "./state"

const MAX_LIMIT = 100
const MAX_METRICS = 20
const MAX_FILTER_VALUES = 20
const MAX_TIMELINE_TEAMS = 10
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,127}$/
const DIMENSION_VALUE = /^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,127}$/
const TELEMETRY_VERSION = 1

const METRIC_DEFINITIONS: Record<string, { definition: string; unit: string }> = {
  cycle_time_ms_p50: { definition: "Median elapsed time from team.created to team.archived", unit: "milliseconds" },
  cycle_time_ms_p90: { definition: "90th percentile elapsed time from team.created to team.archived", unit: "milliseconds" },
  team_created: { definition: "Distinct Teams with a team.created event", unit: "Teams" },
  team_archived: { definition: "Distinct Teams with a team.archived event", unit: "Teams" },
  member_registered: { definition: "Member registration event count", unit: "events" },
  task_created: { definition: "Task creation event count", unit: "events" },
  task_claimed: { definition: "Task claim event count", unit: "events" },
  task_completed: { definition: "Task completion event count", unit: "events" },
  merge_started: { definition: "Mechanical merge start event count", unit: "events" },
  merge_completed: { definition: "Mechanical merge completion event count", unit: "events" },
  merge_failed: { definition: "Mechanical merge failure event count", unit: "events" },
  merge_reliability: { definition: "Mechanical merge completions divided by starts", unit: "ratio" },
  plan_approval_adoption: { definition: "Teams with plan approval divided by observable eligible Teams", unit: "ratio" },
  consultation_adoption: { definition: "Teams with a consultation divided by telemetry-v1 eligible Teams", unit: "ratio" },
  retry_observed: { definition: "Distinct retry observation event count", unit: "events" },
  retry_fallback: { definition: "Retry fallback event count", unit: "events" },
  retry_exhausted: { definition: "Retry exhaustion event count", unit: "events" },
  recovery_incidents: { definition: "Telemetry-v1 Teams with recovery-stage evidence", unit: "Teams" },
  resume_adoption: { definition: "Teams with resume linkage divided by telemetry-v1 eligible Teams", unit: "ratio" },
  input_tokens: { definition: "Exact covered input-token aggregate for Teams whose aggregate span is contained in the request window", unit: "tokens" },
  output_tokens: { definition: "Exact covered output-token aggregate for Teams whose aggregate span is contained in the request window", unit: "tokens" },
  usage_cost: { definition: "Exact covered model-cost aggregate for Teams whose aggregate span is contained in the request window", unit: "cost units" },
  verified_outcome_rate: { definition: "Requires explicit terminal outcome instrumentation", unit: "ratio" },
  critical_path_task_time: { definition: "Requires active task spans", unit: "milliseconds" },
  parallelism_utilization: { definition: "Requires member execution spans", unit: "ratio" },
  coordination_wait_share: { definition: "Requires mutually exclusive wait spans", unit: "ratio" },
  cost_per_verified_outcome: { definition: "Requires verified outcomes and durable usage coverage", unit: "cost units per Team" },
  first_pass_acceptance: { definition: "Requires verification and rework instrumentation", unit: "ratio" },
  outcome_lift_baseline: { definition: "Requires matched baseline identity and outcomes", unit: "ratio" },
  team_completion_reliability: { definition: "Requires explicit terminal outcome instrumentation", unit: "ratio" },
  member_failure_rate: { definition: "Requires one durable terminal incident per Member", unit: "ratio" },
}

const UNSUPPORTED = new Set([
  "verified_outcome_rate", "critical_path_task_time", "parallelism_utilization", "coordination_wait_share",
  "cost_per_verified_outcome", "first_pass_acceptance", "outcome_lift_baseline", "team_completion_reliability", "member_failure_rate",
])
const TELEMETRY_V1_METRICS = new Set([
  "plan_approval_adoption", "consultation_adoption", "retry_observed", "retry_fallback", "retry_exhausted", "recovery_incidents",
  "resume_adoption", "input_tokens", "output_tokens", "usage_cost",
])
const MECHANISMS = new Set(["plan_approval", "technical_consultation", "model_fallback", "abort_recovery", "resume_from"])
const TELEMETRY_V1_MECHANISMS = new Set(["technical_consultation", "model_fallback", "abort_recovery", "resume_from"])
const FILTER_STATUSES = new Set([
  "active", "archived", "ready", "busy", "shutdown_requested", "shutdown", "error", "idle", "starting", "running",
  "cancel_requested", "cancelling", "cancelled", "completing", "completed", "failed", "timed_out",
])
const GROUP_BY = new Set(["day", "week", "workflow_kind", "profile", "model", "mechanism", "complexity_band"])
const EVENT_KINDS = new Set([
  "team.created", "team.archived", "task.created", "task.claimed", "task.completed", "task.unblocked", "task.released",
  "member.registered", "member.transitioned", "plan.approved", "plan.rejected", "merge.started", "merge.completed", "merge.failed",
  "consultation.requested", "consultation.resolved", "consultation.escalated", "retry.observed", "retry.fallback", "retry.exhausted",
  "recovery.stage", "resume.linked",
])
const TIMELINE_ENUMS: Record<string, Set<string>> = {
  status: new Set(["pending", "blocked"]),
  from_status: new Set(["ready", "busy", "shutdown_requested", "shutdown", "error"]),
  to_status: new Set(["ready", "busy", "shutdown_requested", "shutdown", "error"]),
  from_execution: new Set(["idle", "starting", "running", "cancel_requested", "cancelling", "cancelled", "completing", "completed", "failed", "timed_out"]),
  to_execution: new Set(["idle", "starting", "running", "cancel_requested", "cancelling", "cancelled", "completing", "completed", "failed", "timed_out"]),
  reason: new Set(["spawn_rollback", "session_error", "retry_exhausted", "timeout", "startup_recovery", "shutdown", "force_cleanup", "session_status", "task_completed"]),
  mechanism: new Set(["startup", "safe_abort", "watchdog", "late_terminal"]),
  stage: new Set(["detected", "claimed", "preserved", "settled", "failed", "prompted", "reaborted"]),
}

export interface TeamMetricsRequest {
  scope?: { project?: string; team_ids?: string[] }
  window?: { from?: string; to?: string }
  filters?: {
    workflow_kind?: string[]
    status?: string[]
    profile?: string[]
    model?: string[]
    mechanism?: string[]
    complexity_band?: string[]
    instrumentation_version?: string[]
  }
  view: "summary" | "funnel" | "timeline" | "compare"
  metrics: string[]
  group_by?: "day" | "week" | "workflow_kind" | "profile" | "model" | "mechanism" | "complexity_band"
  compare?: { dimension: "execution_mode" | "mechanism" | "model"; values: string[] }
  limit?: number
  cursor?: string
}

interface TimeWindow {
  from: number
  to: number
  fromIso: string
  toIso: string
}

interface Coverage {
  sample_size: number
  numerator: number
  denominator: number
  unknown: number
  censored: number
  coverage_start: string | null
  coverage_end: string | null
  sampling_rate: number
  instrumentation_version: number[]
}

interface AuthorizedScope {
  projectId: string
  teamIds: string[]
  explicit: boolean
}

interface MetricValue {
  value: number | null
  numerator: number
  denominator: number
  sampleSize: number
  unknown: number
  censored: number
}

interface Page<T> {
  values: T[]
  nextCursor?: string
}

function fail(): never {
  throw new Error("Metrics request is invalid or outside caller scope")
}

function parseWindow(window?: TeamMetricsRequest["window"]): TimeWindow {
  const to = window?.to ?? new Date().toISOString()
  const from = window?.from ?? new Date(Date.parse(to) - 30 * 24 * 60 * 60 * 1000).toISOString()
  if (!UTC_ISO.test(from) || !UTC_ISO.test(to) || from !== new Date(Date.parse(from)).toISOString() || to !== new Date(Date.parse(to)).toISOString()) fail()
  const fromMs = Date.parse(from)
  const toMs = Date.parse(to)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs || toMs - fromMs > MAX_WINDOW_MS) fail()
  return { from: fromMs, to: toMs, fromIso: from, toIso: to }
}

function placeholders(values: string[]): string {
  return values.map(() => "?").join(", ") || "NULL"
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = values.toSorted((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[index] ?? null
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString()
}

function authorize(db: Database, _registry: MemberRegistry, sessionId: string, request: TeamMetricsRequest): AuthorizedScope {
  const identities = db.query(
    `SELECT id, project_id, 'lead' AS role FROM team WHERE lead_session_id = ?
     UNION ALL
     SELECT t.id, t.project_id, 'member' AS role
     FROM team_member tm JOIN team t ON t.id = tm.team_id WHERE tm.session_id = ?`,
  ).all(sessionId, sessionId) as Array<{ id: string; project_id: string; role: "lead" | "member" }>
  if (identities.length === 0) fail()
  const leadRows = identities.filter(row => row.role === "lead")
  const roleRows = leadRows.length > 0 ? leadRows : identities.filter(row => row.role === "member")
  const projectIds = [...new Set(roleRows.map(row => row.project_id))]
  if (projectIds.length !== 1) fail()
  const projectId = projectIds[0]
  if (!projectId) fail()
  const requestedProject = request.scope?.project
  if (requestedProject) {
    const project = db.query("SELECT id FROM project WHERE id = ? OR name = ? OR slug = ?").get(requestedProject, requestedProject, requestedProject) as { id: string } | null
    if (!project || project.id !== projectId) fail()
  }
  const requested = request.scope?.team_ids
  if (requested && (requested.length === 0 || requested.length > MAX_LIMIT || new Set(requested).size !== requested.length || requested.some(id => !IDENTIFIER.test(id)))) fail()
  if (request.view === "timeline" && (!requested || requested.length > MAX_TIMELINE_TEAMS)) fail()
  if (leadRows.length === 0) {
    const ownIds = [...new Set(roleRows.map(row => row.id))]
    if (ownIds.length !== 1) fail()
    if (requested && (requested.length !== 1 || requested[0] !== ownIds[0])) fail()
    return { projectId, teamIds: ownIds, explicit: Boolean(requested) }
  }
  const rows = requested
    ? db.query(`SELECT id FROM team WHERE project_id = ? AND id IN (${placeholders(requested)})`).all(projectId, ...requested) as Array<{ id: string }>
    : db.query("SELECT id FROM team WHERE project_id = ? ORDER BY id").all(projectId) as Array<{ id: string }>
  if (requested && rows.length !== requested.length) fail()
  return { projectId, teamIds: rows.map(row => row.id), explicit: Boolean(requested) }
}

function createdCohort(db: Database, scope: AuthorizedScope, window: TimeWindow, version?: number): string[] {
  if (scope.teamIds.length === 0) return []
  const versionClause = version === undefined ? "" : " AND instrumentation_version = ?"
  const params: unknown[] = [...scope.teamIds, window.from, window.to]
  if (version !== undefined) params.push(version)
  const rows = db.query(
    `SELECT DISTINCT team_id FROM team_event
     WHERE kind = 'team.created' AND team_id IN (${placeholders(scope.teamIds)})
       AND time_created >= ? AND time_created <= ?${versionClause}
     ORDER BY team_id`,
  ).all(...params) as Array<{ team_id: string }>
  return rows.map(row => row.team_id)
}

function validateFilterValues(values: string[] | undefined, allowed?: Set<string>): void {
  if (!values) return
  if (values.length === 0 || values.length > MAX_FILTER_VALUES || new Set(values).size !== values.length) fail()
  if (values.some(value => !DIMENSION_VALUE.test(value) || (allowed && !allowed.has(value)))) fail()
}

function assertRequestShape(request: TeamMetricsRequest): void {
  const allowedKeys = new Set(["scope", "window", "filters", "view", "metrics", "group_by", "compare", "limit", "cursor"])
  if (Object.keys(request).some(key => !allowedKeys.has(key))) fail()
  if (request.scope && Object.keys(request.scope).some(key => key !== "project" && key !== "team_ids")) fail()
  if (request.window && Object.keys(request.window).some(key => key !== "from" && key !== "to")) fail()
  if (request.compare && Object.keys(request.compare).some(key => key !== "dimension" && key !== "values")) fail()
}

function intersectTeams(db: Database, teamIds: string[], sql: string, params: unknown[]): string[] {
  if (teamIds.length === 0) return []
  const rows = db.query(
    `SELECT DISTINCT t.id FROM team t WHERE t.id IN (${placeholders(teamIds)}) AND (${sql}) ORDER BY t.id`,
  ).all(...teamIds, ...params) as Array<{ id: string }>
  return rows.map(row => row.id)
}

function applyFilters(db: Database, scope: AuthorizedScope, filters: TeamMetricsRequest["filters"], window: TimeWindow): AuthorizedScope {
  if (!filters) return scope
  const allowedKeys = new Set(["workflow_kind", "status", "profile", "model", "mechanism", "complexity_band", "instrumentation_version"])
  if (Object.keys(filters).some(key => !allowedKeys.has(key))) fail()
  const mechanisms = filters.mechanism
  const versions = filters.instrumentation_version
  validateFilterValues(filters.workflow_kind)
  validateFilterValues(filters.status, FILTER_STATUSES)
  validateFilterValues(filters.profile)
  validateFilterValues(filters.model)
  validateFilterValues(mechanisms, MECHANISMS)
  validateFilterValues(filters.complexity_band)
  validateFilterValues(versions)
  if (versions?.some(value => !/^\d+$/.test(value))) fail()
  let teamIds = scope.teamIds
  // These owner-supplied dimensions are not persisted yet. Unknown rows never
  // silently satisfy a requested value.
  if (filters.workflow_kind || filters.complexity_band) teamIds = []
  if (filters.status) {
    teamIds = intersectTeams(db, teamIds,
      `t.status IN (${placeholders(filters.status)}) OR EXISTS (
        SELECT 1 FROM team_member tm WHERE tm.team_id = t.id
          AND (tm.status IN (${placeholders(filters.status)}) OR tm.execution_status IN (${placeholders(filters.status)}))
      )`, [...filters.status, ...filters.status, ...filters.status])
  }
  if (filters.profile) {
    teamIds = intersectTeams(db, teamIds,
      `EXISTS (SELECT 1 FROM team_member tm WHERE tm.team_id = t.id AND tm.profile IN (${placeholders(filters.profile)}))`,
      filters.profile)
  }
  if (filters.model) {
    teamIds = intersectTeams(db, teamIds,
      `EXISTS (SELECT 1 FROM team_member tm WHERE tm.team_id = t.id AND tm.model IN (${placeholders(filters.model)}))`,
      filters.model)
  }
  if (mechanisms && teamIds.length > 0) {
    const kinds = [...new Set(mechanisms.flatMap(mechanismEventKinds))]
    const rows = db.query(
      `SELECT DISTINCT team_id FROM team_event
       WHERE team_id IN (${placeholders(teamIds)}) AND kind IN (${placeholders(kinds)})
         AND time_created >= ? AND time_created <= ?`,
    ).all(...teamIds, ...kinds, window.from, window.to) as Array<{ team_id: string }>
    teamIds = rows.map(row => row.team_id)
  }
  if (versions && teamIds.length > 0) {
    const rows = db.query(
      `SELECT DISTINCT team_id FROM team_event
       WHERE kind = 'team.created' AND team_id IN (${placeholders(teamIds)}) AND instrumentation_version IN (${placeholders(versions)})
          AND time_created >= ? AND time_created <= ?`,
    ).all(...teamIds, ...versions.map(Number), window.from, window.to) as Array<{ team_id: string }>
    teamIds = rows.map(row => row.team_id)
  }
  return { ...scope, teamIds }
}

function baseCoverage(db: Database, scope: AuthorizedScope, window: TimeWindow): Coverage {
  const cohort = createdCohort(db, scope, window)
  const versioned = createdCohort(db, scope, window, TELEMETRY_VERSION)
  if (cohort.length === 0) {
    return { sample_size: 0, numerator: 0, denominator: 0, unknown: 0, censored: 0, coverage_start: null, coverage_end: null, sampling_rate: 0, instrumentation_version: [] }
  }
  const eventSummary = db.query(
    `SELECT MIN(time_created) AS first, MAX(time_created) AS last
     FROM team_event WHERE team_id IN (${placeholders(cohort)}) AND time_created >= ? AND time_created <= ?`,
  ).get(...cohort, window.from, window.to) as { first: number | null; last: number | null }
  const archived = (db.query(
    `SELECT COUNT(DISTINCT team_id) AS count FROM team_event
     WHERE kind = 'team.archived' AND team_id IN (${placeholders(cohort)}) AND time_created >= ? AND time_created <= ?`,
  ).get(...cohort, window.from, window.to) as { count: number }).count
  const versions = db.query(
    `SELECT DISTINCT instrumentation_version AS version FROM team_event
     WHERE team_id IN (${placeholders(cohort)}) AND time_created >= ? AND time_created <= ?
       AND instrumentation_version IS NOT NULL ORDER BY version`,
  ).all(...cohort, window.from, window.to) as Array<{ version: number }>
  return {
    sample_size: cohort.length,
    numerator: archived,
    denominator: cohort.length,
    unknown: cohort.length - versioned.length,
    censored: cohort.length - archived,
    coverage_start: iso(eventSummary.first),
    coverage_end: iso(eventSummary.last),
    sampling_rate: cohort.length === 0 ? 0 : versioned.length / cohort.length,
    instrumentation_version: versions.map(row => row.version),
  }
}

function countEvents(db: Database, teamIds: string[], window: TimeWindow, kinds: string[], distinctTeams = false): number {
  if (teamIds.length === 0) return 0
  const selection = distinctTeams ? "COUNT(DISTINCT team_id)" : "COUNT(*)"
  return (db.query(
    `SELECT ${selection} AS count FROM team_event
     WHERE team_id IN (${placeholders(teamIds)}) AND kind IN (${placeholders(kinds)})
       AND time_created >= ? AND time_created <= ?`,
  ).get(...teamIds, ...kinds, window.from, window.to) as { count: number }).count
}

function eligibleMetricTeams(db: Database, scope: AuthorizedScope, window: TimeWindow, metric: string): { all: string[]; eligible: string[] } {
  const all = createdCohort(db, scope, window)
  const eligible = TELEMETRY_V1_METRICS.has(metric) ? createdCohort(db, scope, window, TELEMETRY_VERSION) : all
  return { all, eligible }
}

function cycleDurations(db: Database, teamIds: string[], window: TimeWindow): number[] {
  if (teamIds.length === 0) return []
  const rows = db.query(
    `SELECT team_id, kind, time_created FROM team_event
     WHERE team_id IN (${placeholders(teamIds)}) AND kind IN ('team.created', 'team.archived')
       AND time_created >= ? AND time_created <= ? ORDER BY team_id, time_created, id`,
  ).all(...teamIds, window.from, window.to) as Array<{ team_id: string; kind: string; time_created: number }>
  const starts = new Map<string, number>()
  const completed = new Set<string>()
  const durations: number[] = []
  for (const row of rows) {
    if (row.kind === "team.created" && !starts.has(row.team_id)) starts.set(row.team_id, row.time_created)
    if (row.kind !== "team.archived" || completed.has(row.team_id)) continue
    const start = starts.get(row.team_id)
    if (start === undefined || row.time_created < start) continue
    completed.add(row.team_id)
    durations.push(row.time_created - start)
  }
  return durations
}

function usageValue(db: Database, all: string[], eligible: string[], window: TimeWindow, metric: string): MetricValue {
  if (eligible.length === 0) return { value: null, numerator: 0, denominator: all.length, sampleSize: 0, unknown: all.length, censored: 0 }
  const column = metric === "input_tokens" ? "input_tokens" : metric === "output_tokens" ? "output_tokens" : "cost"
  const rows = db.query(
    `SELECT team_id, SUM(${column}) AS value, MIN(coverage_start) AS first, MAX(coverage_end) AS last
     FROM team_usage_aggregate WHERE team_id IN (${placeholders(eligible)})
     GROUP BY team_id HAVING MIN(coverage_start) >= ? AND MAX(coverage_end) <= ?`,
  ).all(...eligible, window.from, window.to) as Array<{ team_id: string; value: number; first: number; last: number }>
  const value = rows.length === 0 ? null : rows.reduce((sum, row) => sum + row.value, 0)
  return { value, numerator: rows.length, denominator: all.length, sampleSize: rows.length, unknown: all.length - rows.length, censored: 0 }
}

function metricValue(db: Database, scope: AuthorizedScope, window: TimeWindow, metric: string): MetricValue {
  const { all, eligible } = eligibleMetricTeams(db, scope, window, metric)
  const v1Unknown = all.length - eligible.length
  if (UNSUPPORTED.has(metric)) return { value: null, numerator: 0, denominator: 0, sampleSize: 0, unknown: 0, censored: 0 }
  if (metric === "cycle_time_ms_p50" || metric === "cycle_time_ms_p90") {
    const values = cycleDurations(db, all, window)
    return { value: percentile(values, metric.endsWith("p50") ? 50 : 90), numerator: values.length, denominator: all.length, sampleSize: values.length, unknown: 0, censored: all.length - values.length }
  }
  if (metric === "team_created" || metric === "team_archived") {
    const count = metric === "team_created" ? all.length : countEvents(db, all, window, ["team.archived"], true)
    return { value: count, numerator: count, denominator: all.length, sampleSize: all.length, unknown: 0, censored: metric === "team_archived" ? all.length - count : 0 }
  }
  if (metric === "plan_approval_adoption" || metric === "consultation_adoption" || metric === "resume_adoption" || metric === "recovery_incidents") {
    const kinds = metric === "plan_approval_adoption" ? ["plan.approved", "plan.rejected"] : metric === "consultation_adoption" ? ["consultation.requested"] : metric === "resume_adoption" ? ["resume.linked"] : ["recovery.stage"]
    const count = countEvents(db, eligible, window, kinds, true)
    const value = metric === "recovery_incidents" ? count : eligible.length === 0 ? null : count / eligible.length
    return { value, numerator: count, denominator: eligible.length, sampleSize: eligible.length, unknown: v1Unknown, censored: 0 }
  }
  if (metric === "merge_reliability") {
    const started = countEvents(db, eligible, window, ["merge.started"])
    const completed = countEvents(db, eligible, window, ["merge.completed"])
    return { value: started === 0 ? null : completed / started, numerator: completed, denominator: started, sampleSize: eligible.length, unknown: v1Unknown, censored: 0 }
  }
  if (metric === "input_tokens" || metric === "output_tokens" || metric === "usage_cost") return usageValue(db, all, eligible, window, metric)
  const eventMap: Record<string, string> = {
    member_registered: "member.registered", task_created: "task.created", task_claimed: "task.claimed",
    task_completed: "task.completed", merge_started: "merge.started", merge_completed: "merge.completed",
    merge_failed: "merge.failed", retry_observed: "retry.observed", retry_fallback: "retry.fallback", retry_exhausted: "retry.exhausted",
  }
  const kind = eventMap[metric]
  if (!kind) fail()
  const count = countEvents(db, eligible, window, [kind])
  return { value: count, numerator: count, denominator: eligible.length, sampleSize: eligible.length, unknown: v1Unknown, censored: 0 }
}

function metricResponse(db: Database, scope: AuthorizedScope, window: TimeWindow, metric: string): Record<string, unknown> {
  const definition = METRIC_DEFINITIONS[metric]
  if (!definition) fail()
  const value = metricValue(db, scope, window, metric)
  const coverage = baseCoverage(db, scope, window)
  return {
    metric,
    ...definition,
    value: value.value,
    numerator: value.numerator,
    denominator: value.denominator,
    sample_size: value.sampleSize,
    unknown: value.unknown,
    censored: value.censored,
    coverage_start: coverage.coverage_start,
    coverage_end: coverage.coverage_end,
    sampling_rate: coverage.sampling_rate,
    instrumentation_version: coverage.instrumentation_version,
    ...(UNSUPPORTED.has(metric) ? { supported: false, unsupported_reason: definition.definition } : { supported: true }),
  }
}

function metricUncertainty(metric: Record<string, unknown>): Record<string, unknown> {
  if (metric.supported !== true || metric.unit !== "ratio") {
    return { method: "not_estimable", reason: metric.supported === true ? "metric is not a ratio" : "metric is unsupported" }
  }
  const numerator = metric.numerator
  const denominator = metric.denominator
  if (typeof numerator !== "number" || typeof denominator !== "number" || denominator <= 0) {
    return { method: "wilson_95", confidence: 0.95, lower: null, upper: null }
  }
  if (numerator < 0 || numerator > denominator) {
    return { method: "not_estimable", reason: "metric is not a binomial proportion" }
  }
  const z = 1.959963984540054
  const observed = numerator / denominator
  const denominatorAdjustment = 1 + (z * z) / denominator
  const center = (observed + (z * z) / (2 * denominator)) / denominatorAdjustment
  const spread = z * Math.sqrt((observed * (1 - observed) + (z * z) / (4 * denominator)) / denominator) / denominatorAdjustment
  return { method: "wilson_95", confidence: 0.95, lower: Math.max(0, center - spread), upper: Math.min(1, center + spread) }
}

function comparisonMetricResponses(db: Database, scope: AuthorizedScope, window: TimeWindow, metrics: string[]): Array<Record<string, unknown>> {
  return metrics.map(metric => {
    const response = metricResponse(db, scope, window, metric)
    return { ...response, uncertainty: metricUncertainty(response) }
  })
}

function safeTimelinePayload(raw: string): Record<string, unknown> {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return {} }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if ((key === "task_id" || key === "consultation_id") && typeof value === "string" && IDENTIFIER.test(value)) result[key] = value
    else if ((key === "attempt" || key === "attempts") && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) result[key] = value
    else if (key === "context_truncated" && typeof value === "boolean") result[key] = value
    else if (typeof value === "string" && TIMELINE_ENUMS[key]?.has(value)) result[key] = value
  }
  return result
}

function timeline(db: Database, scope: AuthorizedScope, window: TimeWindow, limit: number): Record<string, unknown> {
  if (!scope.explicit || scope.teamIds.length === 0 || scope.teamIds.length > MAX_TIMELINE_TEAMS) fail()
  const rows = db.query(
    `SELECT id, team_id, kind, payload, cause_event_id, time_created FROM team_event
     WHERE team_id IN (${placeholders(scope.teamIds)}) AND time_created >= ? AND time_created <= ?
     ORDER BY time_created ASC, id ASC LIMIT ?`,
  ).all(...scope.teamIds, window.from, window.to, limit) as Array<{ id: string; team_id: string; kind: string; payload: string; cause_event_id: string | null; time_created: number }>
  const events = rows.flatMap(row => {
    if (!EVENT_KINDS.has(row.kind) || !IDENTIFIER.test(row.id) || !IDENTIFIER.test(row.team_id)) return []
    return [{
      id: row.id,
      team_id: row.team_id,
      kind: row.kind,
      time: new Date(row.time_created).toISOString(),
      payload: safeTimelinePayload(row.payload),
      ...(row.cause_event_id && IDENTIFIER.test(row.cause_event_id) ? { cause_event_id: row.cause_event_id } : {}),
    }]
  })
  return { events, limit }
}

function mechanismEventKinds(value: string): string[] {
  if (value === "plan_approval") return ["plan.approved", "plan.rejected"]
  if (value === "technical_consultation") return ["consultation.requested"]
  if (value === "model_fallback") return ["retry.fallback"]
  if (value === "abort_recovery") return ["recovery.stage"]
  if (value === "resume_from") return ["resume.linked"]
  fail()
}

function compareEligibleTeams(db: Database, scope: AuthorizedScope, window: TimeWindow, mechanism: string): string[] {
  return (mechanism === "plan_approval" || TELEMETRY_V1_MECHANISMS.has(mechanism))
    ? createdCohort(db, scope, window, TELEMETRY_VERSION)
    : createdCohort(db, scope, window)
}

function teamsWithMechanism(db: Database, eligible: string[], window: TimeWindow, mechanism: string): Set<string> {
  if (eligible.length === 0) return new Set()
  const kinds = mechanismEventKinds(mechanism)
  const rows = db.query(
    `SELECT DISTINCT team_id FROM team_event
     WHERE team_id IN (${placeholders(eligible)}) AND kind IN (${placeholders(kinds)})
       AND time_created >= ? AND time_created <= ?`,
  ).all(...eligible, ...kinds, window.from, window.to) as Array<{ team_id: string }>
  return new Set(rows.map(row => row.team_id))
}

function dimensionCohorts(
  db: Database,
  scope: AuthorizedScope,
  window: TimeWindow,
  comparison: NonNullable<TeamMetricsRequest["compare"]>,
): { eligible: string[]; groups: Map<string, string[]>; unknown: number } {
  if (comparison.dimension === "execution_mode") {
    const eligible = createdCohort(db, scope, window, TELEMETRY_VERSION)
    return { eligible, groups: new Map(comparison.values.map(value => [value, []])), unknown: eligible.length }
  }
  if (comparison.dimension === "model") {
    const eligible = createdCohort(db, scope, window, TELEMETRY_VERSION)
    const groups = new Map(comparison.values.map(value => [value, [] as string[]]))
    if (eligible.length > 0) {
      const rows = db.query(
        `SELECT DISTINCT team_id, model FROM team_member
         WHERE team_id IN (${placeholders(eligible)}) AND model IS NOT NULL ORDER BY team_id, model`,
      ).all(...eligible) as Array<{ team_id: string; model: string }>
      const modelsByTeam = new Map<string, string[]>()
      rows.forEach(row => {
        modelsByTeam.set(row.team_id, [...(modelsByTeam.get(row.team_id) ?? []), row.model])
      })
      modelsByTeam.forEach((models, teamId) => {
        if (models.length === 1) groups.get(models[0] as string)?.push(teamId)
      })
    }
    const observed = new Set([...groups.values()].flat())
    return { eligible, groups, unknown: eligible.filter(id => !observed.has(id)).length }
  }
  const mechanism = comparison.values.find(value => value !== "none")
  if (!mechanism || !MECHANISMS.has(mechanism) || !comparison.values.includes("none")) fail()
  const eligible = compareEligibleTeams(db, scope, window, mechanism)
  const adopted = teamsWithMechanism(db, eligible, window, mechanism)
  return {
    eligible,
    groups: new Map([[mechanism, eligible.filter(id => adopted.has(id))], ["none", eligible.filter(id => !adopted.has(id))]]),
    unknown: createdCohort(db, scope, window).length - eligible.length,
  }
}

function comparisonGroups(
  db: Database,
  scope: AuthorizedScope,
  window: TimeWindow,
  comparison: NonNullable<TeamMetricsRequest["compare"]>,
  metrics: string[],
): { groups: Array<Record<string, unknown>>; unknown: number } {
  const cohorts = dimensionCohorts(db, scope, window, comparison)
  const groups = comparison.values.map(key => {
    const teamIds = cohorts.groups.get(key)
    if (!teamIds) fail()
    if (!scope.explicit && teamIds.length < 5) return { key, suppressed: true, suppression_reason: "fewer than five Teams" }
    const groupScope = { ...scope, teamIds }
    return { key, n: teamIds.length, metrics: comparisonMetricResponses(db, groupScope, window, metrics) }
  })
  return { groups, unknown: cohorts.unknown }
}

function periodKey(ms: number, grouping: "day" | "week"): string {
  const date = new Date(ms)
  if (grouping === "day") return date.toISOString().slice(0, 10)
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() - day + 1)
  return `${date.toISOString().slice(0, 10)}T00:00:00.000Z`
}

function dimensionStrata(
  db: Database,
  teamIds: string[],
  window: TimeWindow,
  groupBy: NonNullable<TeamMetricsRequest["group_by"]>,
): Array<{ key: string; teamIds: string[] }> {
  if (teamIds.length === 0) return []
  if (groupBy === "day" || groupBy === "week") {
    const rows = db.query(
      `SELECT team_id, time_created FROM team_event WHERE kind = 'team.created'
       AND team_id IN (${placeholders(teamIds)}) AND time_created >= ? AND time_created <= ?
       ORDER BY time_created, team_id`,
    ).all(...teamIds, window.from, window.to) as Array<{ team_id: string; time_created: number }>
    const periods = new Map<string, string[]>()
    rows.forEach(row => {
      const key = periodKey(row.time_created, groupBy)
      periods.set(key, [...(periods.get(key) ?? []), row.team_id])
    })
    return [...periods].map(([key, ids]) => ({ key, teamIds: ids }))
  }
  if (groupBy === "workflow_kind" || groupBy === "complexity_band") return [{ key: "unknown", teamIds }]
  if (groupBy === "profile" || groupBy === "model") {
    const column = groupBy
    const rows = db.query(
      `SELECT DISTINCT team_id, ${column} AS value FROM team_member
       WHERE team_id IN (${placeholders(teamIds)}) AND ${column} IS NOT NULL ORDER BY value, team_id`,
    ).all(...teamIds) as Array<{ team_id: string; value: string }>
    const valuesByTeam = new Map<string, string[]>()
    rows.forEach(row => {
      valuesByTeam.set(row.team_id, [...(valuesByTeam.get(row.team_id) ?? []), row.value])
    })
    const strata = new Map<string, string[]>()
    valuesByTeam.forEach((values, teamId) => {
      const key = values.join("+")
      strata.set(key, [...(strata.get(key) ?? []), teamId])
    })
    if (valuesByTeam.size < teamIds.length) strata.set("unknown", teamIds.filter(id => !valuesByTeam.has(id)))
    return [...strata].map(([key, ids]) => ({ key, teamIds: ids }))
  }
  const mechanismsByTeam = new Map(teamIds.map(teamId => [teamId, [] as string[]]))
  MECHANISMS.forEach(mechanism => {
    teamsWithMechanism(db, teamIds, window, mechanism).forEach(teamId => {
      mechanismsByTeam.get(teamId)?.push(mechanism)
    })
  })
  const strata = new Map<string, string[]>()
  mechanismsByTeam.forEach((mechanisms, teamId) => {
    const key = mechanisms.length === 0 ? "none" : mechanisms.join("+")
    strata.set(key, [...(strata.get(key) ?? []), teamId])
  })
  return [...strata].map(([key, ids]) => ({ key, teamIds: ids }))
}

function page<T>(values: T[], limit: number, cursor: string | undefined): Page<T> {
  const offset = cursor === undefined ? 0 : Number(cursor)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > values.length) fail()
  const pageValues = values.slice(offset, offset + limit)
  const next = offset + pageValues.length
  return { values: pageValues, ...(next < values.length ? { nextCursor: String(next) } : {}) }
}

function funnelStages(db: Database, scope: AuthorizedScope, window: TimeWindow): Array<{ kind: string; count: number }> {
  const cohort = createdCohort(db, scope, window)
  if (cohort.length === 0) return ["team.created", "member.registered", "task.created", "task.completed", "team.archived"].map(kind => ({ kind, count: 0 }))
  const rows = db.query(
    `SELECT team_id, kind, time_created, id FROM team_event
     WHERE team_id IN (${placeholders(cohort)})
       AND kind IN ('team.created', 'member.registered', 'task.created', 'task.completed', 'team.archived')
       AND time_created >= ? AND time_created <= ? ORDER BY team_id, time_created, id`,
  ).all(...cohort, window.from, window.to) as Array<{ team_id: string; kind: string }>
  const expected = ["team.created", "member.registered", "task.created", "task.completed", "team.archived"]
  const progress = new Map<string, number>()
  const counts = expected.map(() => 0)
  rows.forEach(row => {
    const index = progress.get(row.team_id) ?? 0
    if (row.kind !== expected[index]) return
    counts[index] = (counts[index] ?? 0) + 1
    progress.set(row.team_id, index + 1)
  })
  return expected.map((kind, index) => ({ kind, count: counts[index] ?? 0 }))
}

function compareView(db: Database, scope: AuthorizedScope, window: TimeWindow, request: TeamMetricsRequest, metrics: string[], limit: number): Record<string, unknown> {
  const comparison = request.compare
  if (!comparison || comparison.values.length !== 2 || new Set(comparison.values).size !== 2) fail()
  validateFilterValues(comparison.values)
  if (comparison.dimension === "mechanism") {
    const mechanism = comparison.values.find(value => value !== "none")
    if (!mechanism || !MECHANISMS.has(mechanism) || !comparison.values.includes("none")) fail()
  }
  if (!request.group_by) {
    const result = comparisonGroups(db, scope, window, comparison, metrics)
    return { group_by: comparison.dimension, groups: result.groups, unknown_count: result.unknown, matched_strata: [] }
  }
  if (request.group_by === comparison.dimension) fail()
  const eligible = comparison.dimension === "mechanism"
    ? compareEligibleTeams(db, scope, window, comparison.values.find(value => value !== "none") as string)
    : createdCohort(db, scope, window, TELEMETRY_VERSION)
  const strata = dimensionStrata(db, eligible, window, request.group_by).flatMap(stratum => {
    const result = comparisonGroups(db, { ...scope, teamIds: stratum.teamIds }, window, comparison, metrics)
    return result.groups.some(group => group.suppressed === true)
      ? []
      : [{ key: stratum.key, groups: result.groups, unknown_count: result.unknown }]
  })
  const paged = page(strata, limit, request.cursor)
  return {
    group_by: request.group_by,
    matched_strata: paged.values,
    ...(paged.nextCursor ? { next_cursor: paged.nextCursor } : {}),
  }
}

/** Execute a bounded, read-only and privacy-safe metrics request. */
export function executeTeamMetrics(db: Database, registry: MemberRegistry, request: TeamMetricsRequest, sessionId: string): string {
  if (!request || !Array.isArray(request.metrics) || request.metrics.length === 0 || request.metrics.length > MAX_METRICS) fail()
  assertRequestShape(request)
  if (!request.metrics.every(metric => Object.hasOwn(METRIC_DEFINITIONS, metric))) fail()
  if (!["summary", "funnel", "timeline", "compare"].includes(request.view)) fail()
  if (request.cursor !== undefined && (request.view !== "compare" || request.group_by === undefined)) fail()
  if (request.group_by !== undefined && (request.view !== "compare" || !GROUP_BY.has(request.group_by))) fail()
  if (request.filters?.mechanism?.some(value => !MECHANISMS.has(value))) fail()
  const limit = request.limit ?? MAX_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) fail()
  const window = parseWindow(request.window)
  const scope = applyFilters(db, authorize(db, registry, sessionId, request), request.filters, window)
  const coverage = baseCoverage(db, scope, window)
  if (request.view === "timeline") {
    return JSON.stringify({ view: request.view, request_window: { from: window.fromIso, to: window.toIso }, coverage, ...timeline(db, scope, window, limit) })
  }
  const metrics = request.metrics.map(metric => metricResponse(db, scope, window, metric))
  if (request.view === "funnel") {
    const stages = funnelStages(db, scope, window)
    return JSON.stringify({ view: request.view, request_window: { from: window.fromIso, to: window.toIso }, coverage, stages, metrics })
  }
  if (request.view === "compare") {
    const comparison = compareView(db, scope, window, request, request.metrics, limit)
    return JSON.stringify({ view: request.view, request_window: { from: window.fromIso, to: window.toIso }, coverage, ...comparison, warning: "Observational comparison; not causal." })
  }
  return JSON.stringify({ view: request.view, request_window: { from: window.fromIso, to: window.toIso }, coverage, metrics })
}
