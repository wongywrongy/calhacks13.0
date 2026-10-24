# Backend service and Bitdeer preparation

The backend branch adds a long-running authenticated API without modifying the fleet UI or its Rust module. It runs actual concurrent HTTP sandbox matches, stores redacted evidence in SpacetimeDB, and forwards fleet lifecycle operations to the same database. Chat-driven fleet operations now translate model decisions into drone reducer actions; see [FLEET_CHAT_API.md](FLEET_CHAT_API.md). The HTTP suite remains a separate execution path.

## Start

Node 24 and the updated SpacetimeDB module are required. From the repository root:

```sh
npm ci
npm run spacetime:build
# Publish arena-live to your selected SpacetimeDB database, then configure its owner identity.
export SPACETIME_URI="http://127.0.0.1:3000"
export SPACETIME_DATABASE="your-database"
# Set SPACETIME_TOKEN securely to that database publisher identity token.
# Set distinct, random secrets using your shell or deployment secret manager.
export SUDOKO_OPERATOR_TOKEN="$(openssl rand -hex 32)"
export SUDOKO_OBSERVER_TOKEN="$(openssl rand -hex 32)"
npm run backend
```

The default listener is `127.0.0.1:4180`. All durable state lives in SpacetimeDB; there is no local application database or storage fallback. Set `PORT` for the listener and `SUDOKO_BIND` only when deploying behind an authenticated TLS ingress. Do not put tokens in URLs or browser bundles.

One active scheduler owns a database-issued 20-second lease, renewed every 5 seconds. A second live service instance is rejected by a reducer. Database/heartbeat failure aborts local workers and stops admission. After lease expiry, a new scheduler marks abandoned queued/running jobs interrupted instead of pretending it can resume their private actor credentials. The lease fences all run mutations; old session IDs cannot write after ownership changes. Clean shutdown releases the lease. This is a leased single scheduler, not a horizontally distributed worker pool.

## Storage and authority

| Data | Authority |
| --- | --- |
| Fleet drone positions, policies, agents, and role projections | Existing SpacetimeDB module |
| Run admission, lifecycle, idempotency, and redacted replay evidence | SpacetimeDB private `backend_run` and indexed `backend_event` tables |
| HTTP outcomes, actor credentials, flags, and policy checks during a run | Per-run owned HTTP practice service and referee |
| Model credentials | Service environment only |

Each HTTP run receives its own loopback practice server, credentials and random artifacts. Concurrent runs do not share a mutable match. SpacetimeDB reducers commit snapshots and indexed event inserts in one transaction; event IDs are unique within a run. Raw model text, private actor credentials, and synthetic flags are not persisted in public evidence. Per-run inference metrics and safe error categories are retained.

This service's observer token is an evaluator credential: it can read all HTTP runs. It is NOT an attacker/defender agent credential. Fleet viewers continue to subscribe with their individually granted SpacetimeDB identities. Do not hand an evaluator token to a restricted agent view.

Evaluator subscriptions use `visible_backend_runs` and `visible_backend_events`. These views return no rows for ungranted identities; they are distinct from attacker/defender fleet views. Owner-only `grant_backend_viewer` authorizes full-run evaluation access. Generated client bindings live in `sandbox/module_bindings`; no UI binding files were changed.

SpacetimeDB additionally owns idempotency uniqueness, queue/active-run caps, lifecycle transition validation, snapshot sequence ordering, and event immutability. `backend_lease` stores scheduler ownership and admission limits. The Node process handles HTTP targets and external inference because database reducers cannot perform those external I/O operations.

## API contract

All routes except health require `Authorization: Bearer <token>`. Observer access is GET-only; mutations require the operator token. Browser Origin requests are rejected until a deliberate same-origin/auth integration is implemented. Use a server-side UI adapter; do not embed the operator token in the frontend.

| Method and route | Behavior |
| --- | --- |
| GET `/healthz` | Process health; no secrets/configuration |
| GET `/v1/capabilities` | Configuration readiness, provider model, queue/concurrency limits; configuration does not imply verified inference |
| POST `/v1/providers/bitdeer/preflight` | Authenticate against Bitdeer `/v1/models` and check configured model; does not generate a completion |
| POST `/v1/runs` | Validate and enqueue a run; 202 with run ID and links |
| GET `/v1/runs?limit=20&before=<timestamp>` | Recent run metadata; optional strict creation-time filter |
| GET `/v1/runs/:id` | Lifecycle, configuration, latest redacted snapshot, and safe failure summary |
| GET `/v1/runs/:id/events?after=0&limit=100` | Ordered evidence, `nextAfter` cursor, and current run state; limit max 200 |
| POST `/v1/runs/:id/stop` | Cancel queued work or abort an active run; repeat is safe |
| POST `/v1/evaluators/grants` | Grant an existing SpacetimeDB identity full HTTP-run evaluator subscriptions; operator-only |
| POST `/v1/fleet/start` | Forward validated fleet sizes and explicit hardened mode to owner-authorized SpacetimeDB reducer |
| POST `/v1/fleet/stop` | Stop the configured fleet |
| POST `/v1/fleet/grants` | Grant an existing SpacetimeDB identity attacker, defender, or observer role; operator-only |

Run creation requires an `Idempotency-Key` (1–100 letters, digits, `_ . : -`). Repeating it with identical normalized settings returns the original run; different settings return 409. Unknown fields, destinations, and invalid settings return 400. Admission saturation returns 429. Missing provider/fleet configuration returns 503. Upstream failures return 502 without exposing response bodies or credentials.

Example fixture request:

```sh
curl http://127.0.0.1:4180/v1/runs \
  -H "Authorization: Bearer $SUDOKO_OPERATOR_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: rehearsal-001' \
  -d '{"engine":"fixture","mode":"baseline","durationMs":12000,"attackers":8,"defenders":4,"clients":6,"loadProfile":"burst","decisions":30}'
```

Counts are PER TEAM, for both red and blue. The request above runs 16 attackers, 8 defenders, 12 normal clients and 2 referees. Agent credentials and the fixed scenario catalog constrain attacks to that run's own HTTP targets. Defenses alter actual service authorization/capacity and are measured against legitimate traffic. This remains separate from the drone command reducer simulation.

Default admission: 2 active runs, 8 queued. `SUDOKO_MAX_ACTIVE` allows 1–4 active runs. Existing per-run limits remain: 8 attackers, 4 defenders, 12 clients per team; 120-second duration; 2,500 practice requests and actor/action budgets. This bounds application concurrency, not CPU/kernel stress or hostile-code isolation. Existing Compose containment remains a separate verification requirement.

## Bitdeer

Official endpoint: https://api-inference.bitdeer.ai/v1/chat/completions
Reference: https://developers.bitdeer.ai/docs/api

Set `BITDEER_API_KEY` and `BITDEER_MODEL` in the service environment. Choose a model actually available to the account; no guessed model is hardcoded. Run the preflight route, then submit a small run with `engine: "bitdeer"`, `maxModelCalls: 6`, `decisions: 2`, `attackers: 1`, `defenders: 1`, and `durationMs: 15000`.

`BITDEER_CONCURRENCY` defaults to 4 and accepts 1–32. All service runs share one FIFO inference pool. A run reserves at most `maxModelCalls` (default 60, max 1000) across all its security agents, in addition to per-agent decisions. Each completion requests at most 256 output tokens and has a 15-second timeout. This is a call/output ceiling, not a dollar-cost estimate or input-token budget. Start small and review actual provider usage before increasing it.

Queue cancellation releases waiting calls. Budget exhaustion ends that agent's decision loop. Provider refusal, malformed output, HTTP errors, and budget exhaustion remain visible as safe error categories; they never cause a fixture fallback. Runs with agent/infrastructure errors are marked failed even if some requests succeeded. Tests mock the provider contract; a real credentialed inference run is still required.

## Fleet routing

Set `SPACETIME_URI`, `SPACETIME_DATABASE`, and `SPACETIME_TOKEN` together. The token must belong to the configured module's publisher/owner. The URI must be HTTPS or loopback HTTP. Requests cannot supply a different database, URL, owner token, or arbitrary reducer.

Start body: `{"drones":128,"attackers":16,"defenders":16,"hardened":true}`.
Grant body: `{"identity":"<64 hexadecimal characters>","role":"defender"}`.

A grant applies to an existing authenticated SpacetimeDB identity; this route does not create accounts or return owner credentials. Fleet mode is currently a single configured fleet with fixture decisions and a 60-second run window. Starting a new fleet resets the prior fleet; it is not a second independent fleet session. Use the existing identity-scoped WebSocket views for telemetry.

## Verification and remaining work

```sh
npm run typecheck
npm run spacetime:build
SPACETIME_BINARY=/path/to/spacetimedb-standalone npm test
SPACETIME_BINARY=/path/to/spacetimedb-standalone npm run test:backend-load
SPACETIME_BINARY=/path/to/spacetimedb-standalone npm run test:backend-fleet
```

Service tests exercise two simultaneous real HTTP matches (48 security agents total), redacted persistence across reopen, cursor replay, authentication, idempotency, bounded queue admission, cancellation, restart interruption, shared model admission, and provider refusal without fixture substitution.

Remaining integration: credentialed Bitdeer smoke run, credentialed fleet chat validation, frontend server-side authentication/route wiring, remote deployment, load/latency profiling, database retention policy, and distributed worker execution if horizontal scale becomes necessary. No UI files were changed by this backend milestone.

### Verification after the SpacetimeDB-only revision

- TypeScript, WASM build and 25 tests passed against a real local SpacetimeDB server, with no skipped tests. Database-dependent tests explicitly skip if SPACETIME_BINARY is absent; do not claim full validation in that case.
- Restart verification stops and restarts the SpacetimeDB process itself, then reopens the service and reads the same completed run and events.
- Tests reject competing schedulers, unauthorized writes, private-table reads, conflicting idempotency keys, and reopening completed runs; ungranted evaluator views are empty.
- Repeated SpacetimeDB-backed load check passed: 4 simultaneous runs, 96 security agents, 96 normal clients and 8 referees produced 6,810 measured requests. Fleet-route integration passed with 128 drones / 32 agents. These validate owned application behavior, not hardware stress or perfect security.
- The SDK subscription test observes a live queued-to-running transition from `visible_backend_runs` over WebSocket.
- Real Bitdeer inference and deployed-container isolation remain unverified.
