import type { ToolDeps } from "../types"
import { executeTeamMetrics, type TeamMetricsRequest } from "../metrics"

/** Execute the read-only team_metrics query for the calling session. */
export function executeTeamMetricsTool(deps: ToolDeps, request: TeamMetricsRequest, sessionId: string): string {
  return executeTeamMetrics(deps.db, deps.registry, request, sessionId)
}
