# Team Artifact Store v1

## Goal

Give an active Ensemble Team a small immutable text control plane for shared
contracts and task results. A writer in an isolated Git worktree must be able to
read the exact contract assigned to its task without sharing the Lead's source
directory or copying uncommitted repository files.

This feature prevents accidental coordination failures between cooperative
agents. It is not a security boundary against arbitrary code running as the same
operating-system user.

## In Scope

- Store artifact metadata and UTF-8 content together in SQLite.
- Support `text/plain` and `text/markdown` only.
- Support immutable `contract` and `task_result` artifacts.
- Let the Lead publish Team contracts.
- Let the current assignee of an in-progress task publish a result bound to that
  task. The Lead may publish a result only for a task currently assigned to the
  Lead.
- Let active Team members list bounded metadata and read one exact artifact by
  opaque ID.
- Let a task bind one exact contract artifact and SHA-256 digest before claim.
- Surface the bound contract ID and digest through task listing, claim, and
  `team_spawn(claim_task)` context. Never resolve an implicit latest contract.
- Cascade-delete artifacts when the Team is explicitly purged. Archival retains
  rows, but ordinary artifact tools remain active-Team-only.

## Tool Contract

### `team_artifact_publish`

Inputs:

- `kind`: `contract | task_result`
- `content`: UTF-8 text
- `media_type`: optional `text/plain | text/markdown`, default `text/plain`
- `task_id`: required for `task_result`, forbidden for `contract`

The plugin derives Team and actor identity from the calling session. It returns
the generated artifact ID, SHA-256 digest, media type, and UTF-8 byte count.

### `team_artifact_list`

Inputs:

- optional `kind`
- optional `task_id`
- optional bounded `limit`

Returns metadata only, newest first. It never returns content.

### `team_artifact_read`

Input: one exact `artifact_id`.

Returns provenance metadata and delimited content. It does not accept paths,
filenames, aliases, or a latest selector.

### Task creation

`team_tasks_add` accepts optional `contract_artifact_id`. The referenced artifact
must be an immutable `contract` in the same active Team. The task stores both the
artifact ID and its current digest in the same transaction. The binding cannot
change after insertion.

## Authorization

- All artifact tools require membership in the same active Team.
- Only the Lead may publish `contract` artifacts.
- `task_result` requires an existing same-Team task with `status='in_progress'`
  whose `assignee` exactly matches the caller (`lead` or the member name).
- List and read queries always constrain by the caller's resolved Team ID.
- Caller input never supplies Team, actor, assignee, digest, size, or timestamp.
- Unknown and cross-Team artifact reads use the same not-found response.

## Integrity And Limits

- Artifact rows are immutable through SQLite triggers.
- IDs are generated with the existing cryptographically random ID helper.
- SHA-256 covers the exact stored UTF-8 bytes.
- Empty content is rejected.
- Per artifact: at most 256 KiB.
- Per Team: at most 1,000 artifacts and 16 MiB total stored content.
- Global stored-content cap: configurable, finite, and reserved in the same
  `BEGIN IMMEDIATE` transaction as insertion.
- List pagination and read output are bounded by the artifact size and tool
  schema. No artifact content enters lifecycle events, logs, metrics, Dashboard,
  Lead Brief, or automatic system-prompt injection.

## Configuration

Add conservative numeric settings for the per-artifact, per-Team byte/count, and
global byte limits. Invalid values fall back to defaults. Limits apply to new
publishes; existing immutable artifacts are never mutated to satisfy a lower
limit.

## Acceptance Evidence

- Migration creates the artifact table, indexes, immutable triggers, and task
  contract columns while preserving existing data.
- Happy-path tests cover Lead contract publication, exact-ID list/read, task
  binding, claim/spawn visibility, and current-assignee task results.
- Error-path tests cover member contract publication, unassigned/completed task
  results, cross-Team access, wrong artifact kind, digest binding, immutable rows,
  unsupported media types, empty/oversize content, count/Team/global quotas, and
  concurrent quota races.
- Existing Team purge cascade behavior removes artifacts for only the selected
  Team.
- `bun run typecheck`, `bun test`, and `bun run build` pass.

## Non-Goals

- Shared source-code directories or bypassing writer worktrees.
- Filesystem or object-store payloads, binary files, screenshots, or log bundles.
- Cross-Team sharing, aliases, mutable artifacts, latest lookup, deduplication,
  retention TTLs, archived retrieval, export, encryption, secret scanning,
  secure erasure, or Dashboard preview/download.
- Protection against a malicious process with direct access to this Unix account
  and the plugin database.
