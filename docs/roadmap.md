# Roadmap

OpenCode Ensemble is a coordination runtime for parallel agent teams. It gives
a human one place to launch a team, watch real agents work in parallel without
stepping on each other, and recover any work the team produced.

The team can be coding, researching, writing, or coworking. Ensemble does not
care what the work is — it cares that the team stays coordinated, isolated,
inspectable, and recoverable.

## Product Bet

Raw parallelism is not enough. Agents working at the same time still need a
coordination protocol: addressable peers, shared task state, isolated
workspaces, lifecycle they can recover from, and persistence the human can
inspect after the fact.

Ensemble's bet is that this protocol is *generalizable*. The same runtime that
coordinates a feature-delivery team should coordinate a research team, a
writing team, or an unattended cowork session. Workflow conventions sit on
top, not inside.

## Two Layers

Ensemble is two layers, and we keep them honest.

**Core Ensemble** is the coordination runtime. It is domain-agnostic. It
handles team creation, teammate lifecycle, worktree isolation, message and
task primitives, project grouping, and crash recovery. It works for any team
shape that benefits from parallel agents.

**Delivery Run** is an opt-in workflow layer built on top of Core Ensemble.
It adds the conventions a software-delivery team needs: spec, plan, staffing,
review, verification, and a shipping report. It is one workflow we ship — not
the only one Ensemble can host.

The shorthand: **Ensemble runs teams; Delivery Run runs process.**

A team can use Ensemble without ever opting into Delivery Run.

## Core Milestones

These milestones harden the runtime for every team kind.

### M0: No Lost Work

Make teammate lifecycle a deep, enforceable module.

- Centralize branch preservation, abort, shutdown, cleanup, and merge behavior.
- Make "never lose teammate work" an invariant of the runtime, not a habit.
- Cover every abort and cleanup path with lifecycle tests.

### M1: Domain-Agnostic Roles

Stop assuming "build" is the default agent kind.

- First-class role hints (researcher, writer, reviewer, cowork peer, builder).
- Role-aware spawn ergonomics that do not bias toward coding.
- Examples and templates for non-coding teams in the docs.

### M2: Persistent Team Context

Make a team's state survive long sessions and crashes for any workflow.

- Durable team, member, task, and message state across compaction.
- Recovery on plugin restart for any in-flight team kind.
- Dashboard surfaces that work without assuming a delivery phase.

### M3: Project Grouping And Monitoring

Make many concurrent teams legible.

- Group teams by project for triage.
- Live status, idle/busy, blockers, and recent activity.
- Keyboard-first navigation between teams, members, tasks, and messages.

## Delivery Run Milestones

These milestones build the software-delivery workflow on top of Core Ensemble.
They are opt-in. A team only enters this workflow when the human chooses to.

### D1: Delivery Run Backbone

Add the persistent model for a feature-delivery run.

- Track run phase, goal, owner, status, blockers, artifacts, and verification
  state, scoped to teams that opted into a Delivery Run.
- Show Delivery Run state in the dashboard alongside generic team state.
- Preserve run context across compaction and recovery.

### D2: Planner To Team

Turn a feature request into a staffed execution plan.

- Produce a concise spec.
- Break work into task contracts.
- Assign planner, builder, QA, and reviewer roles within the team.
- Keep humans in control at approval gates for spec, plan, and merge.

### D3: Review Gates

Make quality checks part of the workflow runtime.

- Spec-compliance review before code-quality review.
- Unresolved review findings block completion of the run.
- Record review evidence as run artifacts.

### D4: Verification And Shipping Report

End every Delivery Run with evidence.

- Run configured verification commands.
- Summarize changed files, commits, tests, reviews, blockers, and residual
  risks.
- Return a merge-ready or PR-ready result.

### D5: Beyond Feature Delivery

Extend Delivery Run to adjacent software work that shares its shape: debugging
runs, migration runs, audit runs. These stay inside the Delivery Run layer
because they share its review/verification/report contract.

## Beyond Software Delivery

Other workflow layers can be built on Core Ensemble without Ensemble owning
them. A Research Run might add literature intake, source tracking, and a
synthesis report. A Writing Run might add outline gates, draft review, and a
publication checklist. A Cowork Run might add long-running coordination across
human-and-agent pairs.

Ensemble's job is to make these workflows possible, not to ship all of them.
Some will live in Ensemble; many should live as separate plugins or skill
chains and reuse our coordination primitives.

## What Ensemble Will Not Reinvent

Ensemble composes with prior art. It does not replace it.

- **gsd-style flows** own delivery methodology, phase conventions, and prompt
  doctrine. We do not reimplement those — Delivery Run borrows their shape
  where useful and stays minimal otherwise.
- **Superpowers** owns process-before-implementation skill chains
  (brainstorming, planning, TDD). Ensemble teammates use skills; Ensemble
  itself does not enforce a process doctrine.
- **Ralph-style loops** own the single-agent iterative pattern. Ensemble's
  multi-agent coordination is orthogonal and should not duplicate it.
- **Claude Code agent teams** is a public reference for team semantics.
  Ensemble aligns naming and behavior where it can rather than reinventing.

The discipline is to build the coordination substrate that these tools assume,
not to absorb their roles.

## Principle

Ensemble should feel less like spawning agents and more like running a
coordinated team. Software delivery is the first concrete workflow we build on
top of that runtime — not its purpose.
