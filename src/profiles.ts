export const PROFILE_NAMES = [
  "general",
  "scout",
  "researcher",
  "planner",
  "frontend",
  "backend",
  "platform",
  "qa",
  "reviewer",
] as const

export type ProfileName = (typeof PROFILE_NAMES)[number]

/** Concrete execution capabilities that a task may require from its teammate. */
export const EXECUTION_CAPABILITIES = [
  "file_read",
  "file_write",
  "shell",
  "browser",
  "device",
] as const

export type ExecutionCapability = (typeof EXECUTION_CAPABILITIES)[number]

export interface EnsembleProfile {
  name: ProfileName
  agent: "build" | "explore" | "plan"
  access: "read" | "write"
  capabilities: readonly string[]
  mission: string
}

const PROFILES: Record<ProfileName, EnsembleProfile> = {
  general: {
    name: "general",
    agent: "build",
    access: "write",
    capabilities: ["implementation", "research", "verification", "file_read", "file_write", "shell"],
    mission: "Own a bounded delivery slice when no narrower profile fits.",
  },
  scout: {
    name: "scout",
    agent: "explore",
    access: "read",
    capabilities: ["codebase-reconnaissance", "evidence-mapping", "readable-tool-evidence", "file_read"],
    mission: "Return concise evidence, unknowns, and implementation boundaries without writing files.",
  },
  researcher: {
    name: "researcher",
    agent: "build",
    access: "write",
    capabilities: ["durable-research", "source-synthesis", "file_read", "file_write", "shell"],
    mission: "Persist evidence-backed research at an explicitly owned documentation path.",
  },
  planner: {
    name: "planner",
    agent: "plan",
    access: "read",
    capabilities: ["dependency-planning", "technical-contract-consultation", "file_read"],
    mission: "Resolve technical contracts and dependency graphs, escalating business choices to the Lead.",
  },
  frontend: {
    name: "frontend",
    agent: "build",
    access: "write",
    capabilities: ["frontend-implementation", "browser-facing-contracts", "file_read", "file_write", "shell", "browser"],
    mission: "Own an isolated frontend delivery boundary and its verification.",
  },
  backend: {
    name: "backend",
    agent: "build",
    access: "write",
    capabilities: ["backend-implementation", "service-contracts", "file_read", "file_write", "shell"],
    mission: "Own an isolated backend delivery boundary and its verification.",
  },
  platform: {
    name: "platform",
    agent: "build",
    access: "write",
    capabilities: ["platform-integration", "build-and-runtime-contracts", "file_read", "file_write", "shell", "device"],
    mission: "Own an isolated platform or infrastructure code boundary without activating deployment.",
  },
  qa: {
    name: "qa",
    agent: "build",
    access: "write",
    capabilities: ["test-implementation", "system-verification", "file_read", "file_write", "shell", "browser", "device"],
    mission: "Own an isolated test or acceptance boundary and report reproducible evidence.",
  },
  reviewer: {
    name: "reviewer",
    agent: "explore",
    access: "read",
    capabilities: ["risk-review", "contract-verification", "readable-tool-evidence", "file_read"],
    mission: "Review the integrated delivery for a named risk without modifying files.",
  },
}

/** Resolve and validate a broad Ensemble profile before spawn side effects. */
export function resolveProfile(profile: string | undefined, agent: string | undefined): EnsembleProfile {
  const inferred = profile ?? (agent === "explore" ? "scout" : agent === "plan" ? "planner" : "general")
  if (!PROFILE_NAMES.includes(inferred as ProfileName)) {
    throw new Error(`Unknown Ensemble profile "${inferred}". Use one of: ${PROFILE_NAMES.join(", ")}.`)
  }
  const resolved = PROFILES[inferred as ProfileName]
  if (agent && agent !== resolved.agent) {
    throw new Error(
      `Ensemble profile "${resolved.name}" requires runtime agent "${resolved.agent}", not "${agent}".`,
    )
  }
  return resolved
}
