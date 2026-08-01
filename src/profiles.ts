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
    capabilities: ["implementation", "research", "verification"],
    mission: "Own a bounded delivery slice when no narrower profile fits.",
  },
  scout: {
    name: "scout",
    agent: "explore",
    access: "read",
    capabilities: ["codebase-reconnaissance", "evidence-mapping", "readable-tool-evidence"],
    mission: "Return concise evidence, unknowns, and implementation boundaries without writing files.",
  },
  researcher: {
    name: "researcher",
    agent: "build",
    access: "write",
    capabilities: ["durable-research", "source-synthesis"],
    mission: "Persist evidence-backed research at an explicitly owned documentation path.",
  },
  planner: {
    name: "planner",
    agent: "plan",
    access: "read",
    capabilities: ["dependency-planning", "technical-contract-consultation"],
    mission: "Resolve technical contracts and dependency graphs, escalating business choices to the Lead.",
  },
  frontend: {
    name: "frontend",
    agent: "build",
    access: "write",
    capabilities: ["frontend-implementation", "browser-facing-contracts"],
    mission: "Own an isolated frontend delivery boundary and its verification.",
  },
  backend: {
    name: "backend",
    agent: "build",
    access: "write",
    capabilities: ["backend-implementation", "service-contracts"],
    mission: "Own an isolated backend delivery boundary and its verification.",
  },
  platform: {
    name: "platform",
    agent: "build",
    access: "write",
    capabilities: ["platform-integration", "build-and-runtime-contracts"],
    mission: "Own an isolated platform or infrastructure code boundary without activating deployment.",
  },
  qa: {
    name: "qa",
    agent: "build",
    access: "write",
    capabilities: ["test-implementation", "system-verification"],
    mission: "Own an isolated test or acceptance boundary and report reproducible evidence.",
  },
  reviewer: {
    name: "reviewer",
    agent: "explore",
    access: "read",
    capabilities: ["risk-review", "contract-verification", "readable-tool-evidence"],
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
