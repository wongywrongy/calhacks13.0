# Persistent virtual battle attempts

The fleet reducer simulation is separate from the synthetic HTTP referee suite. These
outcomes are **simulated effects**, not evidence of real exploitation or model susceptibility.
The existing telemetry/prompt-injection experiment continues to record the defender's
actual model choices; battle probability never labels an injection successful. There is
no new runtime network, code execution, malware or hardware interface.

## Root cause

There was no two-drone limit in the fleet. Plans defaulted to two specialists, permanently
assigned to one drone each. Workers stopped after their first `command`. Subsequent plans
could pick those same targets, and the command handler would simply write `attacker` again.
The catalog had no lateral-spread action. Commands and verified cleanup were synchronous,
so selection also meant immediate capture/recovery. This was repeated targeting plus a
single-target execution contract, rather than a stale subscription or an explicit fleet cap.

## Authority and lifecycle

`arena-live/src/battle.rs` extends the existing private SpacetimeDB fleet state. No second
service or frontend authority was introduced. Chat still validates identities, assignments,
epochs, action sequences, policy versions and operation budgets. A maximum of eight pending
attempts can run at once; each actor must await its preceding attempt. Operations remain
bounded to 2–4 specialists, eight decisions each, 33 model calls and 75 seconds.

`discover` is an immediate scoped observation; `wait` has no effect. All consequential
battle choices enqueue attempts. The existing reducer returns an idempotent action receipt,
initially without outcome evidence. A database scheduled reducer advances a logical tick
every 500 ms. Attacks progress through queued, preparing, executing and resolved over eight
ticks (~4 seconds); defensive attempts take four (~2 seconds). Preparation is itself an
attempt. Delays in the scheduler can extend wall-clock duration. No blocking sleep or
frontend animation resolves an effect.

At resolution the reducer reads **current** defenses, connections and contamination. It
rechecks operation authority, deadline and epoch (including hosted viewer grants), and
rejects obsolete defensive policy versions. Isolation or recovery of a spread relay can
interrupt the whole attempt. Isolation of individual targets can interrupt part of it.
The Node scheduler polls durable receipts without extra inference. Hosted orchestration
uses scheduled continuation callbacks without keeping a provider request open.

## State and permitted choices

Drones retain their existing `controller` and `isolated` fields. Private `battle_drone`
rows separately retain contamination (0–100), readiness (0–90), one capped preparation
flag per side, and the latest countermeasure tick. The logical communication graph is a
16-column grid: horizontal neighbors in a row, and IDs 16 apart. Presentation coordinates
and animation cannot change it.

- Attacker `command`: requires discovery; attempts entry on one uncaptured, connected
  target. This represents the existing planted virtual access path, not a real exploit.
- Attacker `spread`: requires a captured, non-isolated assigned relay; attempts up to
  three neighboring uncaptured drones. Each target resolves separately. There is no
  global two-drone capture ceiling and no automatic whole-swarm infection.
- Either side `prepare`: requires permitted target access; one successful preparation
  gives a capped bonus. Repetition cannot stack it.
- Defender `isolate`: attempts to sever a drone's incident graph links. Isolation keeps
  contamination/control intact, suspends formation commands, and lowers the drone out of
  the mission. Its operational cost persists until cleanup and release.
- Defender `harden`: attempts to raise readiness by 30, capped at 90, without isolation.
- Defender `verify`: fails eligibility when a contamination source remains connected;
  complete recovery requires isolation. Success runs the existing unauthorized-denial
  (403) and legitimate-control (200) probes under one policy version, clears contamination,
  restores defender control and clears its movement hold. A near miss can reduce
  contamination without restoring control. Isolation persists.
- Defender `release`: requires clean defender control; attempts to restore participation.

Compromised or partially contaminated drones (contamination >=40) create local exposure
opportunities while connected. Exposure increases subsequent attack chances; it does not
passively capture neighbors. A near miss grants 40 contamination, capped at 80, while
control remains with its existing owner. Recovery can reduce contamination. Reconnecting a
clean recovered drone beside an active source creates renewed exposure.

## Quality, probability and retries

The model proposes a bounded action, not its outcome. Target and route choice, genuine
observation, successful preparation and current conditions determine feasibility/quality.
No prompt wording, objective length, agent name or claimed evidence adds a bonus.

Eligible target attempts use a bounded 5–90 percent chance. Entry starts at 40%, spread
at 35%, recovery at 60%, isolation at 75%, release at 80%, preparation/hardening at 85%.
Attack modifiers: +12 per connected contamination source (at most two), +10 for an existing
foothold/limited local access, +15 for preparation, minus half the target's readiness and
minus 20 for a recent countermeasure (24 ticks). Defense modifiers: +15 for preparation,
plus a quarter of readiness, minus 12 per connected source (at most two). Isolation removes
incident sources before recovery. A miss within 15 percentage points (capped below 95%)
can cause limited attack access or partial cleanup; other misses have no such effect.
Missing prerequisites are recorded as ineligible, with no roll.

The private session seed defaults to 13. The publisher may call `set_battle_seed(seed)`
before the first attempt for a reproducible comparison. Stable FNV-1a hashing uses the
seed, strategy, target and relevant state. Neither fresh operation/agent IDs nor repeated
requests buy fresh independent rolls. Failed/evaluated condition fingerprints persist;
unchanged retries are ineligible. A changed route, foothold, preparation, readiness or
countermeasure condition can justify another attempt. Rejected attempts still spend time
and an operation decision. Explicit defender hardening/isolation changes the opportunity.

Replay requires the same seed **and ordered actions/conditions**, not just the same prompts.
Concurrent model outputs and wall-clock ordering are not promised to reproduce. The seed
stays in the private `battle_state` row rather than model observations.

## Live UI contract

The web client subscribes to the authoritative battle and task views. Both browser and sandbox bindings are regenerated from the module. Controller, contamination and availability remain distinct in drone details and viewport markers.

Role-scoped subscriptions include:

- `visible_battle_drones`: `{drone, contamination, operational, readiness}`. Join on drone
  ID to existing controller state. Attackers see only discovered drones, and readiness is
  redacted to zero for that role. `operational` reports mission participation separately
  from controller/contamination. It is not equivalent to “clean.”
- `visible_battle_attempts`: `{key, agent, target, kind, stage, report}`. `report` is JSON.
  Only own attempts are returned, except the observer can see both. Opponent plans are
  private; defenders see local command/limited-access evidence from the existing views.

`GET /api/chat/state` includes `battle`, enriched `attempts`, `options`, `tasks` and `teams` arrays. Existing
operation result objects also carry `stage` and parsed `simulation` reports while pending
and after resolution. A report contains `simulated:true`, concise `summary`, `outcome`,
`succeeded`, `partial`, `total`, and per-target `results` with eligibility, reason, numeric
chance factors and the roll (null for ineligible targets). `status:executed` means the
attempt resolved, not that it succeeded. Spread receipts may cover multiple target IDs;
the original assigned target is the relay. Use `simulation.results` for affected drones.

Stage and resolution summaries are supplied through authoritative attempt/activity views instead of appending chat messages for each stage. Provider decision/usage/error records remain separate from simulated effects. `fleetOutcome`
counts resolved effects, keeps containment separate from completed recovery, and distinguishes partial completion. A provider
refusal/error remains a provider failure and never falls back to a simulated choice.

Examples emitted by the engine include preparation/spread progress, interrupted relay
attempts, per-target partial success, and recovery failure due to connected contamination.
Models' own summaries remain untrusted text; the authoritative report determines effects.

## Reset, evidence and practical limits

Both shared swarm reset APIs cancel operations/turns, remove pending attempt and queued hosted
inference timers/jobs, advance the epoch and both conversation generations, and clear
contamination, preparation, readiness, retry fingerprints, discoveries, holds, ownership
changes and action evidence. Role grants remain. Every old scheduled callback checks its
epoch before applying state; old provider completions cannot deploy into the new session.
Outstanding provider HTTP requests retain a private reservation and timeout watchdog until
they return; their epoch is stale and they cannot affect the new session. This preserves
the global four-call cap across repeated resets. New Chat remains a separate role-local
conversation operation.

`SPACETIME_BINARY=... npm test` includes `sandbox/test/battle.test.ts` against real temporary
databases. Its explicitly seeded fixtures exercise >2 captures, partial contamination,
failed entry/defense, repeat rejection, connected-source recovery rejection, local
containment/recovery, countermeasure interruption, reproducible outcomes, persistence and
reset during an attempt. Existing mocked-provider tests cover chat/authentication and
provider failures; they are not evidence of autonomous strategy. Rust tests check graph
boundaries and bounded quality modifiers. The HTTP suite remains independent.

This is a hackathon ruleset: fixed grid topology, capped preparation and simple readiness,
no calibrated real-world attack probabilities, no automatic passive infection, and no
long-term history compaction. Database scheduling may drift under load. Live credentialed
Bitdeer/Maincloud execution and UI integration of the new views require their own checks;
compilation and seeded fixture outcomes do not establish those claims.

## Local seeded comparison, 2026-10-25

These checks used a real temporary SpacetimeDB instance with 32 virtual drones. Actions
were test fixtures; no live model is credited with these choices.

| Condition | Observed simulated result |
| --- | --- |
| Seed 2, entry on 1 and 18, then spread from 18 | Four drones controlled; drone 19 gained limited contamination while remaining defender-controlled; distant drone 32 stayed clean |
| Same seed and entry conditions after a fresh epoch | Identical resolution reports despite fresh operation and agent IDs |
| Recovery on 1 with a source connected | Ineligible; no cleanup roll |
| Isolation attempts on 1 and 18 after spread | Drone 1 contained (22 < 51); drone 18 resisted (78 >= 51) |
| Verify, then release drone 1 | Contamination cleared, control restored, then mission participation restored |
| Re-enter released drone 1 beside remaining sources | New eligible attempt; renewed compromise while prior readiness/countermeasures still modified the chance |
| Seed 4, entry on 8 | Failed (85 >= 40); two unchanged retries were ineligible rather than gaining fresh rolls |
| Seed 2, spread from 18 while defense isolates 18 | Isolation resolved first (28 < 75); spread interrupted and drone 2 stayed clean |
| Database restart | Controllers, contamination and readiness persisted |
| Reset during pending entry | Pending attempts/timers/jobs removed; stale action rejected; new epoch remained clean after the old completion window |

The new views also passed ungranted-role isolation, private-table denial, seed-mutation
denial, readiness redaction, own-attempt scoping and attacker-identity redaction checks.
