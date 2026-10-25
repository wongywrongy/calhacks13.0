# Existing fleet chat: Bitdeer integration

The implemented Claude chat/log UI (`feat/chat-log-rework` through local commit `07d255a`, including work newer than the pushed document) uses the same Node backend from PR #7. The fleet layout, styles, role views and animation implementation are preserved. This is the SpacetimeDB reducer simulation; the HTTP practice suite remains a separate execution path.

## Start and authenticate

Use Node 24. Install with `npm ci`, build the module with `npm run spacetime:build`, and publish the updated `arena-live` module to the intended database using its publisher identity. Both binding directories are generated from that module. Run `npm run build:fleet`, configure the server-side `.env` (see `.env.example`), then `npm run backend`. This serves the existing fleet UI and API at `http://127.0.0.1:4180`.

The configured `SPACETIME_URI`/`SPACETIME_DATABASE` selects one owned sandbox. Backend startup initializes a missing fleet with 48 normally moving drones and **zero security agents**. Either role may submit the first objective. The coordinator plans 2–4 new specialists; only a validated plan atomically creates their agent entities and assignments. Existing unused fixture seeds are retired when chat is enabled; workers referenced by plans or evidence are preserved.

Model-driven fleets have no global countdown and make no idle model calls. Startup converts an active timed fixture to this persistent session while preserving its epoch and formation clock. Explicitly ended sessions remain ended across a backend restart. Later objectives reuse or reactivate the same fleet without resetting drones, controls, policies or evidence. Attacker and defender operations are independent. Chat `Stop` cancels only the caller's operation. The privileged operator `POST /v1/fleet/stop` ends movement; explicit `/v1/fleet/start` resets the fleet. Use `{drones:48,attackers:0,defenders:0,hardened:false}` for a fresh chat fleet. Positive counts remain available for explicitly labelled timed fixture tests.

Activation disables scheduled security fixtures atomically. A private SpacetimeDB clock preserves the formation's time origin separately from its optional fixture deadline. Reducers still enforce the individual operation deadline, role, assignment and epoch.

For hackathon demonstrations, set `SUDOKO_DEMO_MODE=1` and supply already-granted attacker/defender viewer credentials in `SUDOKO_DEMO_ATTACKER_VIEWER_TOKEN` and `SUDOKO_DEMO_DEFENDER_VIEWER_TOKEN` on the server. The existing role buttons then switch directly, with no login or token entry. Each request selects a permitted demo role with `X-SudoKO-Role`, and the server verifies the configured viewer's grant; each view keeps separate conversation and subscriptions. The selected role survives a page reload. Switching does not stop, reset or redeploy operations. Anyone who can access this demo URL is intentionally allowed both roles. Provider and backend credentials stay server-side. This flag is off by default; the session-based behavior below remains unchanged when it is off.

In demo mode, the header's **Sandbox** button explicitly resets the shared fleet after confirmation. `POST /api/chat/reset` accepts only `{epoch}` from a same-origin, granted demo role. It cancels and joins both sides' pending work, then uses the existing owner-only fleet reducer to restore the same drone count/hardening with zero agents. Stale epochs cannot reset a newer fleet. Conversation, operation and evidence history remain durable; the new epoch begins awaiting an objective. Ordinary authenticated sessions cannot use this route.

The operator grants each existing SpacetimeDB viewer identity its role with `POST /v1/fleet/grants`. Users sign in at `/signin` with their **granted viewer token**, or an existing trusted login handoff can POST `{token}` to `/api/session`. The server verifies the credential against the database's identity-scoped `visible_fleet_access` view. Role and sandbox are derived from that authenticated grant, not a browser role selector. Owner credentials cannot sign in as viewers.

The browser receives an authenticated, encrypted, HttpOnly, SameSite=Strict session cookie, valid for 12 hours. Use separate browser profiles for attacker and defender accounts. Every API request rechecks the grant; changing a grant requires signing in again. Session encryption uses `SUDOKO_SESSION_SECRET` when supplied, otherwise a key derived from the server operator secret. It survives backend restart with the same secret. No session database or second backend is added.

For remote deployments, set `SUDOKO_PUBLIC_ORIGIN` to the exact HTTPS origin and put this server behind that ingress; cookies are then Secure. Set `FLEET_PUBLIC_URI` to the browser-reachable SpacetimeDB address if needed. Mutations require matching Origin and reject cross-site requests. Never put operator, role, or provider credentials in URLs or frontend bundles. `/fleet-config` returns only the caller's granted viewer credential for existing role-scoped WebSocket subscriptions.

## Browser adapter and existing backend contract

| Method and route | Input / behavior |
| --- | --- |
| POST `/api/session` | `{token}`: authenticate an already-granted viewer and set a session cookie |
| GET `/fleet-config` | Authenticated sandbox, role and viewer subscription configuration; client role query cannot escalate |
| POST `/api/chat/operations` | `{message,sandbox,target?}` and `Idempotency-Key`; role comes from session |
| POST `/api/chat/messages` | Same input; persist the operator message and bounded coordinator replies; start, Status or Stop |
| GET `/api/chat/conversation?after=0` | Role-private persisted messages, cursor, `more`, and latest 50 operations |
| GET `/api/chat/operations/:id` | Durable operation, assignments, receipts, inference metrics and transitions |
| POST `/api/chat/operations/:id/stop` | Cancel planning/queued inference/workers and wait before returning |

The original bearer-token `POST /v1/chat/operations`, `GET /v1/chat/operations/:id` and `POST /v1/chat/operations/:id/stop` remain available to trusted server clients. Their tokens remain server-side. Evaluator/operator tokens cannot invoke role chat. Both adapters call the same operation implementation.

Start now returns 202 as soon as a **durable planning** operation exists; assignments arrive through subsequent reads. Planning failures remain retrievable, including after restart. Same-key/same-message/same-target submissions return the original operation even when submitted concurrently. Conflicting message or target reuse returns 409. One operation per role may be active; opposing roles may run concurrently against the same fleet epoch. Other-role reads return 404.

The existing chat input posts to `/api/chat/messages`. Ordinary messages immediately create a durable private `backend_chat_turn`, operator message and acceptance reply, returning **202 with `accepted.id`**, `turns`, messages and operations. The request does not await inference. The same endpoint handles general questions, grounded state/explanation questions, deployments and contextual follow-ups. The trusted `/v1/chat/messages` equivalent remains available; explicit `/api/chat/operations` and `/v1/chat/operations` retain their deployment-only contract.

One structured coordinator response chooses `answer`, `clarify`, `deploy`, or `replace`. Answer/clarify must contain no tasks. Deploy/replace must contain a complete 2–4-specialist plan, independently validated in Node and the reducer. Names, counts, catalog targets, selected-target scope and action enums remain bounded. A deploy response is reused directly for execution: there is no second coordinator call. The coordinator receives at most 12 recent messages (700 characters each), two own-role operation summaries with eight recent receipts each, and 16 visible evidence records. It receives role-scoped drone observations; attackers do not receive undiscovered drone telemetry, isolation policy, defender plans or conversations. Empty discovered observations still permit catalog discovery from the target-ID range; they are not an empty action catalog.

`Status` and its existing exact aliases read actual operation results without inference. Other questions use the coordinator with observations and evidence, even with no operation active. Explanations can cite only visible evidence or receipts from the caller's own operations. An unambiguous idle follow-up creates a fresh validated operation using conversation context. A structured `replace` decision for a clear active follow-up cancels and joins the caller's existing operation before creating the revised operation. An unresolved target or objective gets a concise clarification. A `deploy` decision while work is already active is explicitly rejected as not applied. No reply claims a modification succeeded before backend admission.

`Stop`/`Cancel`/`Pause` are handled directly, bypassing inference and inference queues. They cancel pending conversational inference, then cancel/join that side's operation; Stop does not depend on a stale selected target. Pause uses cancellation, preserving evidence. `Continue` requests a new bounded plan from recent conversation/assignments; it is not an exact resumption of old model work. Opposing operations are unaffected. Conversation turns are idempotent by role/key; at most one pending turn per role is admitted, alongside the existing one-active-operation-per-role limit. Refresh recovers pending/terminal turns and messages. A backend restart marks abandoned turns visibly interrupted instead of leaving a spinner or automatically deploying.

The UI polls existing role-private APIs every 250ms while a turn or operation is active and every 750ms while idle. Persisted queued/running/error states show progress before the full answer is available. There is no partial-argument execution or private reasoning display; the existing adapter uses complete JSON responses rather than a new streaming transport. Requests and inference both have bounded timeouts.

The activity log contains committed deployment events, queued/failed attempts, executed receipts and visible threat evidence. Operator messages and coordinator replies appear only in chat. Evidence and action/operation causation IDs remain attached to rows; receipts sharing a visible evidence event are merged to avoid duplicate actions. Planned assignments never become success rows. Agent cards/modal states come from persisted worker lifecycle (`working`, `failed`, `done`, `paused`), independent of whether an agent entity exists. Modal activity is scoped to that worker; statistics count measured events. Swarm rendering remains driven by the existing role-scoped subscriptions. Model text is rendered with text nodes. No styles or layout were redesigned.

## Models and budgets

| Setting | Default |
| --- | --- |
| `BITDEER_COORDINATOR_MODEL` | `zai-org/GLM-5.3-Flash` |
| `BITDEER_SPECIALIST_MODEL` | `zai-org/GLM-5.3-Flash` |
| Optional coordinator upgrade | Explicitly set `zai-org/GLM-5.3`; no automatic upgrade |
| `BITDEER_CONCURRENCY` | 4 across fleet chat and HTTP runs; existing range 1–32 |
| Coordinator decisions | 1 per operation |
| Specialists | 2–4 newly created agents of the authenticated role |
| Specialist decisions | At most 8 each; stop after a measured command result, verified recovery or chosen wait |
| Total calls | At most 33 per operation, including coordination; no provider retries |
| Operation deadline | 75 seconds including planning; expiration ends the operation, not the shared sandbox |
| Provider request deadline | 20 seconds for coordination, 20 seconds for specialists; queued calls remain bounded by the operation deadline |
| Output cap | 1,536 coordinator tokens; 512 per specialist call, including provider reasoning tokens |
| Conversation budget | 30 seconds including context/queue; 20-second provider timeout; one coordinator call |
| GLM reasoning | `BITDEER_REASONING_EFFORT=low` by default for GLM-5; independently configured models remain unchanged |

For compatibility, `BITDEER_MODEL` is the model fallback when an independent setting is absent; otherwise explicit Flash defaults apply. There are no embedding, reranking or image calls. The initial larger caps compensated for lengthy provider-default reasoning; after small measured requests and a credentialed browser run, the same Flash model now uses low reasoning and shorter output budgets. Unsupported provider schema regex constraints remain omitted; local validation still enforces names and actions. No automatic provider retries, model switches or fixture security actions are used.

Coordinator output uses `{tasks:[{name,specialty,target,objective}]}` for direct operation routes; conversational output adds `intent`, `answer` and `evidenceIds`. The backend generates immutable random IDs and resolves duplicate names within an operation. The reducer commits profiles and assignments atomically. Names are 1–28 ASCII letters/digits/spaces/hyphens before duplicate suffixes (32 persisted maximum), specialties are 1–48 characters, and both Node and reducers validate them. Display names grant no authority. Private profiles and role-scoped profile views preserve names after refresh. The chat header separately shows the configured provider/model.

Operation and conversation inference records contain configured model, stage, agent, status, context construction, queue wait, inference time, prompt size, reasoning setting, finish reason and available prompt/completion/total token counts. Refusal, malformed output, truncation, provider timeout, operation timeout, rate limiting, other HTTP errors, transport errors and reducer rejection have distinct safe categories. Failures never invoke security fixtures.

## Authority and evidence

SpacetimeDB is the only durable runtime database. Private operation rows store objectives, independently scoped assignments and results. Private transition rows record planning/running/terminal changes; private conversation rows store role-bound operator and coordinator messages. Operation results persist worker lifecycle and attempts alongside action receipts. Reducers enforce publisher identity, scheduler lease, role, assignment, epoch, deadline, policy version, action sequence and deduplication before changing state. A new scheduler marks abandoned planning/running operations interrupted. Starting a new fleet retains prior evidence rows; live subscription views filter the current epoch so historical evidence does not contaminate the new fleet.

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

Install Playwright Chromium, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an existing installation. Checks use temporary local databases, preserve the same fleet epoch between opposing operations, save sanitized evidence and screenshots in `output/fleet-ui-{mocked,smoke}/`, and tear down their test database. The smoke is not a production deployment and does not perform a load test. See `FLEET_UI_VALIDATION.md` for current recorded results and the remaining credentialed acceptance gap; `FLEET_CHAT_VALIDATION.md` is the historical baseline.

Remaining scope: no exact model-worker checkpoint/resume, no HTTP-to-fleet execution linkage, no production deployment or internet-exposed isolation validation. The authenticated session adapter uses granted sandbox identities, not a general user-account service.

## Connection and session states

The shell assigns header, optional error and workspace to explicit grid tracks; removing the footer does not change workspace placement. The map receives remaining height, the activity log is capped at 240px, and rail/chat content scrolls internally. Laptop columns persist down to 901px; smaller screens stack. ResizeObserver updates renderer size and camera aspect.

The connection badge distinguishes awaiting objective, running agents, completed/failed/stopped operations and ended fleet sessions. A successful role-private conversation poll checks backend/database reachability even when an attacker has no discovered drones. Missing updates still show Stale; WebSocket loss shows Disconnected. Reload restores durable profiles, operations and chat. There is no timer-driven reset or fixture fallback.
