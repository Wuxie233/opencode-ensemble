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
    expect(readme).toContain("scout: explore agent, worktree disabled");
    expect(readme).toContain("reviewer: explore agent, worktree disabled");
    expect(readme).toContain("openai/gpt-5.3-codex-spark");
    expect(readme).toContain("anthropic/claude-opus-4-7");
    expect(readme).not.toContain("opencode/gpt-5-nano");
    expect(readme).not.toContain("anthropic/claude-opus-4-6");
    expect(readme).toContain("plan_approval: true");
    expect(readme).toContain("depends_on");
    expect(readme).toContain("ready frontier contains pending tasks whose dependencies are complete");
    expect(readme).toContain("returned key-to-ID mapping");
    expect(readme).toContain('key: "map-flow"');
    expect(readme).toContain("Lead Brief");
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
    expect(skill).toContain("sixth distinct consecutive provider retry");
    expect(skill).toContain("resume_from");
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
