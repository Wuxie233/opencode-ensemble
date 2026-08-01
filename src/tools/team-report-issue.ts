import type { CommandResult } from "../process"
import { runCommand } from "../process"
import type { ToolDeps } from "../types"
import { findTeamBySession } from "../types"

/** Feedback category for a reported plugin defect. */
export type IssueKind = "bug" | "design_flaw" | "inefficiency" | "missing_capability"

/** Impact level used to triage which reports are worth iterating on. */
export type IssueSeverity = "critical" | "high" | "medium" | "low"

/** Canonical repository that owns Ensemble feedback. */
export const FEEDBACK_REPO = "Wuxie233/opencode-ensemble"

/** Arguments accepted by the team_report_issue tool. */
export interface TeamReportIssueArgs {
  title: string
  body: string
  kind: IssueKind
  severity?: IssueSeverity
  trigger?: string
  repro?: string
  proposal?: string
}

/** Injectable subprocess runner — replaced with a stub in tests. */
export type RunFn = (args: string[]) => Promise<CommandResult>

/** Marker label applied to every report so collection runs can filter reliably. */
export const FEEDBACK_LABEL = "ensemble-feedback"

const KIND_LABEL: Record<IssueKind, string> = {
  bug: "bug",
  design_flaw: "design-flaw",
  inefficiency: "inefficiency",
  missing_capability: "missing-capability",
}

const KIND_COLOR: Record<IssueKind, string> = {
  bug: "d73a4a",
  design_flaw: "d93f0b",
  inefficiency: "fbca04",
  missing_capability: "a2eeef",
}

const SEVERITY_COLOR: Record<IssueSeverity, string> = {
  critical: "b60205",
  high: "e99695",
  medium: "fef2c0",
  low: "c2e0c6",
}

/** Create a GitHub label, ignoring the 422 that means it already exists. */
async function ensureLabel(repo: string, name: string, color: string, description: string, run: RunFn): Promise<void> {
  await run([
    "gh", "api", `repos/${repo}/labels`,
    "--method", "POST",
    "-f", `name=${name}`,
    "-f", `color=${color}`,
    "-f", `description=${description}`,
  ])
}

/** Render the issue body: fixed sections so collection runs can skim consistently. */
export function buildIssueBody(args: TeamReportIssueArgs, severity: IssueSeverity, reportedBy: string): string {
  const lines = [
    `**Kind:** \`${args.kind}\` — **Severity:** \`${severity}\``,
    "",
    "## Problem",
    args.body.trim(),
  ]
  if (args.trigger?.trim()) lines.push("", "## Where this surfaced", args.trigger.trim())
  if (args.repro?.trim()) lines.push("", "## Reproduction", args.repro.trim())
  if (args.proposal?.trim()) lines.push("", "## Suggested direction", args.proposal.trim())
  lines.push(
    "",
    "---",
    `Reported by \`team_report_issue\` from ${reportedBy}. Not yet triaged — confirm the defect against source before acting on it.`,
  )
  return lines.join("\n")
}

/**
 * Execute the team_report_issue tool. Files an Ensemble defect report as a
 * GitHub issue on the plugin's own tracker so a later session can triage it.
 * Available to the Lead only; teammates route findings through team_message.
 */
export async function executeTeamReportIssue(
  deps: ToolDeps,
  args: TeamReportIssueArgs,
  sessionId: string,
  run: RunFn = runCommand,
): Promise<string> {
  const teamInfo = findTeamBySession(deps.db, deps.registry, sessionId)
  if (teamInfo && teamInfo.role !== "lead") {
    throw new Error(
      "Only the team lead can file plugin feedback. Send the finding to the lead with team_message instead.",
    )
  }

  const title = args.title.trim()
  if (!title) throw new Error("An issue title is required.")
  if (!args.body.trim()) throw new Error("An issue body is required.")

  const severity = args.severity ?? "medium"
  const kindLabel = KIND_LABEL[args.kind]
  const severityLabel = `severity:${severity}`
  const reportedBy = teamInfo ? `team \`${teamInfo.teamName}\`` : "a standalone session"
  const body = buildIssueBody(args, severity, reportedBy)

  // Best effort: a missing label would otherwise fail the whole report.
  await Promise.all([
    ensureLabel(FEEDBACK_REPO, FEEDBACK_LABEL, "5319e7", "Ensemble self-iteration feedback", run),
    ensureLabel(FEEDBACK_REPO, kindLabel, KIND_COLOR[args.kind], `Ensemble feedback kind: ${args.kind}`, run),
    ensureLabel(FEEDBACK_REPO, severityLabel, SEVERITY_COLOR[severity], `Ensemble feedback severity: ${severity}`, run),
  ])

  const base = ["gh", "issue", "create", "--repo", FEEDBACK_REPO, "--title", title, "--body", body]
  const labelled = await run([
    ...base,
    "--label", FEEDBACK_LABEL,
    "--label", kindLabel,
    "--label", severityLabel,
  ])
  if (labelled.exitCode === 0) {
    return `Filed on ${FEEDBACK_REPO}: ${labelled.stdout.trim()}\nLabels: ${FEEDBACK_LABEL}, ${kindLabel}, ${severityLabel}`
  }

  // Labels may be unavailable (permissions, label protection). The report matters more.
  const plain = await run(base)
  if (plain.exitCode !== 0) {
    const reason = (plain.stderr || labelled.stderr || "unknown error").trim()
    throw new Error(`Could not file the issue on ${FEEDBACK_REPO}: ${reason}`)
  }
  return `Filed on ${FEEDBACK_REPO} without labels (label step failed): ${plain.stdout.trim()}`
}
