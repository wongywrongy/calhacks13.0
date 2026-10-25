# Sudo-KO synthetic resilience simulation

This is an application-owned world, with no real aircraft, vulnerability exploitation,
credential collection, network scans, external targets, or runtime code execution.
The existing backend, Bitdeer adapter, strategic chat, role subscriptions, and 3D viewport
are reused. No framework or dependency was added. Private tables and scoped views are
additive; existing persisted table schemas are unchanged.

New chat fleets start with six drones and no scheduled decision fixtures. Explicit
`start_fleet(6, 0, 0, false)` also selects this mode. Existing non-six-drone sessions are
preserved; an operator can start a six-drone session through the existing fleet start API.
The old HTTP suite and larger explicitly selected fixture fleets are separate experiments.
This mode rejects the legacy control-transfer action.

## Mission and decisions

Each drone surveys 45 packets, one per healthy second. The fleet must deliver 270 packets
within 60 seconds. The mission waits in `ready` until the first scenario or defense action,
so reading the interface does not use mission time. Mission completion is the sum of
committed drone progress, capped at each drone's quota. Reducer time and input order define
outcomes; model prose cannot establish damage, containment, recovery, or a winner.

Challenge actions have fixed scope of one assigned, discovered drone. At most two events
can be active on a drone, and at most six fleet-wide. Each team gets 40 cost units per epoch.
Rejected bounded attempts still cost resources; idempotent replay spends nothing extra.

| Typed event | Cost | Duration | Cooldown | Deterministic effect |
|---|---:|---:|---:|---|
| `telemetry` | 3 | 8 s | 10 s | Primary sensor differs by 12 m; uncorroborated guidance stalls survey work and drifts |
| `invalid_command` | 2 | 4 s | 6 s | Fixed expired timestamp or unknown simulated identity is rejected; unfiltered provenance consumes half the command capacity |
| `communications` | 3 | 8 s | 10 s | Odd drone IDs lose packets; even IDs get one-quarter throughput; positions lag |
| `mission_conflict` | 2 | 6 s | 8 s | Two fixed conflicting proposals on the untrusted channel stall mission guidance |
| `malfunction` | 4 | 10 s | 12 s | Actuator fault causes drift and stops survey progress |

Synthetic command validation checks identity, expiration and future timestamps. It never
authorizes flight control. Scenario events are private rows; the movement reducer derives
behavior and measured work loss from admitted events. `challenge_effect` is emitted only
when an admitted event actually reduces an unfinished drone's work. A scheduled receipt
alone is not challenge success.

| Defensive action | Cost | Effect |
|---|---:|---|
| `cross_check` | 2 | Compares sensors/provenance, records detected evidence, validates guidance against conflicting proposals |
| `reject_invalid` | 1 | Filters the fixed invalid provenance before it consumes command capacity |
| `quarantine` | 3 | Grounds one drone and stops its mission work |
| `switch_route` | 2 | Bypasses the disrupted primary communication route |
| `reassign` | 3 | Compensates for a malfunction at half throughput |
| `restore` | 2 | Requires a cross-check within 10 s and all active problems mitigated/expired; clears quarantine, resolves events, restores full participation |

A healthy verification is labeled `participation_verified`; it does not count as recovery
of an incident. Isolation does not improve mission progress. Isolating the entire fleet
stops the mission; unnecessary isolation accumulates measured drone-seconds.

Two to four specialists per side run concurrently through the existing scheduler. Each
gets at most eight decisions and an operation lasts at most 75 seconds. A blocked scenario
gets a committed 403, 409 or 429 receipt, so the next decision can choose a different event
or wait with fresh observations. Opposing operations share the fleet epoch, not private
plans. Provider errors/refusals remain visible and never trigger a fixture fallback.

## Authority, privacy and reset

Existing reducers enforce backend lease, agent/target assignment, role, epoch, deadline,
sequence, idempotency and defense policy version before any transition. New reducers run
inside that same transaction and enforce scenario bounds, costs and cooldowns. Runtime
models receive only typed enums, budget, their own assignment/memory, scoped observations
and visible evidence; database owner credentials stay in the trusted backend.

`visible_resilience_mission`, `visible_resilience_drones` and
`visible_resilience_budget` are identity-scoped. Challenge views contain discovered
operational observations and challenge outcomes, without defensive protection flags,
corroborated sensors, detection timing or defensive budget. Defense sees observed symptoms
and its own policy/evidence, without challenge scenario rows or private plans. Only an
explicit cross-check resolves evidence labels. Unassigned identities receive no rows.
All telemetry, objectives and proposal text are untrusted data and grant no permissions.

The existing demo **Reset Arena** action advances the epoch and both conversation
generations atomically, cancels active/planning operations and pending inference turns,
clears agents, profiles, discoveries, disruptions, receipts and simulation evidence,
restores policies, replenishes budgets and resets mission progress. Earlier chat remains
private audit history outside the new generations. Queued old-epoch actions cannot apply.
Other connected views adopt the new epoch/generation; refresh is not a reset mechanism.

## Verification and limits

`npm test` with `SPACETIME_BINARY` covers real reducer admission, all five scenarios,
command provenance/expiry, challenge damage, recovery, cooldown adaptation, idempotency,
ordering, stale versions/epochs, private views, budget exhaustion, and whole-fleet
isolation cost. Rust unit tests also check catalog bounds and timestamp edge cases.
`npm run test:resilience` exercises browser chat through explicitly mocked inference,
real SpacetimeDB, concurrent opposing workers, action cards, mission completion, reload,
mobile layout and cross-client reset. Sanitized evidence and screenshots are written to
`output/resilience/`. Mocked decision checks are not evidence of autonomous AI strategy.
`npm run smoke:resilience` now runs `scripts/check-resilience-live.ts` against
`https://sudo-ko.us` and its existing persistent database, using actual configured
Bitdeer models. It never starts or resets a database and preserves failures. The
isolated browser harness remains available as `test:resilience` for development tests.

Mission metrics are completion, lost work, mean incident-to-cross-check detection delay,
mean incident-to-resolution recovery time (including natural expiry), and unnecessary
isolation duration. Scheduling is best effort; reducer rules are deterministic for the
same ordered inputs/timestamps, but wall-clock schedules and model decisions vary.

Limits: six drones, fixed synthetic event variants, two to four specialists per role,
one active operation per role, finite action/model budgets, and a shared trusted scheduler.
Reassignment represents reserve capacity rather than a second physical vehicle. This is
not a hardware, radio, flight-controller or OS/container isolation test. Historical
non-six-drone fleets retain their legacy behavior. Exposed-service isolation and sustained-load behavior require separate verification.
The deployment below uses the existing persistent database and public application.

## Recorded verification (2026-10-25)

- TypeScript, the WASM build and all five Rust tests passed.
- The full Node suite passed all 41 tests against local SpacetimeDB; this includes
  legacy HTTP/chat regression checks as well as resilience checks.
- The final mocked browser check completed all 270 packets, verified challenge damage,
  restoration, a failed-action follow-up, mobile layout, reload and shared reset.
  Its pre-reset metrics and full event chain are in `output/resilience/mocked/evidence.json`.
- A real `zai-org/GLM-5.3-Flash` run completed 270/270 packets, with 4.990 drone-seconds
  of lost work, mean detection 3.405 s, mean recovery 6.047 s, and 0 unnecessary isolation.
  Both operations finished, with partial assignment success on one contested drone.
  Actual workers waited after a cooldown rejection and attempted different actions after
  concurrency rejections; successful alternate-disruption adaptation is demonstrated by
  the separately labeled mocked check, not claimed from model prose.
- The first actual-provider check reached challenge damage but timed out waiting for two
  deployments; the check did not retain enough diagnostics to establish the cause.
  The next check corrected admission diagnostics and passed without fixture substitution.
  Its per-action receipts are in `output/resilience/bitdeer/evidence.json`. That reporter
  version overwrote top-level event/mission data after reset, so the measured stdout
  summary is retained separately in `output/resilience/bitdeer/stdout-summary.json`.
  The reporter now keeps pre-reset data and reset state separately.

These are bounded mechanism and smoke checks, not a statistical comparison or a guarantee
that a later model run selects the same plan, targets, containment or recovery actions.

Implementation files: `arena-live/src/resilience.rs`, `arena-live/src/fleet.rs`,
`arena-live/src/backend.rs`, `sandbox/src/resilience.ts`, `sandbox/src/fleet-chat.ts`,
`sandbox/src/fleet-outcome.ts`, `sandbox/src/fleet-web.ts`, `web/fleet.ts`,
`web/fleet.html`, `web/fleet-chat.ts`, `sandbox/test/resilience.test.ts`,
`scripts/check-resilience.ts`, `package.json`, and `README.md`. Legacy checks now select
48 drones explicitly in `scripts/check-fleet-chat.ts`,
`scripts/check-fleet-conversation.ts`, and `scripts/check-fleet-experience.ts`.
Both `web/module_bindings/` and `sandbox/module_bindings/` contain regenerated indexes,
types and the three new `visible_resilience_*_table.ts` view bindings.

## Existing live connection

The public application at https://sudo-ko.us uses `sudoko-chat-live-20261024`, the
same persistent database used before resilience mode. The trusted backend reaches
that instance on its private host interface; browsers receive the existing public
SpacetimeDB subscription URI or authoritative snapshots through `/api/chat/state`.
No ephemeral database, new database credentials, or database clear is used by the live
application or `smoke:resilience`.

The module was updated in place with existing authority/history preservation checks,
only `sudoko-chat-backend.service` was restarted, and the authenticated operator API
started the requested six-drone session. Prior operations and conversation audit rows
remain stored. The matching frontend is production deployment
`dpl_bm9V7aGVrEgTMuCHMtEn11QKLZHB`; its staged bundle hash matched the local build before
promotion to the existing domains. No DNS, ingress or database permission changes
were made. Deployment and live-check artifacts are in `output/resilience-live/`.

The public connection check passed for both team views, six defender-visible drones,
scoped budgets/observations, real provider configuration, and epoch persistence after
reload. Both production domain bundles match the staged build. The paid live run committed
challenge and defense actions to epoch 11, but its strict restoration check failed:
`No measured defensive restoration`. Cross-checking and route changes executed; restore
receipts reported healthy participation verification after events expired, which is not
incident recovery. No fixture fallback or reset was used to turn that result into a pass.
The failure and per-team receipts remain in `output/resilience-live/smoke.json`;
connection evidence is separate in `output/resilience-live/connection.json`.
