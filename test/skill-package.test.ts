import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const root = join(import.meta.dir, "..");
const readmePath = join(root, "README.md");
const skillDir = join(root, "skills", "opencode-ensemble");
const skillPath = join(skillDir, "SKILL.md");

const referenceFiles = [
  "coordination-patterns.md",
  "prompt-recipes.md",
  "lead-checklists.md",
  "anti-patterns.md",
  "eval-scenarios.md",
];

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("opencode-ensemble agent skill", () => {
  test("is installable through the skills CLI from the repository README", () => {
    const readme = read(readmePath);

    expect(readme).toContain("npx skills@latest add hueyexe/opencode-ensemble --skill opencode-ensemble");
    expect(readme).toContain("scout: read-only reconnaissance, worktree disabled");
    expect(readme).toContain("reviewer: read-only risk review, worktree disabled");
    expect(readme).toContain("openai/gpt-5.3-codex-spark");
    expect(readme).toContain("anthropic/claude-opus-4-7");
    expect(readme).not.toContain("opencode/gpt-5-nano");
    expect(readme).not.toContain("anthropic/claude-opus-4-6");
    expect(readme).toContain("plan_approval: true");
    expect(readme).toContain("depends_on");
    expect(readme).toContain("ready frontier contains pending tasks whose dependencies are complete");
    expect(readme).toContain("Refuses cleanup while a writer branch is unmerged");
    expect(readme).toContain("persist its structured terminal result in the same transaction");
    expect(readme).not.toContain("Safety-net merges forgotten branches");
    expect(readme).toContain("returned key-to-ID mapping");
    expect(readme).toContain('key: "map-flow"');
    expect(readme).toContain("Lead Brief");
    expect(readme).toContain("21 tools");
    expect(readme).toContain("team_artifact_publish");
    expect(readme).toContain("one exact contract artifact");
    expect(readme).toContain("artifactGlobalMaxBytes");
    expect(readme).toContain("<kind>progress</kind>");
    expect(readme).toContain("message_id");
    expect(readme).not.toContain('depends_on: ["task_b"]');
  });

  test("has valid skill frontmatter and progressive-disclosure references", () => {
    const skill = read(skillPath);

    expect(skill).toStartWith("---\n");
    expect(skill).toContain("name: opencode-ensemble\n");
    expect(skill).toContain("default Team orchestration");
    expect(skill).toContain("# OpenCode Ensemble");
    expect(skill).toContain("references/coordination-patterns.md");
    expect(skill).toContain("references/prompt-recipes.md");
    expect(skill).toContain("references/lead-checklists.md");
    expect(skill).toContain("references/anti-patterns.md");
    expect(skill).toContain("references/eval-scenarios.md");
    expect(skill).toContain("Do not impose a Scout limit");
    expect(skill).toContain("batch-local `key`");
    expect(skill).toContain("ready frontier: pending tasks whose dependencies are complete");
    expect(skill).toContain("Independent read-only `worktree: false` spawns may be issued concurrently");
    expect(skill).toContain("terminal results atomically through `team_tasks_complete`");
    expect(skill).toContain("sixth distinct consecutive provider retry");
    expect(skill).toContain("resume_from");
    expect(skill).toContain("team_artifact_publish");
    expect(skill).toContain("exact artifact ID");
    expect(skill).toContain("uncommitted Lead-worktree file");
    expect(skill).toContain("Do not invent task IDs");
    expect(skill).toContain("Keep teammate prompts short");
  });

  test("ships every referenced skill support file", () => {
    expect(existsSync(skillPath)).toBe(true);
    expect(existsSync(join(skillDir, "README.md"))).toBe(true);

    for (const file of referenceFiles) {
      expect(existsSync(join(skillDir, "references", file))).toBe(true);
    }
  });
});
