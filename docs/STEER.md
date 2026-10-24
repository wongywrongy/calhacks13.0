# Implementation handoff

Use this brief for Claude, Codex, or a human contributor. `TARGET_SPEC.md` is the intended
design; `ARCHITECTURE.md` is the current implementation; `SANDBOX_VALIDATION.md` is existing
evidence. Runtime agents' restricted tools do not prevent a coding assistant from editing
the application and adding tests.

## Task brief

Continue SudoKO from the working `feat/multi-agent-sandbox` runtime. Build an owned synthetic
application where teams of concurrent attacker and defender specialists cause and measure
real HTTP behavior. Keep the fleet-themed board as a visualization of synthetic assets.
Implement actual application weaknesses, typed scenario variations, cooperative task
handoffs, bounded service pressure, defensive changes and independent verification. Do not
substitute a scripted battle, a chat-only exchange or a single actor per side.

The first slice is meaningful multi-agent choice and coordination: extend the typed catalog
within the same service, add bounded team task/evidence sharing, and demonstrate a handoff
and a version-conflict retry in tests. Preserve distinct credentials, scoped observations,
request budgets, private random artifacts and measured outcomes. Keep fixture/model modes
explicit. Follow the remaining acceptance gates in `TARGET_SPEC.md` in build order.

Use the existing Bitdeer adapter for the first real-model run; Claude need not be a runtime
dependency. If credentials or Docker are unavailable, implement and test the available
slice and mark those external checks pending. Do not invent results or silently use the
fixture engine in place of a provider response.

No third-party targets, real fleet equipment, arbitrary runtime shell execution or general
network access is needed. The catalog may grow through reviewed code and bounded schemas;
it is not frozen to the original three request templates. New cases must have tests showing
the actual service failure, the defense effect, and whether legitimate work still succeeds.

If a provider refuses, retain the exact error with secrets redacted, identify whether it
came from the coding assistant or a runtime decision call, and report the affected operation.
Do not disguise the task or attempt to bypass provider safeguards. Continue independent
implementation that is within scope and leave the blocked acceptance item visibly pending.

## Integration cautions

The fleet branch's timeline and unrestricted `seize`/`reclaim` reducers are prototypes.
Adding subscriptions does not by itself make their outcomes authoritative. Public flag/token
fields and caller-controlled team/score writes must be removed from the live path before
the board is connected. The service/referee owns outcomes; the database is an authenticated,
sanitized projection. Reclaim needs isolation verification, preserved utility and token
revocation under the relevant policy version.

When reporting work, list the acceptance items completed, tests and measured evidence,
remaining blockers, and exact files changed. Do not label the entire system finished merely
because the dashboard animates or more agent loops have been added.
