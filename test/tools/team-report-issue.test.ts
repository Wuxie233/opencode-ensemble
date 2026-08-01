import { beforeEach, describe, expect, test } from "bun:test"
import { insertMember, insertTeam, setupDeps } from "../helpers"
import {
  FEEDBACK_LABEL,
  buildIssueBody,
  executeTeamReportIssue,
} from "../../src/tools/team-report-issue"
import type { TeamReportIssueArgs, RunFn } from "../../src/tools/team-report-issue"

const ISSUE_URL = "https://github.com/Wuxie233/opencode-ensemble/issues/42"

/** Return a mock RunFn and a getter for all calls it has recorded. */
function makeMockRun(
  issueExitCode = 0,
): [RunFn, () => Array<{ args: string[] }>] {
  const calls: Array<{ args: string[] }> = []
  const run: RunFn = async (args) => {
    calls.push({ args })
    if (args.includes("create")) {
      return { exitCode: issueExitCode, stdout: issueExitCode === 0 ? ISSUE_URL : "", stderr: issueExitCode !== 0 ? "label not found" : "" }
    }
    // label creation — always succeed
    return { exitCode: 0, stdout: "", stderr: "" }
  }
  return [run, () => calls]
}

const BASE: TeamReportIssueArgs = {
  title: "design_flaw: Scout cannot read context files",
  body: "Context plugin returns a local file path but Scout agents cannot read it.",
  kind: "design_flaw",
  severity: "high",
}

describe("buildIssueBody", () => {
  test("includes kind and severity header", () => {
    const body = buildIssueBody(BASE, "high", "standalone session")
    expect(body).toContain("`design_flaw`")
    expect(body).toContain("`high`")
  })

  test("includes trigger section when provided", () => {
    const body = buildIssueBody({ ...BASE, trigger: "Happened during review task" }, "medium", "team `alpha`")
    expect(body).toContain("Where this surfaced")
    expect(body).toContain("Happened during review task")
  })

  test("skips trigger section when absent", () => {
    const body = buildIssueBody(BASE, "medium", "standalone session")
    expect(body).not.toContain("Where this surfaced")
  })

  test("includes proposal section when provided", () => {
    const body = buildIssueBody({ ...BASE, proposal: "Return inline content" }, "low", "team `beta`")
    expect(body).toContain("Suggested direction")
    expect(body).toContain("Return inline content")
  })

  test("includes reporter attribution", () => {
    const body = buildIssueBody(BASE, "high", "team `my-team`")
    expect(body).toContain("team_report_issue")
    expect(body).toContain("team `my-team`")
  })
})

describe("executeTeamReportIssue", () => {
  let deps: ReturnType<typeof setupDeps>

  beforeEach(() => {
    deps = setupDeps()
  })

  // --- happy path ---

  test("files issue from standalone session and returns URL", async () => {
    const [run, getCalls] = makeMockRun()
    const result = await executeTeamReportIssue(deps, BASE, "solo-sess", run)
    expect(result).toContain(ISSUE_URL)
    expect(getCalls().filter(c => c.args.includes("create"))).toHaveLength(1)
  })

  test("files issue from team lead session", async () => {
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    const [run] = makeMockRun()
    const result = await executeTeamReportIssue(deps, BASE, "lead-sess", run)
    expect(result).toContain(ISSUE_URL)
  })

  test("applies ensemble-feedback label", async () => {
    const [run, getCalls] = makeMockRun()
    await executeTeamReportIssue(deps, BASE, "solo-sess", run)
    const createCall = getCalls().find(c => c.args.includes("create"))
    expect(createCall?.args).toContain(FEEDBACK_LABEL)
  })

  test("applies kind label", async () => {
    const [run, getCalls] = makeMockRun()
    await executeTeamReportIssue(deps, BASE, "solo-sess", run)
    const createCall = getCalls().find(c => c.args.includes("create"))
    expect(createCall?.args).toContain("design-flaw")
  })

  test("applies severity label", async () => {
    const [run, getCalls] = makeMockRun()
    await executeTeamReportIssue(deps, BASE, "solo-sess", run)
    const createCall = getCalls().find(c => c.args.includes("create"))
    expect(createCall?.args).toContain("severity:high")
  })

  test("uses default severity medium when omitted", async () => {
    const [run, getCalls] = makeMockRun()
    await executeTeamReportIssue(deps, { ...BASE, severity: undefined }, "solo-sess", run)
    const createCall = getCalls().find(c => c.args.includes("create"))
    expect(createCall?.args).toContain("severity:medium")
  })

  test("targets config.issueRepo by default", async () => {
    const [run, getCalls] = makeMockRun()
    deps.config.issueRepo = "MyOrg/my-fork"
    await executeTeamReportIssue(deps, BASE, "solo-sess", run)
    const createCall = getCalls().find(c => c.args.includes("create"))
    expect(createCall?.args).toContain("MyOrg/my-fork")
  })

  test("uses explicit repo arg over config default", async () => {
    const [run, getCalls] = makeMockRun()
    await executeTeamReportIssue(deps, { ...BASE, repo: "hueyexe/opencode-ensemble" }, "solo-sess", run)
    const createCall = getCalls().find(c => c.args.includes("create"))
    expect(createCall?.args).toContain("hueyexe/opencode-ensemble")
    expect(createCall?.args).not.toContain("Wuxie233/opencode-ensemble")
  })

  test("attempts three label creations before filing", async () => {
    const [run, getCalls] = makeMockRun()
    await executeTeamReportIssue(deps, BASE, "solo-sess", run)
    const labelCalls = getCalls().filter(c => c.args.includes("POST"))
    expect(labelCalls).toHaveLength(3)
  })

  // --- fallback path ---

  test("retries without labels if first create fails", async () => {
    const calls: Array<{ args: string[] }> = []
    let createCount = 0
    const run: RunFn = async (args) => {
      calls.push({ args })
      if (args.includes("create")) {
        createCount++
        if (createCount === 1) return { exitCode: 1, stdout: "", stderr: "label not found" }
        return { exitCode: 0, stdout: ISSUE_URL, stderr: "" }
      }
      return { exitCode: 0, stdout: "", stderr: "" }
    }
    const result = await executeTeamReportIssue(deps, BASE, "solo-sess", run)
    expect(result).toContain("without labels")
    expect(calls.filter(c => c.args.includes("create"))).toHaveLength(2)
  })

  test("second retry has no --label args", async () => {
    const calls: Array<{ args: string[] }> = []
    let createCount = 0
    const run: RunFn = async (args) => {
      calls.push({ args })
      if (args.includes("create")) {
        createCount++
        if (createCount === 1) return { exitCode: 1, stdout: "", stderr: "label not found" }
        return { exitCode: 0, stdout: ISSUE_URL, stderr: "" }
      }
      return { exitCode: 0, stdout: "", stderr: "" }
    }
    await executeTeamReportIssue(deps, BASE, "solo-sess", run)
    const secondCreate = calls.filter(c => c.args.includes("create"))[1]!
    expect(secondCreate.args).not.toContain("--label")
  })

  // --- error paths ---

  test("throws when both create attempts fail", async () => {
    const run: RunFn = async (args) => {
      if (args.includes("create")) return { exitCode: 1, stdout: "", stderr: "network error" }
      return { exitCode: 0, stdout: "", stderr: "" }
    }
    await expect(
      executeTeamReportIssue(deps, BASE, "solo-sess", run)
    ).rejects.toThrow("Could not file the issue")
  })

  test("rejects calls from a teammate (not lead)", async () => {
    insertTeam(deps.db, "t1", "my-team", "lead-sess")
    insertMember(deps.db, "t1", "alice", "sess-alice", "busy", "running")
    deps.registry.register("t1", "alice", "sess-alice")
    const [run] = makeMockRun()
    await expect(
      executeTeamReportIssue(deps, BASE, "sess-alice", run)
    ).rejects.toThrow("team lead")
  })

  test("rejects empty title", async () => {
    const [run] = makeMockRun()
    await expect(
      executeTeamReportIssue(deps, { ...BASE, title: "  " }, "solo-sess", run)
    ).rejects.toThrow("title is required")
  })

  test("rejects empty body", async () => {
    const [run] = makeMockRun()
    await expect(
      executeTeamReportIssue(deps, { ...BASE, body: "  " }, "solo-sess", run)
    ).rejects.toThrow("body is required")
  })

  test("rejects invalid repo format", async () => {
    const [run] = makeMockRun()
    await expect(
      executeTeamReportIssue(deps, { ...BASE, repo: "not-valid" }, "solo-sess", run)
    ).rejects.toThrow("OWNER/REPO")
  })
})
