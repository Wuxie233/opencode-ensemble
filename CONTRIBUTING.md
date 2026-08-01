# Contributing to opencode-ensemble

## Setup

```bash
git clone https://github.com/hueyexe/opencode-ensemble.git
cd opencode-ensemble
bun install
```

## Development Workflow

Before submitting any change:

```bash
bun run typecheck && bun test && bun run build
```

All three must pass.

## Branch Naming (required)

CI enforces a branch-name prefix on every PR via the `branch-name` check. Your PR's head branch **must** start with one of:

- `feature/` — new functionality (e.g. `feature/verbose-dashboard`)
- `bugfix/` — fixes (e.g. `bugfix/bun-sqlite-scanner`)
- `chore/` — tooling, docs, deps, refactors (e.g. `chore/update-deps`)

> **Common gotcha:** opening a PR directly from your fork's `main` branch fails this check, because `main` has no valid prefix. Always create a prefixed branch before pushing:
>
> ```bash
> git checkout -b bugfix/short-description
> ```
>
> If you already committed to `main` on your fork, move the work to a prefixed branch and open the PR from there.

## Submitting Changes

1. Fork the repo and create a branch off `main` using a `bugfix/`, `feature/`, or `chore/` prefix (see above)
2. Make your changes following the code standards below
3. Run `bun run typecheck && bun test && bun run build` — all must pass
4. Open a PR against `main`
5. The `check` CI status must pass on your PR (the `branch-name` check must pass too)
6. A maintainer (@hueyexe) will review and merge

All PRs require at least one approval from a code owner before merging. Direct pushes to `main` are not allowed.

## Code Standards

- TypeScript strict mode — no `any` types
- Every exported function has a JSDoc comment
- `const` over `let`, early returns over `else`
- `snake_case` for SQL columns, `camelCase` for TypeScript
- Functional array methods over `for` loops
- Zero external dependencies beyond `@opencode-ai/sdk` and `@opencode-ai/plugin`; SQLite goes through the internal adapter (`bun:sqlite` on Bun, `node:sqlite` on Node/Electron)

## Testing

- All tests use in-memory SQLite (`:memory:`) — no disk I/O, no cleanup
- Mock `OpencodeClient` for integration tests (see `test/helpers.ts`)
- Race condition tests use `Promise.all()` / `Promise.allSettled()`
- No mocking of business logic — test actual SQLite transactions
- `bun test` is the only test runner

## Project Structure

```
src/
├── index.ts             # Plugin entry point and tool registration
├── client.ts            # SDK wrapper that throws on API errors
├── config.ts            # Global/project/env configuration loading
├── dashboard*.ts        # Dashboard HTML, JS, and data endpoint
├── db.ts                # SQLite connection + init
├── hooks.ts             # Event hook + sub-agent isolation
├── log.ts               # Plugin logging helpers
├── messaging.ts         # Message persistence + delivery helpers
├── notify.ts            # TUI notification helpers
├── progress.ts          # Progress/stall tracking
├── rate-limit.ts        # Token bucket rate limiter
├── recovery.ts          # Crash recovery and orphan cleanup
├── result-parser.ts     # Teammate result parsing helpers
├── schema.ts            # CREATE TABLE migrations
├── state.ts             # In-memory registry, descendant tracker, and purge approval state
├── system-prompt.ts     # Lead/teammate prompt injection text
├── types.ts             # Shared types + helper functions
├── util.ts              # ID generation + name validation
├── watchdog.ts          # Timeout and stall watchdog
└── tools/               # 17 team tools plus shared/merge helpers

test/
├── helpers.ts        # Shared test utilities (setupDb, mockClient, etc.)
├── *.test.ts         # Unit tests for each src module
└── tools/            # Tool-specific tests
```

## Open Questions

Unresolved SDK behavior questions are tracked in `.opencode/plans/architecture-plan.md` Section 9. When you encounter one during implementation:

- Make the conservative choice
- Add `// OQ-<number>: <assumption made>` at the call site
- Write a test that will fail if the assumption is wrong

## Reference Material

The `docs/reference/` directory contains PR implementations from the OpenCode core repo. These use internal APIs (`Storage`, `Bus`, `Lock`, `SessionPrompt`, etc.) that are **not available** from a plugin. See the Internal API Blocklist in `AGENTS.md` before referencing them.
