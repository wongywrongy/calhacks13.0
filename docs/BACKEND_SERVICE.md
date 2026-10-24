# Backend service and Bitdeer preparation

The backend branch adds a long-running authenticated API without modifying the fleet UI or its Rust module. It runs actual concurrent HTTP sandbox matches, stores redacted evidence, and forwards fleet lifecycle operations to SpacetimeDB. It does not yet translate model decisions into drone reducer actions.

## Start

Node 24 is required (the service uses built-in SQLite). From the repository root:

```sh
npm ci
# Set distinct, random secrets using your shell or deployment secret manager.
export SUDOKO_OPERATOR_TOKEN="$(openssl rand -hex 32)"
export SUDOKO_OBSERVER_TOKEN="$(openssl rand -hex 32)"
npm run backend
```

The default listener is `127.0.0.1:4180`. SQLite writes to `output/service/runs.sqlite`; preserve this directory across restarts. Set `SUDOKO_DATABASE` for another persistent path, `PORT` for the listener, and `SUDOKO_BIND` only when deploying behind an authenticated TLS ingress. Do not put tokens in URLs or browser bundles.

Use one service process per SQLite file. Do not run multiple scheduler replicas against this database: admission leases and cancellations are process-local. Interrupted jobs are marked `interrupted` on restart, never silently resumed with replacement actors or fabricated success. Completed evidence remains readable. This is a single-host service, not a distributed worker platform.

## Storage and authority

| Data | Authority |
| --- | --- |
| Fleet drone positions, policies, agents, and role projections | Existing SpacetimeDB module |
| Run admission, lifecycle, idempotency, and redacted replay evidence | Service SQLite tables `jobs` and `events` |
| HTTP outcomes, actor credentials, flags, and policy checks during a run | Per-run owned HTTP practice service and referee |
| Model credentials | Service environment only |

Each HTTP run receives its own loopback practice server, credentials and random artifacts. Concurrent runs do not share a mutable match. SQLite snapshots and event inserts commit together; event IDs are unique within a run. Raw model text, private actor credentials, and synthetic flags are not persisted in public evidence. Per-run inference metrics and safe error categories are retained.

This service's observer token is an evaluator credential: it can read all HTTP runs. It is NOT an attacker/defender agent credential. Fleet viewers continue to subscribe with their individually granted SpacetimeDB identities. Do not hand an evaluator token to a restricted agent view.

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
npm test
npm run test:backend-load
npm run spacetime:build
SPACETIME_BINARY=/path/to/spacetimedb-standalone npm run test:backend-fleet
```

Service tests exercise two simultaneous real HTTP matches (48 security agents total), redacted persistence across reopen, cursor replay, authentication, idempotency, bounded queue admission, cancellation, restart interruption, shared model admission, and provider refusal without fixture substitution.

Remaining integration: credentialed Bitdeer smoke run, model-driven fleet action reducers and evidence linkage, frontend server-side authentication/route wiring, remote deployment, load/latency profiling, database retention policy, and multi-process job leasing if horizontal scale becomes necessary. No UI files were changed by this backend milestone.

### Measured checks on 2026-10-24

- TypeScript check and 24 tests passed.
- Four concurrent 8-second fixture runs: 96 security agents, 96 normal clients, 8 referees; 7,009 measured HTTP requests, no agent errors. This is a bounded local smoke test, not a production throughput guarantee.
- A separate 4-second baseline/hardened comparison with 38 actors per run recorded 205/223 attack requests and zero agent errors. Baseline had 7 captures and 5 verified reclaims; hardened had 1 capture and 1 reclaim. Legitimate success was 98.61–98.74% baseline and 95.27–96% hardened. These results are observations, not a claim that hardened mode is perfectly secure or always faster.
- WASM build and the real SpacetimeDB API integration passed with 128 drones / 32 agents: operator-only start, viewer grants, observer write denial, and stop freezing database state.
- Real Bitdeer inference and deployed-container isolation remain unverified.
