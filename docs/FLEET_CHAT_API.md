# Existing chat box: backend integration

The fleet chat backend accepts an objective, obtains a Bitdeer coordinator plan, and deploys concurrent specialist loops against the existing SpacetimeDB fleet. It does not modify the frontend. The current UI `queue(text)` only appends a local queued message; connect that function through a trusted same-origin server route using the contract below.

## Configuration

Publish the updated `arena-live` module and configure the backend's existing SpacetimeDB owner credentials. Set `BITDEER_API_KEY`, `BITDEER_MODEL`, `SUDOKO_ATTACKER_TOKEN`, and `SUDOKO_DEFENDER_TOKEN`. Role tokens must be distinct from each other and the operator/evaluator tokens and have at least 32 characters. Keep these credentials on the server. The browser's authenticated session must determine the role at the proxy; never use a user-supplied role alone as authorization. An evaluator token cannot invoke chat.

The operator starts a fleet using `POST /v1/fleet/start`. On the first chat operation, the service disables scheduled fixture security-agent decisions; drone movement schedules continue. Both sides then use model decisions exclusively. Starting a new fleet is rejected while chat is planning or running through this service. Direct owner-level database administration remains trusted.

## Routes

All routes require the appropriate role bearer token. Cross-origin browser requests are rejected; use the trusted same-origin server adapter.

| Method and route | Input | Result |
| --- | --- | --- |
| POST `/v1/chat/operations` | `{ "message": "Look for vulnerabilities in the assigned swarm" }`; unique `Idempotency-Key` header | 202, operation ID, role, original message, model, execution type, validated agent assignments and current results |
| GET `/v1/chat/operations/:id` | None | Durable operation status, assignments, action receipts and evidence IDs; other role gets 404 |
| POST `/v1/chat/operations/:id/stop` | `{}` | Cancels inference and waits for active workers before returning final operation state |

Use the returned ID to poll while the operation runs. Continue existing SpacetimeDB fleet subscriptions for drone changes and evidence. Display the returned task objectives as plans, not completed outcomes. Render model strings as text. A receipt's `status: executed` means a reducer ran; inspect `outcome` and `responseStatus` to distinguish accepted commands, blocked commands, policy application and verified recovery. `evidenceId` links to the existing fleet event; a wait has evidence ID 0.

The same key/message returns the original operation without deploying again. Reusing a key with a different message returns 409. Only one operation per role may run at a time, but attacker and defender operations can run concurrently. A new objective while that side is running returns 409; mid-operation conversational replanning is not implemented. Stop, then submit a new objective with a new key. No automatic success narration is generated.

## Execution and persistence

The coordinator assigns 1–4 distinct existing agents of the authenticated role, each to one drone. Each specialist receives its task and fresh role-scoped observation. Attackers can discover, submit a synthetic unauthorized command, or wait. Defenders can isolate, verify recovery, or wait. Runtime parameters cannot select URLs, arbitrary code, a different identity, or a target outside the assignment.

SpacetimeDB verifies the backend lease, operation role/epoch/state, agent assignment, deadline, action identity and policy version before mutation. Action IDs are deduplicated by operation/agent/step. Command acceptance changes drone control. Isolation changes the actual policy. Verification tests unauthorized denial and authorized acceptance before restoring control. Each effect emits existing fleet evidence; these are reducer-level simulation results, not external HTTP penetration-test evidence.

Private `backend_chat` rows persist the objective, plan, operation state and receipts. Private `fleet_chat_action` rows link deduplicated action IDs to evidence. A new scheduler lease marks abandoned running operations interrupted. An operation stops at eight decisions per specialist, 45 seconds after planning, or the fleet deadline. The coordinator is one additional call: at most 33 model calls per operation. Both roles share the service's inference concurrency pool with HTTP experiments. No Redis, SQLite, extra queue service, or model-to-database credentials are added.

Provider refusal and failure end affected workers visibly, without fixture substitution. Loss of the database lease cancels workers. Credentials and raw provider responses are not stored in operation results. Failed attempts remain distinct from successful actions.

## Verification and remaining integration

`SPACETIME_BINARY=/path/to/spacetimedb-standalone npm test` exercises a real database with a mocked provider contract: two attackers discover and take control; two defenders isolate and verify recovery; cross-role reads are denied; duplicate requests do not redeploy; stop prevents further effects; history survives backend restart; provider refusal causes failure without fixture actions.

A credentialed Bitdeer run remains required to verify actual model quality and JSON-mode compatibility. The frontend's existing queue function and authenticated proxy must be wired to these routes by the UI owner. No frontend or Claude branch files were changed. This first slice supports operation start/read/stop, not persistent multi-turn planning or connecting the fleet to the separate HTTP practice server.
