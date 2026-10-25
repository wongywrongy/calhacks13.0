# Maincloud runtime

Production uses the Rust `arena-live` module on SpacetimeDB Maincloud, the existing
Vercel project for static frontend assets, and Bitdeer for inference. The synthetic
fleet is separate from the local HTTP scenario suite. No real aircraft are involved.

Database: `sudoko-maincloud-20261025` at `https://maincloud.spacetimedb.com`.
The previous `sudoko-chat-live-20261024` database is retained intact for rollback;
publishing a module does not copy its rows or grants. New-session defaults come from
`shared/fleet.json`; publishing preserves the current session count and role grants.
New sessions have zero agents until prompted.

`backend::hosted` in `arena-live/src/maincloud.rs` schedules conversation decisions and
specialist loops. It reuses the existing prompts, chat tables, plan validation,
versioned policies, and evidence-producing action reducers. Movement remains scheduled
independently of inference. More drones do not create more model calls.

Admission writes a durable job and schedule. A short transaction claims the job,
reserves its budget, and snapshots its input and policy version. The procedure calls
only the fixed Bitdeer HTTPS endpoint outside the transaction. The completion transaction
rechecks the epoch, conversation, live session, operation cancellation, original caller's
current role grant, assignment, deadline, and policy version before applying an action.
Duplicate jobs cannot claim twice. Duplicate message keys accept only identical input.

Limits: four concurrent inference reservations globally, one pending conversation and
one operation per role, one to four specialists per operation, eight decisions per
specialist, 33 model calls per operation including its coordinator, a 75-second operation
deadline, a 30-second conversation deadline, and a 20-second HTTP timeout. Deadlines have
scheduled watchdogs. Cancellation/reset cannot abort a provider request already sent;
its result cannot apply, and it continues occupying its reservation until HTTP returns
or the enforced HTTP timeout plus one second of watchdog grace has elapsed. An operation
deadline alone does not release an outstanding HTTP reservation. Failures are recorded without fixture replacement or provider retries.

The installed CLI/SDK is 2.13.0, with Rust's `unstable` feature enabled for procedures.
A separate hosted capability probe verified a scheduled procedure, server-side environment
access, and a real Bitdeer HTTP 200 before the runtime port. Its 20-second timeout worked
on Maincloud despite an older 500 ms comment in the installed HTTP client's source.

## Database storage and compatibility

[ARCHITECTURE.md](ARCHITECTURE.md) is the production entry point. The database storage,
scoping, retention, migration cutover and local scheduling measurements are documented in
[DATABASE_DESIGN.md](DATABASE_DESIGN.md). Hosted assignments and history now live in private
typed/current and history tables; the existing public operation/chat row shapes are preserved.
Reset swarm cancels old-epoch work and preserves conversation history. Reset Demo and New Chat
advance conversation generations and hide earlier chats. Simulation views remain current-epoch. Follow the
migration runbook before publishing this schema to an existing database; it requires an
acknowledged client disconnect and a bounded owner backfill, never `--delete-data`.

## Persistent bounded missions

The production loop remains in `arena-live/src/maincloud.rs`; no second scheduler or
workflow framework is introduced. The Node chat service documented in `FLEET_CHAT_API.md`
is a separate compatibility path and retains its existing finite worker loop.

Review confirmed that current specialists already reassessed fallible commands; they did
not universally end after one attempt. The remaining production limitations were terminal
waits, immutable targets, missing teammate context, coarse terminal statuses, and chat
rendering that hid durable plan/outcome content. Fleet size alone still cannot multiply
useful work: the coordinator must choose complementary objectives and routes.

The coordinator chooses 1–4 typed assignment goals and up to eight candidate target IDs
per specialist. `shared/fleet-goals.json` describes the server predicates. The simulator
verifies them; model explanations never establish completion. Candidate IDs are alternative
assignment targets, while spread retains the simulator's existing local-neighbor scope.
The initial plan persists immutable completion conditions: each assignment must achieve its
typed goal on one of its approved targets. Individual required targets use singleton scopes;
retargeting changes the worker assignment, not that mission contract. An explicitly selected
target restricts the entire scope to that target. Identical
active target/goal pairs are rejected, and same-role attempts on one target serialize.

Each durable job observes current role-scoped state, recent measured receipts, teammate
assignments, evidence handoffs, available routes, and the remaining original budgets.
Discovery needed before entry is a server observation and makes no specialist inference
call. Structured decisions contain an action, target, optional teammate recipient, a short
operator-facing explanation, and supplied evidence IDs. Reassignment and handoff are
validated atomically against the original scopes and current teammate ownership.

Actions resolve once through the existing scheduled, seeded simulation. A resisted attempt
does not close the assignment if useful alternatives remain. The existing state-dependent
strategy fingerprint blocks equivalent attempts without new conditions. Wait schedules a
1.5-second pause and fresh observation. Three waits against equivalent relevant state close
the assignment as blocked; pending relevant attempts/countermeasure expiry use bounded
one-second checks without inference. Neither ticks nor polls append activity messages.

When assignments close, at most two coordinator reassessments may revise blocked specialists'
targets. Replanning reuses identities, goals, action sequences, scopes, the 33-call total,
and the original 75-second deadline, including initial planning. Provider failure/refusal
does not trigger a replan retry or a fixture decision. No useful choice, an already satisfied
goal, and budget bookkeeping require no model call. A policy change during inference defers
the decision and causes fresh observation instead of recording a simulated attack failure.

Assignment lifecycle, individual attempts, provider execution, and mission outcome are
separate durable records. Mission records distinguish `verified_success`,
`partial_completion`, `blocked`, `budget_exhausted`, `deadline_exhausted`, and
`execution_failure`, and `cancellation`; the existing `cancelled` operation state fences
cancellation. Already completed assignments keep their historical lifecycle when a mission
is cancelled. Final
verification rechecks previously completed conditions against current simulation state.
The same existing chat bubbles, cards, history and Activity rows show acknowledgments,
meaningful plan adjustments, handoffs, target changes, and an evidence-backed terminal
summary. Terminal specialists leave active counts immediately. Suggestions continue to use
the existing deterministic eligibility cache; no suggestion model calls are added.

Job state/operation and attempt stage/operation indexes bound scheduler lookups. Terminal
jobs discard provider request bodies, retaining decision results and inference metrics.
Hosted admission caps history at 200 turns per role, preserving mission/evidence history
instead of silently deleting it. Archival beyond that cap is not implemented; this remains
a bounded demo session, not unattended multi-day hosting.

## Local mission validation

```sh
npm run spacetime:build
npm run build:fleet
SPACETIME_BINARY=/path/to/spacetimedb-standalone npm test
cargo test --manifest-path arena-live/Cargo.toml --lib
npm run typecheck
```

Install the Playwright Chromium matching the installed package, or set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an installed Chromium executable.

`maincloud-mission.test.ts` builds a separate `mission-fixtures` WASM under
`arena-live/target/mission-fixtures`, with owner-only reservation/reply seams and disabled
Bitdeer HTTP execution. It injects explicitly labelled **Fixture decisions** into the same
reservation and commit functions used in production, against a temporary real database and
its real scheduled simulation. The default production build has no fixture endpoints;
a production-procedure check verifies missing provider configuration fails honestly.
**Never deploy the fixture WASM.** It is not credentialed model evidence.

The tests exercise resisted entry followed by a different eligible decision, wait/resume,
retarget/handoff rejection and acceptance, bounded replanning, provider refusal without
retry, verified completion/roster cleanup, global admission/exhaustion/deadline enforcement,
active-attempt database restart, idempotent replay, and cancellation/reset fencing. A local
browser uses the Maincloud subscription adapter and existing UI to verify durable replies,
terminal summary, active-card removal and reload without duplicate effects; desktop/mobile
screenshots go to ignored `output/mission-loop/`. Browser checks use headless Canvas fallback,
not a hardware GPU benchmark. The HTTP practice comparison remains separate fixture evidence.

That validation was fixture-only. The later [end-to-end audit](AUDIT_2026-10-25.md) adds
credentialed local Bitdeer evidence and read-only production browser checks; it does not
claim that the current release was deployed.
Queued legacy assignments fall back to their original single target; an in-flight reply
using the old output schema fails validation visibly instead of being silently converted.
A populated disposable database upgrade/backfill is covered in DATABASE_DESIGN.md.
The earlier typed-storage cutover is present in production; the audit fixes still need deployment.

Mission-loop verification before the database-design changes on 2026-10-25: **73 Node tests passed, zero failures/skips**, with
SpacetimeDB 2.13.0 and an explicitly configured installed Chromium binary; **11 native
Rust tests passed**. TypeScript checking, release WASM compilation, the fleet bundle, and
both binding generations passed; generated public binding schemas remained unchanged.
The separate `scripts/check-fleet-activity.ts` browser check also passed with no page errors,
including concurrent interruption, suggestions, reset, desktop and mobile. Its roster wait
now covers the existing 75-second mission deadline instead of assuming all delayed attempts
end within 30 seconds; no runtime limit was increased.

The separate four-second-per-mode HTTP fixture comparison (`3` attackers, `2` defenders,
`4` clients per team) had zero agent/infrastructure errors. Baseline offered 58 attack and
193 legitimate requests, with 193 legitimate completions and 9/20 passing isolation probes.
Hardened offered 60 attack and 212 legitimate requests, with 211 legitimate completions and
18/20 passing isolation probes. Each mode recorded one verified capture. This is one short
fixture sample, not evidence of model behavior, perfect security, or fleet mission success.

## Deploy

First follow [the schema migration runbook](DATABASE_DESIGN.md) for existing databases;
the simple publish command below alone does not backfill old rows.

1. Build and test the module: `npm run spacetime:build`, `cargo test --manifest-path arena-live/Cargo.toml`.
2. Supply `BITDEER_API_KEY` in the publisher's environment and publish without clearing data:
   `spacetime publish sudoko-maincloud-20261025 -s maincloud --bin-path arena-live/target/wasm32-unknown-unknown/release/sudoko_live.wasm --delete-data=never --yes=remote,skip-login`.
   The declared key is stored in SpacetimeDB's private environment. Never put it in Vercel's
   frontend configuration, a table view, a prompt, or a browser credential.
3. `npm run maincloud:prepare` provisions attacker/defender identities and saves scoped
   demo configuration under ignored `output/maincloud/`. It never resets existing data.
   On a new empty database only, initialize with `spacetime call -s maincloud sudoko-maincloud-20261025 start_fleet "$(node -p "require('./shared/fleet.json').drones")" 0 0 false -y`.
4. `npm run test:maincloud` checks the real connection, the configured number of updating rows, subscriptions,
   private-table denial and owner-only mutation rejection. Add `-- --live` only for an
   explicitly intended paid model interaction and shared reset: it verifies takeover,
   defense, reconnect, budgets, concurrency and rejection of an in-flight completion after reset.
5. Supply `FLEET_MAINCLOUD_CONFIG_JSON` to the Vercel build, or a local file path through
   `FLEET_MAINCLOUD_CONFIG`. `npm run build:vercel` refuses a missing configuration.
   The existing Vercel project has the JSON variable for Preview and Production.
   Deploy the static output after verification. `/fleet-config` resolves to that static
   JSON; no production routes proxy to Neo, Tailscale, Node, or an inference API.
6. `node scripts/check-maincloud-browser.ts` inspects the deployed browser read-only using
   the current Attack, Defend and Observer controls, refresh and laptop/narrow layouts.
   It never extracts role credentials for probing, sends missions or resets shared state.
   Use `MAINCLOUD_FRONTEND_URL` for a candidate. `--send` and `--reset` are rejected.
   For actual provider/browser missions, run `node scripts/check-judge.ts --real` with
   `SPACETIME_BINARY`, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` and an authorized server
   `BITDEER_API_KEY`. It builds the current frontend and provisions a disposable local
   database using the production WASM, then closes it after testing. It permits at most
   100 calls; set `JUDGE_PRIOR_REQUESTS` to the actual earlier count for repeated checks.
   No production database is used.

Observer requires its own granted read-only identity. Re-run `maincloud:prepare` after
reviewing the intended database; it adds a missing observer grant without resetting data.
Update the existing frontend configuration with that observer workspace and
`switchableRoles: ["attacker", "defender", "observer"]`. The static build now rejects
configuration missing any of these workspaces. Provisioning and deployment are rollout
steps; local verification does not make Observer available in the currently deployed app.
Overview follows `docs/design/sudoko-observer-assessment.html`: session results, an
expandable incident timeline, and a selectable fleet grid with Now/Session views. Spread
results share an incident; recovery requires paired unauthorized denial and legitimate
acceptance. Untested targets stay unknown. The session epoch fences earlier results.

**Analyze session** requests one server-side GLM-5.3-Flash call through the existing
inference scheduler. The observer may submit only this fixed request, without a target;
server validation rejects deployment, replacement, tasks and unknown evidence references.
Analysis uses all current drone observations and the latest 64 evidence records, and is
labelled model commentary with its source, model, request time, latency and errors. It
cannot change fleet state or certify outcomes. Refusals/timeouts remain visible failures,
with no fixture fallback. Existing concurrency, timeout and lifetime admission limits
apply (at most 200 observer analyses per database). Reset hides old analysis and rejects
late results. This requires deploying the updated module and frontend together; no table
schema or generated binding changes are needed.

The browser subscribes directly to identity-scoped fleet/chat views and invokes scoped
reducers through SpacetimeDB. Maincloud reconnect uses Maincloud again, without an API
proxy fallback. The public demo deliberately offers both role credentials through its
Attack/Defend controls. They cannot grant roles, read private tables, start fixtures, or
publish code. Defender may reset the shared demo; attacker may stop its own operation or
start its own new chat. These are shared demo workspaces, not individual user accounts.
The publisher identity and Bitdeer key remain server-side.

## Verification evidence

`output/maincloud/live-verification.json` (and `connection.json` for read-only checks) records the real backend check; `browser/report.json`
records the browser check. Private artifacts stay outside git. The initial hosted check
observed two concurrent model calls, two accepted unauthorized commands, two versioned
policies and two verified recoveries; reset rejected stale work and discarded a real
in-flight completion. This bounded run is not a security guarantee or a statistical
availability evaluation. The Findings drawer keeps observed evidence distinct from
unverified susceptibility or spread.

The local commit `d984de7` and branch `feat/compact-fleet-75` were absent from local refs,
worktrees, unreachable commits and the remote's branch listing. Available uncommitted
fleet/reset/resilience/viewport work was preserved on `preserve/pre-maincloud-workspace`
and integrated with latest main `be8a54b` on `feat/maincloud-runtime`. Compact controls,
Activity, viewport, concise conversation, and the newer judge/findings flow are retained;
the default is read from `shared/fleet.json` (200 actual persisted drones).

Fleet defaults, layout and cap live in `shared/fleet.json`. Rust embeds this file at build
time; TypeScript imports it. Rebuild WASM and browser assets together after a change.
Updating code does not reset an existing session. An owner can grow an active persistent
fleet in place with `grow_fleet(epoch, 200)`: existing drones, agents, evidence, policy,
mission budgets and the shared clock are preserved. New drones receive their own movement
schedules and battle state. Growth is epoch-fenced, idempotent and bounded by the existing
256-drone ceiling; viewers cannot invoke it, and shrinking is rejected. `start_fleet` still
resets battle/chat state and is not required for this growth.

## Selected-target admission fix, 2026-10-25

Production requests such as “Attempt entry on DR-001” exposed a contract mismatch:
coordinators were told to create at least two specialists while duplicate target/goal
assignments were rejected. A real Bitdeer reproduction returned valid JSON with one
capture task and cited evidence from earlier recon on drones 1 and 2. The server rejected
both the singleton count and evidence outside its selected-target-only context.

Plans now allow one to four useful assignments. Multi-target work still defaults to two
complementary specialists. Coordinators observe all evidence visible to their own role;
selected targets still restrict action authority. Coordinator/replan citations are checked
against the observations supplied at reservation, while current permission, epoch,
generation, deadline, assignment and policy checks remain in force at completion.
Duplicate work, forged evidence and out-of-selection assignments are still rejected.

Verification: **79 Node tests, zero skips/failures; 14 native Rust tests; TypeScript,
release WASM and Vercel static build.** An actual credentialed local run completed recon
on two drones, then used one specialist on selected DR-001: prepare → command →
server-verified capture, with three calls for that mission. This is local provider evidence,
not a claim about every possible model response. No shared production reset was used.

## Suggestion interaction and discovery replies, 2026-10-25

Live snapshots previously rebuilt suggestion buttons when unrelated telemetry changed,
which could detach a pressed button before mouse-up. Rendering now compares the actual
offers and reuses the existing list patcher. Buttons show their disabled state while a
request is being sent or awaiting its reply. Submission errors use the existing status
area and survive successful cache refreshes; connection errors remain separate.

An explicit SDK `SenderError` now clears the rejected pending submission, matching HTTP
4xx handling. `UnknownCallResultError` still preserves the same idempotency key for retry.
Tab acceptance carries the offered target scope through Enter instead of silently using
the currently selected drone.

Discovery suggestions name currently undiscovered, permitted catalog IDs. The ambiguous
“Discover drones on FC-01” template is removed. Coordinator context identifies FC-01 as
the existing fleet controller, and prompts/schema annotations distinguish operator replies
from routing labels and separate required targets from alternative scopes. A bare routing
label is rejected visibly; no fixture decision or fabricated clarification is substituted.

The browser regression holds a suggestion through an unrelated subscription update,
checks one durable submission, exposes a rejected follow-up, and then submits a Tab-accepted
broad question while a drone is selected. A real Bitdeer run in a disposable local database
verified recon on 1/2, followed by the new discovery suggestion verifying 3/4. These local
provider decisions are separate from fixture-driven UI tests. No production reset is used.
