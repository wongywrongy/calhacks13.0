# Fleet database design, migration and measurements

The production path and trust boundaries are in [ARCHITECTURE.md](ARCHITECTURE.md).
This change preserves the existing UI and its three chat view row shapes. No shared
production publish/reset or credentialed Bitdeer run was performed.

## Supported APIs

Both Rust and TypeScript SDKs and the installed CLI are pinned to **2.13.0**. The official
web guide currently labels the 2.x documentation “2.0.0”; the proposed Rust APIs were also
checked against the installed 2.13.0 SDK source and compiled into release WASM.

- [Architecture and module concepts](https://spacetimedb.com/docs/core-concepts/):
  reducers own transactions, database state and subscriptions.
- [Tables and indexes](https://spacetimedb.com/docs/tables/indexes/): compound B-tree
  indexes serve `(role, epoch, generation)` and existing state/operation lookups.
- [Views](https://spacetimedb.com/docs/functions/views/) and
  [subscriptions](https://spacetimedb.com/docs/clients/subscriptions/): identity-scoped
  views over private tables remain the server-enforced visibility boundary.
- [Schedule tables](https://spacetimedb.com/docs/tables/schedule-tables/) and
  [procedures](https://spacetimedb.com/docs/functions/procedures/): durable schedules invoke
  reducers/procedures; external HTTP occurs outside explicitly opened transactions.
- [Automatic migrations](https://spacetimedb.com/docs/databases/automatic-migrations/)
  support new tables/indexes and trailing defaulted columns.
  [Incremental migrations](https://spacetimedb.com/docs/databases/incremental-migrations/)
  provide the separate-table/backfill pattern for changing representation.

The 2.13.0 migration planner disconnects clients for column addition even on these private
tables. Its default compatibility policy correctly rejected the first disposable rehearsal.
The test then used the official `pre_publish` plan/token and explicit `BreakClients`
policy, **without clearing data**. The CLI exposes the corresponding `break-clients`
confirmation. See the [versioned publish API implementation](https://github.com/clockworklabs/SpacetimeDB/blob/v2.13.0/crates/client-api/src/routes/database.rs).
Public view fields are projected through `OperationRow`, `MessageRow` and `TurnRow`,
retaining their original field names, order and types.

## Changes and ownership

`backend_chat` gains a default-zero generation; turns/messages gain default-zero epoch
and generation, all appended at the end. Scope indexes select actual conversation members.
The zero defaults mean **not backfilled**, not a current scope. No role receives a broad
public history scan as a workaround. New writes fill scope fields at admission.

The new private `hosted_workflow`, `hosted_assignment` and `hosted_record` tables normalize
hosted missions. Existing `battle_attempt` and `hosted_job` rows already have typed
operation/agent/epoch and lifecycle fields and are reused. Hosted jobs additionally already
have conversation generation and indexed state, including the four-slot running-job query.
No redundant running-job table is introduced.

An assignment ID is constructed from its operation and agent, and remains individually
addressable. Attempts/jobs carry those two fields explicitly; authorization never splits
that ID. Assignment goals, candidate scopes and current lifecycle are typed columns.
JSON remains for bounded instructions, historical transitions, provider metrics and
simulation reports. The compatibility adapter constructs tasks/results from those records;
it clears hosted operation `result` and removes tasks/scopes/completion conditions and
mutable workflow fields from its stored config in the same transaction.

Before an individual legacy operation is backfilled, its existing JSON remains authority.
The backfill transaction installs its typed records and empties the old mutable fields;
**that commit is its authority cutover**. Afterwards all accesses use the adapter. There
are no ongoing dual writes of authoritative operation JSON and typed assignment state.
Historical transitions may record old states; only `hosted_assignment` defines the current
assignment lifecycle. Existing Node operations keep their old representation and scheduler.

Event insertion now returns the allocated evidence ID. Discovery, resilience actions,
per-target battle outcomes and paired verification propagate it directly. Each attempt's
resolution receipt points directly to its inserted resolution event. Model explanation and
cited input evidence remain separate from the resulting measured receipt.

## Concrete rollout and backfill

**Status:** data-preserving upgrade/backfill rehearsed on a populated disposable 2.13.0
database. The earlier typed-storage cutover is present in production (12 workflow records
confirmed by owner read on 2026-10-25); the audit release remains unpublished. For a legacy
installation this is a coordinated maintenance cutover,
not a validated rolling upgrade with active inference. Do not use destructive schema reset
or publish a `mission-fixtures`/scheduling comparison WASM.

1. Preserve the currently deployed WASM and an owner-only export/snapshot of private records,
   including chat operations/turns/messages, jobs/budgets/alarms, assignments/history if
   present, attempts/receipts/evidence, session/grants and current simulation state. Keep
   credentials and exports out of git. Rehearse with the actual deployed artifact and a
   disposable copy before touching shared production. The local test uses a WASM captured
   from the pre-change working tree, not a production backup.
2. Arrange a maintenance window and stop new user intent. Drain queued/running turns,
   planning/running operations, queued/waiting/attempt/running jobs and unresolved simulation
   attempts. Check owner queries by their state/stage indexes; wait through the original
   deadlines and provider timeout grace. Do not free running reservations or delete retry
   keys. A frontend banner alone cannot prevent direct credentialed reducer calls: keep
   the shared demo closed during the cutover, and recheck admission immediately before
   and after publishing. Live migration under concurrent submissions is not validated.
3. Build the normal release WASM, regenerate both binding directories and review the
   SpacetimeDB migration plan. New tables/indexes are additive; appended defaulted columns
   require the explicit client-disconnect acknowledgment. Publish with
   `--delete-data=never`. If the plan reports an unsupported change, stop and preserve the
   database. No table removal, column reordering or type replacement is required here.
4. Before reopening traffic, enumerate private IDs with owner SQL. Call
   `migrate_hosted_workflow(operations, turns, messages)` with **at most 100 combined IDs**
   per call. Example CLI arguments are `'["operation-uuid"]'`, `'["turn-uuid"]'`, `'[1,2]'`.
   Include all historical epochs and generations, not just currently visible rows.
   Hosted operations normalize into typed records; Node operations only receive explicit
   generation metadata. Turns/messages receive explicit scope; parsing old message keys
   occurs only at this migration boundary. Repeat batches safely after interruption.
5. Compare identity/state/record counts, assignment target alternatives, ordered history,
   receipt/evidence references, grants and session epoch with the export. No active work,
   outstanding reservation, simulation row or deduplication key should be removed. Backfill
   errors roll back their transaction. Inspect malformed or over-512-row legacy missions
   rather than truncating them. Require no zero scope fields before reopening.
6. Serve the rebuilt existing frontend and reconnect both roles. Verify same conversation
   reconstruction, denied private-table access, opposing-role isolation and absence of active old-epoch work or old-generation chats in views. Reset swarm
   intentionally preserves terminal history within the same conversation across fleet epochs. Resume normal admission only after these checks.

The backfill reducer is owner-only and bounded. Operator enumeration is a one-time migration
scan; ordinary subscriptions and inference admission use indexes. There is no background
lazy mutation from views. After cutover, rollback to the old WASM cannot read emptied JSON
as authority: use a forward fix or restore the pre-cutover snapshot in the maintenance
window. Never republish old code over normalized records assuming automatic rollback.

## Retention

The existing 200-turn-per-role lifetime admission cap applies across new chat and reset;
records needed by retries are retained. Stop/cancel/pause still work at capacity without
adding another turn. Together with four specialists, eight decisions,
two replans, 33 provider calls and the new 512-record mission limit, this bounds hosted
history without an unbounded garbage-collection scan. Terminal jobs discard their request
body as they finish; active HTTP keeps it until completion/timeout. Provider response
envelopes are not persisted. Compact validated outputs, metrics, attempts, receipts,
chat and evidence remain for the demo database lifetime. Reset now cancels indexed pending
jobs and closes attempts rather than deleting these explanations.

Time-based archival and cap replenishment are intentionally not implemented. At capacity,
export/archive and review the next database transition. Owner-run fixtures are outside
hosted admission limits; do not run them indefinitely and claim this production bound.
No cleanup deletes active work, reservations or deduplication tombstones.

## Scheduling sample

A local comparison on 2026-10-25 used 200 drones, one defender-scoped WebSocket subscriber,
one second of warmup and one five-second sample per arm. Both arms ran the same movement
reducer logic on a disposable Linux standalone 2.13.0 database. The comparison module was
built in `/tmp`; its extra reducer/table are absent from the production module.

| Sample | Movement updates received | Approximate movement transactions | Database process CPU seconds | CPU ms / 1,000 movement updates |
| --- | ---: | ---: | ---: | ---: |
| Independent 180–300 ms drone schedules | 4,313 | 4,313 | 2.32 | 537.9 |
| Experimental shared 240 ms schedule | 4,200 | 21 | 0.09 | 21.4 |

CPU is Linux process user+system CPU from `/proc`, not SpacetimeDB energy billing or wall
latency. Callback counts agree with movement ticks. The shared arm batches writes and
subscription recomputation into fewer transactions, but changes the individual cadence.
This short sequential sample has no inference, contention campaign, GPU rendering,
frame-time measurement or statistical repetitions. It suggests batching is worth a later
representative profile; it does **not** prove lower viewport lag or equivalent smoothness.
Production scheduling and frontend interpolation remain unchanged.

Reproduce the small experiment after building release WASM:

```sh
./node_modules/.bin/esbuild scripts/measure-fleet-scheduling.ts --bundle --format=esm --platform=node --packages=external --outfile=output/architecture/measure.mjs
SPACETIME_BINARY=/path/to/spacetimedb-standalone node output/architecture/measure.mjs
```

The script restores the production WASM after building its disposable comparison. Raw
samples go to ignored `output/architecture/scheduling.json`.

## Focused validation

`npm test` passed 45 tests, with 12 database-dependent tests skipped without configured
standalone. Native Rust tests passed 11/11; TypeScript checking and release WASM build
passed. Separate configured-database checks covered the real mission reservation/commit
loop, role visibility, immutable scopes, idempotence, direct verification linkage,
provider refusal/error reporting, budgets/concurrency, cancellation/reset fencing,
restart/reconnect, resilience and the existing browser mission flow. The reset changes
also passed the legacy Node reset/continuity checks after its verifier was scoped to the
current epoch. Generated public chat view schemas retain their original shapes.

The populated migration test publishes the captured old module, seeds a completed mission
with receipts/evidence/chat, upgrades the same database without clearing it, runs backfill
twice, checks preserved records and grants, rejects role access to private storage, restarts,
and verifies that a new conversation hides rather than deletes the completed mission.

```sh
MIGRATION_FROM_WASM=/path/to/pre-change.wasm SPACETIME_BINARY=/path/to/spacetimedb-standalone node --test sandbox/test/workflow-migration.test.ts
```

Browser evidence uses the existing headless Canvas fallback and desktop/mobile layouts;
it is not a GPU appearance/performance certification. No full production snapshot, live
rolling migration, paid-provider regression or long-duration benchmark was run.

The final audit ran **77 Node tests with zero skips/failures and 14 native Rust tests**.
TypeScript, release WASM and the Vercel static build passed. See
[AUDIT_2026-10-25.md](AUDIT_2026-10-25.md) for credentialed provider evidence and deployment limits.
