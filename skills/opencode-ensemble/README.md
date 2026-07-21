# OpenCode Ensemble Skill

Guidance for using OpenCode Ensemble as the default development orchestrator, maximizing useful parallelism while keeping the Lead context concise.

Install from this repository:

```bash
npx skills@latest add hueyexe/opencode-ensemble --skill opencode-ensemble
```

Use this skill to split work into independent evidence and delivery slices, create task DAGs, isolate raw evidence from the Lead, recover failed sessions, review results, and clean up safely. It does not impose a teammate or Scout limit; each teammate must own a distinct useful boundary.

## Structure

```text
opencode-ensemble/
├── SKILL.md
└── references/
    ├── coordination-patterns.md
    ├── prompt-recipes.md
    ├── lead-checklists.md
    ├── anti-patterns.md
    └── eval-scenarios.md
```

`SKILL.md` is the short operational guide. Reference files provide deeper patterns, prompt recipes, checklists, anti-patterns, and pressure scenarios.
