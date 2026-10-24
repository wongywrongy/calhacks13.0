# Existing fleet chat: Bitdeer integration

The existing `web/fleet.ts` chat now starts, polls and stops operations through the same Node backend from PR #7. The fleet layout, styles, role views and animation implementation are preserved. This is the SpacetimeDB reducer simulation; the HTTP practice suite remains a separate execution path.

## Start and authenticate

Use Node 24. Install with `npm ci`, build the module with `npm run spacetime:build`, and publish the updated `arena-live` module to the intended database using its publisher identity. Both binding directories are generated from that module. Run `npm run build:fleet`, configure the server-side `.env` (see `.env.example`), then `npm run backend`. This serves the existing fleet UI and API at `http://127.0.0.1:4180`.

The configured `SPACETIME_URI`/`SPACETIME_DATABASE` selects one owned sandbox. The operator starts it with the existing `POST /v1/fleet/start` route. Provision at least two attackers and two defenders. With Bitdeer configured, this service immediately disables scheduled security fixtures; drone movement continues. Chat admission also disables fixtures transactionally, before planning. The existing fleet lifespan is 60 seconds; an operator must explicitly start a fresh fleet after it expires. Starting either side's chat never starts or resets a fleet.

The operator grants each existing SpacetimeDB viewer identity its role with `POST /v1/fleet/grants`. Users sign in at `/signin` with their **granted viewer token**, or an existing trusted login handoff can POST `{token}` to `/api/session`. The server verifies the credential against the database's identity-scoped `visible_fleet_access` view. Role and sandbox are derived from that authenticated grant, not a browser role selector. Owner credentials cannot sign in as viewers.

The browser receives an authenticated, encrypted, HttpOnly, SameSite=Strict session cookie, valid for 12 hours. Use separate browser profiles for attacker and defender accounts. Every API request rechecks the grant; changing a grant requires signing in again. Session encryption uses `SUDOKO_SESSION_SECRET` when supplied, otherwise a key derived from the server operator secret. It survives backend restart with the same secret. No session database or second backend is added.

For remote deployments, set `SUDOKO_PUBLIC_ORIGIN` to the exact HTTPS origin and put this server behind that ingress; cookies are then Secure. Set `FLEET_PUBLIC_URI` to the browser-reachable SpacetimeDB address if needed. Mutations require matching Origin and reject cross-site requests. Never put operator, role, or provider credentials in URLs or frontend bundles. `/fleet-config` returns only the caller's granted viewer credential for existing role-scoped WebSocket subscriptions.

## Browser adapter and existing backend contract

| Method and route | Input / behavior |
| --- | --- |
| POST `/api/session` | `{token}`: authenticate an already-granted viewer and set a session cookie |
| GET `/fleet-config` | Authenticated sandbox, role and viewer subscription configuration; client role query cannot escalate |
| POST `/api/chat/operations` | `{message,sandbox}` and `Idempotency-Key`; role comes from session |
| GET `/api/chat/operations/:id` | Durable operation, assignments, receipts, inference metrics and transitions |
| POST `/api/chat/operations/:id/stop` | Cancel planning/queued inference/workers and wait before returning |

The original bearer-token `POST /v1/chat/operations`, `GET /v1/chat/operations/:id` and `POST /v1/chat/operations/:id/stop` remain available to trusted server clients. Their tokens remain server-side. Evaluator/operator tokens cannot invoke role chat. Both adapters call the same operation implementation.

Start now returns 202 as soon as a **durable planning** operation exists; assignments arrive through subsequent reads. Planning failures remain retrievable, including after restart. Same-key/same-message submissions return the original operation even when submitted concurrently. Conflicting messages return 409. One operation per role may be active; opposing roles may run concurrently against the same fleet epoch. Other-role reads return 404.

The UI saves the current operation ID and submission key per sandbox/role, polls every 750 ms while active, and retrieves the operation after reload. It renders objectives, validated assignments, active inference workers, executed/blocked receipts, evidence IDs, cancellation and provider failures using text nodes. It does not narrate a plan as execution or a completed operation as a successful takeover. The existing action chips submit objectives through the same path. Stop is available during planning and execution. New objectives require stopping the active operation; conversational replanning is not implemented.

## Models and budgets

| Setting | Default |
| --- | --- |
| `BITDEER_COORDINATOR_MODEL` | `zai-org/GLM-5.3-Flash` |
| `BITDEER_SPECIALIST_MODEL` | `zai-org/GLM-5.3-Flash` |
| Optional coordinator upgrade | Explicitly set `zai-org/GLM-5.3`; no automatic upgrade |
| `BITDEER_CONCURRENCY` | 4 across fleet chat and HTTP runs; existing range 1–32 |
| Coordinator decisions | 1 per operation |
| Specialists | 2–4 distinct existing agents of the authenticated role |
| Specialist decisions | At most 8 each; stop after a measured command result, verified recovery or chosen wait |
| Total calls | At most 33 per operation, including coordination; no provider retries |
| Operation deadline | 45 seconds including planning, also bounded by the current fleet deadline |
| Provider request deadline | 15 seconds; queued calls remain bounded by the operation deadline |
| Output cap | 2,048 coordinator tokens; 2,048 per specialist call, including provider reasoning tokens |

For compatibility, `BITDEER_MODEL` is the fallback when an independent setting is absent; otherwise the explicit Flash defaults apply. There are no embedding, reranking or image calls. The initial 600-token coordinator cap truncated an actual GLM response, so the bounded cap was increased. A specialist also exhausted a 768-token cap, so both caps are now 2,048. JSON-object mode returned an invalid empty plan; explicit JSON-schema constraints produced a valid plan without changing the user objective. Strict JSON Schema mode is requested, and exact response shapes, agent IDs, targets and action enums are independently validated. Provider output cannot supply URLs, code, credentials or evidence. No private reasoning is stored.

Operation inference records contain configured model, stage, agent, status, latency, finish reason and available prompt/completion/total token counts. Refusal, malformed output, truncation, provider timeout, operation timeout, rate limiting, other HTTP errors, transport errors and reducer rejection have distinct safe categories. Failures never invoke security fixtures.

## Authority and evidence

SpacetimeDB is the only durable runtime database. Private operation rows store objectives, independently scoped assignments and results. Private transition rows record planning/running/terminal changes. Reducers enforce publisher identity, scheduler lease, role, assignment, epoch, deadline, policy version, action sequence and deduplication before changing state. A new scheduler marks abandoned planning/running operations interrupted.

Attacker specialists receive only their assignment, discovered-target observations and their own action memory. Defenders receive their own tasks and drone telemetry; they do not receive attacker plans or conversations. Browser subscriptions retain the existing identity-scoped views.

A command acceptance actually transfers drone control and updates the existing motion hold. A policy write only isolates its assigned drone. Recovery requires committed verification probes: unauthorized denial (403) **and** legitimate acceptance (200) under the same policy version. Separate probe evidence IDs and the recovery evidence ID appear in the receipt. Only verified recovery restores authorized control and clears the motion hold. `status: executed` means the reducer executed; inspect `outcome` and `responseStatus` for success or rejection. Waits carry evidence ID 0.

Cancellation aborts queued and active inference, joins specialist work, then commits terminal state. Terminal operations cannot execute further actions. No local SQLite/Redis state, shell tool, arbitrary network target or model-owned database credential is added.

## Verification

```sh
npm run typecheck
npm run spacetime:build
SPACETIME_BINARY=/path/to/spacetimedb-standalone npm test
# Deterministic browser mechanism check: real database, explicitly mocked inference.
SPACETIME_BINARY=/path/to/spacetimedb-standalone npm run test:fleet-chat
# Small actual Bitdeer run; reads server .env, generates billable completions.
SPACETIME_BINARY=/path/to/spacetimedb-standalone npm run smoke:fleet-chat
```

Install Playwright Chromium, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an existing installation. Checks use temporary local databases, preserve the same fleet epoch between opposing operations, save sanitized evidence and screenshots in `output/fleet-chat-{mocked,smoke}/`, and tear down their test database. The smoke is not a production deployment and does not perform a load test. See `FLEET_CHAT_VALIDATION.md` for recorded results and limits.

Remaining scope: no mid-operation conversational replanning, no HTTP-to-fleet execution linkage, no production deployment or internet-exposed isolation validation. The authenticated session adapter uses granted sandbox identities, not a general user-account service.
