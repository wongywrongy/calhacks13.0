# Fleet chat integration validation (historical UI baseline)

For the latest Claude UI integration and its incomplete credentialed acceptance result, see [FLEET_UI_VALIDATION.md](FLEET_UI_VALIDATION.md). The results and budgets below describe the earlier baseline only.

Verified locally on 2026-10-24. This integrates PR #7 (`feat/backend-service`, `f0d7186`) with the newer fleet role UI (`feat/fleet-role-views`, `dd7f9ca`), both descended from `main` (`e5eabe4`). The original dirty checkout was left intact. The earlier `agents/common` integration in that checkout was not copied over the newer backend runtime.

## Credentialed browser smoke

Evidence: [fleet-chat-bitdeer.json](evidence/fleet-chat-bitdeer.json). This is actual authenticated Bitdeer inference, not a mocked provider or a fixture policy. Both objectives were entered through the existing browser chat boxes, using separate granted SpacetimeDB identities and session cookies. No API key or role/owner token appears in the artifact.

- Run began `2026-10-24T21:07:22.910Z` on a fresh owned local simulation: four drones, two attackers and two defenders; fleet epoch **1** throughout.
- Coordinator model: **`zai-org/GLM-5.3-Flash`**. Specialist model: **`zai-org/GLM-5.3-Flash`**. Both used strict JSON Schema responses, validated again by Node and scope-checked by reducers.
- Attacker operation: `a1bcec87-edc8-4d88-abd0-c7227e4da41c`. Agents 1 and 2 chose discovery (evidence **1, 2**) and unauthorized commands that were actually accepted (evidence **3, 4**). Both drone controllers changed to attacker.
- Defender operation: `bb0df9fa-7611-4e04-9bf4-8f177b66aac7`. Agents 3 and 4 chose scoped isolation (evidence **5, 6**) followed by verification. Drone 2's unauthorized/legitimate probes were **7 (403), 8 (200)** and recovery **9**. Drone 1's probes were **10 (403), 11 (200)** and recovery **12**. Final controllers were defender, policies isolated, version 1. Movement holds were cleared only by verified recovery.
- Both operations persisted `planning → running → completed`. Each used one coordinator and four specialist calls: **10 calls total**, peak inference concurrency **2**, configured global cap **4**.
- Provider-reported usage: **2,252 prompt + 6,717 completion = 8,969 total tokens**. Completion counts include provider reasoning tokens; private reasoning was neither stored nor rendered. Per-call measured latency ranged from **2,411 to 5,599 ms**, including admission/persistence overhead.
- Browser reload retrieved the same operation and receipts without redeployment. Cross-role reads returned 404. The UI displayed committed evidence references and completed state. Screenshots are saved at `output/fleet-chat-smoke/attacker.png` and `defender.png`.

The smoke used a temporary local SpacetimeDB database that was removed after verification. The checked-in artifact is an evaluator capture of committed rows, not a currently running deployment or an external network penetration test.

## Failures found, retained and corrected

Actual compatibility checks were necessary; model discovery was not treated as proof of inference. An initial 160-token JSON-object check exhausted its token cap; a subsequent small request returned a valid `discover` decision. The original coordinator cap of 600 tokens also truncated a response. JSON-object mode subsequently produced an empty task list, which was rejected without actions. An explicit JSON Schema produced a valid plan while retaining the exact user objective and simulation context. A specialist later exhausted a 768-token cap after another specialist had already committed a takeover; the operation was truthfully failed, not silently substituted with fixtures.

The final output caps are **2,048 tokens per coordinator/specialist request**. No provider retry or automatic model escalation is enabled. A further smoke completed attacker actions but exposed a fractional-millisecond fleet-deadline conversion at defender admission. That conversion is now floored, and a real-database regression covers operation deadlines clamped to the fleet deadline. Intermediate sanitized attempt captures remain in `output/fleet-chat-smoke/attempt-*.json`; they are not represented as passing runs.

The passing run's 10 calls/8,969 tokens exclude the earlier compatibility/debugging requests. Across the four prior browser attempts, 12 calls reported 9,530 total tokens; four focused compatibility requests reported 1,861 tokens. Total credentialed work in this session was **26 calls / 20,360 reported tokens**, including the passing run. No load test used paid inference.

## Deterministic mechanism checks (mocked inference)

`SPACETIME_BINARY=... npm test`: **28 passed, 0 failed, 0 skipped**, using real temporary SpacetimeDB instances. Fleet-chat tests explicitly mock only the provider contract; they do not claim model intelligence.

| Requirement | Check |
| --- | --- |
| Multiple attacker agents and measured effects | Authenticated start, two validated assignments, discoveries and committed controller changes |
| Defense in the same fleet | No epoch reset; isolated policy writes, separate 403/200 probe evidence, verified recovery |
| Concurrent role isolation | Simultaneous opposing operations; role-scoped prompts, 404 cross-role reads, private table denial |
| Idempotency | Concurrent same-key submissions share one durable operation/coordinator call; conflicting messages fail; duplicate reducer action does not mutate twice |
| Invalid/out-of-scope/stale/unauthorized rejection | Role/target validation, publisher authorization, policy versions, epochs, deadlines, sequence bounds, conflicting action reuse and malformed provider output |
| Stop | Planning cancellation and specialist cancellation with queued inference; receipt count remains unchanged after stop returns |
| Durable reconnect | Actual SpacetimeDB process restart and backend reopen; same cookie/operation ID retrieves saved transitions and evidence |
| Provider failures | Refusal, malformed/invalid action, truncation, rate limit and timeout remain visible; no fixture actions occur |
| Browser authentication | Granted identity determines role and sandbox, role spoofing rejected, cross-origin denied, observer cannot deploy, only viewer token reaches browser |

`npm run test:fleet-chat` also passed in headless Chromium with explicitly mocked inference. It submitted both original objectives through the existing chat input, verified evidence-linked changes, checked reconnect, and ensured model text containing an HTML event handler rendered as plain text. TypeScript checking, the WASM build and the fleet browser bundle passed. The existing fixture fleet regression also passed: role views, private-table/role-escalation denial, independent movement, takeover, recovery, stop and fresh epochs, including 128 drones and 32 agents.

## Scope and limits

The final budgets are one coordinator, 2–4 specialists, at most eight decisions each and 33 total calls per operation; 2,048 output tokens per request; 15-second request timeout; 45-second operation deadline including planning; and the existing 60-second fleet deadline. Both roles and HTTP experiments share the configured inference pool (default four). Workers stop early after a measured command result, verified recovery or chosen wait.

This delivers operation start/read/stop, not full conversational replanning. The HTTP practice suite is not connected to fleet reducer actions. General account provisioning, production deployment, internet-facing/container isolation, retention policy and broad load testing are not covered. Provider behavior is nondeterministic; one passing smoke does not promise future success or perfect security.
