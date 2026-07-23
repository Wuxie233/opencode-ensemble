import type { Database } from "./db"

interface PhaseRow {
  phase: string
}

/** Recompute and persist the Team phase from its active ready frontier. */
export function recomputeCurrentPhase(db: Database, teamId: string, now: number): string | null {
  const active = db.query(
    `SELECT phase FROM team_task
     WHERE team_id = ? AND status = 'in_progress' AND phase IS NOT NULL AND TRIM(phase) != ''
     ORDER BY time_created ASC, id ASC LIMIT 1`,
  ).get(teamId) as PhaseRow | null
  const ready = active ?? db.query(
    `SELECT phase FROM team_task
     WHERE team_id = ? AND status = 'pending' AND phase IS NOT NULL AND TRIM(phase) != ''
     ORDER BY time_created ASC, id ASC LIMIT 1`,
  ).get(teamId) as PhaseRow | null
  const phase = ready?.phase.trim() || null
  db.run("UPDATE team SET current_phase = ?, time_updated = ? WHERE id = ?", [phase, now, teamId])
  return phase
}
