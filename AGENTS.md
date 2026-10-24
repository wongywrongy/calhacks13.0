# Agent contracts and repository conventions

Read `docs/TARGET_SPEC.md`, `docs/STEER.md`, and `docs/SECURITY.md`. TARGET_SPEC defines
the intended product and acceptance criteria; ARCHITECTURE describes what currently runs.
TypeScript is used for clients and the practice service; Rust is reserved for SpacetimeDB.
The runnable experiment is `sandbox/src/`. The drone fleet mode (`arena-live/src/fleet.rs`,
`docs/FLEET.md`) is a separate reducer simulation with both scheduled fixtures and
model-driven chat operations (`docs/FLEET_CHAT_API.md`). Model operations disable security
fixtures while movement continues; the role contracts below describe the HTTP suite.

## Implementation scope

Build teams that make consequential decisions against this repository's own synthetic
HTTP service. Implementing planted application weaknesses, multi-step scenarios, bounded
load generation, defensive policy changes, team coordination, and measured visualizations
is in scope. Do not replace those mechanisms with narrated or pre-authored outcomes.

The restrictions on runtime agent tools below are not restrictions on a coding assistant
editing the repository, running tests, or adding reviewed scenarios. The initial catalog
is a baseline, not an immutable product specification. Extensions must keep the target
inside the practice service, validate typed parameters, enforce resource budgets, and
include tests of the resulting service behavior. Role specialties should guide decisions;
all attackers can now choose across the catalog and hand off evidence-linked tasks.

Claude is not a required runtime dependency. The current inference adapter targets Bitdeer.
Record provider refusals, malformed output, and errors truthfully; do not retry through
rewording intended to evade a provider's safeguards or silently switch to fixture actions.
If a task is blocked, identify the exact operation and continue independent in-scope work.

## Current team structure

Agents have separate credentials, observations, local memory and bounded decision loops.
They run concurrently under one trusted scheduler, not in separate process/container
sandboxes. Runtime decision models have no code-execution tool.

| Role | Allowed actions | Responsibility |
| --- | --- | --- |
| scout | request(WK-01..03), submit_flag, team tasks | Test the planted tenant-isolation weakness |
| deceiver | request(WK-01..03), submit_flag, team tasks | Submit the fixed untrusted telemetry fixture |
| pressure | request(WK-01..03), submit_flag, team tasks | Occupy bounded service capacity |
| policy | read_events, list_rules, write_rule | Protect its own namespace |
| availability | read_events, list_rules, write_rule | Preserve service and recover from overblocking |

Request catalog IDs compile to fixed internal paths/payloads. No model-controlled host,
port, URL, payload, shell, filesystem or network tool exists. `observe` is the runtime's
scoped read of events/rules, not arbitrary database access. Attackers see team request and
capture summaries; defenders see evidence targeting their own namespace.

## Decisions and authorization

One iteration observes, selects one action, applies it and backs off. `wait` does nothing.
Rule writes include the observed version and evidence ID. Stale versions fail with 409;
the next iteration reads current state. The server derives actor identity from credentials
and verifies namespace ownership. Only the referee starts, stops or rotates matches.
There is no score-write API. Captures require the current private random token.

The fixture policy is deliberately vulnerable to WK-02 in both modes. Hardened mode adds
a service-side authorization check. Never label fixture results as AI behavior or silently
substitute fixtures after inference failure.

## Validation

Run `npm test` after runtime changes. Use a bounded comparison after scheduling, scoring,
capacity or rule changes. Inspect request counts, agent errors and referee checks.
Wall-clock scheduling and model decisions need not reproduce identically. Do not infer
perfect security or availability from one run. See `docs/SANDBOX_VALIDATION.md`.

Preserve the service boundary and authorization invariants when extending the catalog and
tool schemas. Third-party targets, arbitrary runtime code execution, and unrestricted
network capabilities are outside this experiment. Check off TARGET_SPEC acceptance items
only when their evidence exists; do not describe pending requirements as implemented.
