# Latest SudoKO UI integration — validation and remaining gap

Updated 2026-10-24. Implementation is on `feat/bitdeer-chat-integration`, in `/tmp/sudoko-chat-integration`. It reconciles PR #7 / `feat/backend-service` (`f0d7186`) and the previous authenticated integration (`06eaf99`) with Claude's **actual local** `feat/chat-log-rework` implementation (`07d255a`). That UI worktree was clean and three commits ahead of the pushed documentation commit (`6deefb2`). The original dirty main checkout and Claude's worktree were left intact. Layout, CSS, animations and role views were preserved.

**The integration is implemented, but the latest credentialed full takeover/recovery acceptance run did not pass.** Deterministic mechanism and browser checks pass. Real inference compatibility and genuine reducer actions were observed; those are not a claim that the current model consistently completes the requested scenario.

## Implemented surfaces

- Existing CRIMSON/SENTINEL chat uses authenticated same-origin messages and the existing operation runtime. Granted SpacetimeDB identity determines role; navigation/request fields cannot grant access.
- Private SpacetimeDB conversation rows persist operator messages and coordinator planning, assignment and terminal replies. Reload retrieves actual conversation. Messages append without replacing existing transcript nodes or disturbing a reader scrolled away from the bottom.
- Typed `Status` reads measured results without inference. `Stop` cancels the authenticated side's active operation. Changed objectives while active receive an explicit not-applied reply. No conversational replanning is claimed.
- Activity rows use persisted operator messages, queued/failed attempts, committed receipts and visible threats, retaining operation/action/evidence links. Cards and modals use persisted worker lifecycle and scoped activity; statistics derive from evidence. Unchanged card nodes survive fleet ticks so clicks work.
- Selected-drone context reaches Node and SpacetimeDB. Hidden targets, conflicting idempotency reuse, and plans outside the selected target are rejected.
- Both roles use one fleet epoch and authoritative subscriptions. Policy application is separate from verified recovery; verification requires unauthorized 403 and legitimate 200 probes. Fresh fleet starts now retain old evidence while live views filter the current epoch.
- Discovery is excluded from specialist decisions after that target is discovered, preventing the redundant loop observed in the final paid attempt. Explicit schema-constrained `declined`/`refused`/`rejected` task placeholders are classified as provider refusal before assignment/execution.

## Checks

- TypeScript check and WASM build passed.
- Full deterministic suite: **27 passed, zero failed/skipped**. The affected chat/client tests were rerun after final hardening. Provider calls are explicitly mocked in these tests; SpacetimeDB, authentication, reducers and persistence are real.
- Browser mechanism check passed with mocked inference: two attackers, two defenders, same epoch, twelve evidence records, 403/200 verification, card/modal agreement, safe model text, selected-context submission, duplicate protection, role privacy, durable conversation reload, append-only transcript and retained scroll, changed-objective rejection, typed cancellation, and visible rate-limit failure without fixture actions.
- Existing fleet regression passed: 128 drones / 32 agents, role-scoped views, unauthorized/private-table denial, independent motion, takeover, verified recovery, hardened denial, stop and fresh epoch.
- Screenshots and deterministic capture: `output/fleet-ui-mocked/`. These are labeled mocked inference and are not model-quality evidence.

## Actual Bitdeer attempts

Sanitized capture: [fleet-ui-bitdeer-attempts.json](evidence/fleet-ui-bitdeer-attempts.json). Both model settings were `zai-org/GLM-5.3-Flash`; strict JSON Schema responses were independently validated. No provider secrets or private reasoning are in the capture.

| Attempt | Genuine result |
| --- | --- |
| 1, 21:26:34 UTC | Coordinator timed out at 15 seconds; failed operation, no assignments or actions. Usage unavailable. |
| 2, 21:27:13 UTC | Two attackers chose discovery and commands: evidence 1–2 discovery, 3–4 accepted commands. Defender coordinator hit the 2,048-token cap; failed, no recovery. Six calls, 6,722 reported tokens. |
| 3, 21:31:22 UTC | With 3,072 coordinator tokens / 20-second timeout, coordinator chose passive discovery only. Specialists repeatedly discovered targets until their decision caps. Seventeen calls, 19,475 tokens; no takeover. Operation ended with paused workers and zero accepted commands, not a successful objective. |

Review of attempt 2 also found that the coordinator's task objectives were literally `declined`, even though specialists subsequently selected commands. This is a validation defect, not a passing coordinated attack. The final code rejects those refusal placeholders before deploying specialists; a deterministic regression covers it. Attempt 3's redundant discovery loop is also blocked in the final code. These two final changes were **not** rechecked with paid inference; no further credits were spent trying to force a successful narrative.

Total latest-UI paid attempts: **24 requests, 26,197 reported tokens**, plus unknown usage from the timed-out request. Each attempt used a temporary owned local simulation, which was removed after capture. Neither the older successful run in `FLEET_CHAT_VALIDATION.md` nor these partial results establish a passing credentialed latest-UI takeover/recovery run.

## Final configuration and limits

| Setting | Value |
| --- | --- |
| Coordinator | `BITDEER_COORDINATOR_MODEL=zai-org/GLM-5.3-Flash` |
| Specialists | `BITDEER_SPECIALIST_MODEL=zai-org/GLM-5.3-Flash` |
| Optional coordinator upgrade | Explicit `zai-org/GLM-5.3`; not automatically used or tested here |
| Shared inference concurrency | 4 by default, across existing runtimes |
| Per operation | 1 coordinator; 2–4 specialists; up to 8 decisions each; 33 calls total |
| Time | 45 seconds per operation including planning; reactive sandbox has no global expiry |
| Per request | Coordinator: 3,072 output tokens / 20 seconds; specialist: 2,048 / 15 seconds |
| Retries/fallback | No automatic provider retries, upgrades, or fixture security decisions |

Remaining: a passing credentialed full scenario on the final code; reliable model adherence to the objective; arbitrary conversational replanning; HTTP-practice-to-fleet linkage; production deployment/isolation and retention policy. Fleet actions are simulation reducers, not real network penetration tests. See [FLEET_CHAT_API.md](FLEET_CHAT_API.md) for setup and contracts.

## Reactive sandbox update

The first attacker objective now activates a persistent shared fleet. Defender-first objectives are rejected without creating or resetting a fleet. The existing browser mechanism test starts from an empty database and exercises this flow. A real-database test waits 61 seconds after attacker execution, checks that movement continues with no new inference calls, then performs opposing operations in the same epoch. Timed fixture playback remains unchanged. This lifecycle change was verified with mocked inference; no additional paid model requests were made.

## Hackathon role switching

The deployed hackathon URL now opens without sign-in. Its existing Attacker/Defender buttons switch scoped subscriptions and separate conversations in one browser tab, preserving the selected role across reloads and leaving the shared fleet unchanged. A fresh-browser demo check uses no tokens or cookies. The full mocked browser scenario passes with login-free switching; ordinary session authorization remains covered by the 27-test regression suite. This deployment intentionally permits anyone with access to its URL to control both sides. No additional paid inference was used for this change.

## UI and chat lifecycle repair — 2026-10-24

Implemented in the existing `/tmp/sudoko-chat-integration` worktree (`feat/bitdeer-chat-integration`), retaining Claude's uncommitted footer removal. The other worktrees were not overwritten. Actual entry point: `web/fleet.html` + `web/fleet.ts`, served by `sandbox/src/service.ts` on localhost:4180; SpacetimeDB is the existing localhost:3001 service. The older main checkout's storyboard and fixture server are separate and were left alone.

The root layout bug was grid auto-placement: hiding the optional error row put main in the `auto` row and left the flexible row unused. The deleted footer still had a reserved row, and the fixed 300px log squeezed the viewport to 60px. Explicit row placement, removal of the unused footer track/styles, a bounded log, compact empty rail, laptop columns, and the chat input's corrected border-box height fix those causes without additional override layers.

| Browser size | Before swarm height | After workspace / swarm / log height |
| --- | --- | --- |
| 1440×900 | 60px | 844 / 588 / 216px |
| 1920×1080 | 60px | 1024 / 744 / 240px |
| 1200×800 | Previously stacked below the 1280px breakpoint | 744 / 512 / 192px |

Before screenshots: `output/ui-repair/before-{1440x900,1920x1080,1280x800}.png`. Final running-app screenshots: `output/ui-repair/after-{1440x900,1920x1080,1200x800}.png`. Computed measurements and final console/network results: `output/ui-repair/after.json` (zero page errors, console errors, or failed responses). Controls and legend bounds and canvas/container aspect are asserted in the browser check. Existing ResizeObserver already updates renderer dimensions and camera aspect; that mechanism was retained and exercised by resizing.

Final mocked-inference browser acceptance uses real temporary SpacetimeDB and the real UI/backend: `output/fleet-demo-mocked/evidence.json`. It passes fresh fleet with 48 drones/zero agents; waiting without false Stale; attacker deployment; validated duplicate display-name resolution; server-generated IDs; simulated takeover; independent defender deployment in the same epoch; evidence-linked denial (403) and legitimate acceptance (200); recovery; cancelling running specialists without further actions; role-private history; refresh without redeployment; preserved transcript scroll; provider failure without fixtures; loading, offline and fleet-ended states. Screenshots for these states are in the same directory. Mocked inference proves the mechanism, not model quality.

The database tests additionally reject malformed/duplicate/oversized names and identity collisions atomically, validate selected targets and permissions, deploy defenders first on a fresh fleet, hold movement for 61 seconds without idle inference, and cancel queued workers through privileged fleet stop. IDs are independent of display names and the profile view is role-scoped.

### Credentialed Bitdeer evidence and remaining gap

A real Flash smoke initially hit HTTP 400 because the endpoint rejects the added schema regex constraints. A one-output-token diagnostic confirmed HTTP 400 with the patterns and HTTP 200 without them. Node and reducer validation still enforce names; provider schema enforcement is not trusted as authorization. Bitdeer's structured-output documentation notes unsupported schemas return errors: https://developers.bitdeer.ai/docs/guides/llm/structured-outputs.

The corrected credentialed browser run (`output/fleet-demo-smoke/evidence.json`) produced three attackers named Scout, Aegis and Forge and **three accepted simulated unauthorized commands**. The defender coordinator named Aegis, Trace, Cutter and Anchor; one specialist produced **one verified recovery**, with paired denial/legitimate-acceptance receipts. The defender operation ultimately **failed** with provider/operation timeouts; this is not a passing credentialed end-to-end scenario. There were 18 requests in the two operations and 23,654 reported tokens; timed-out requests may have unreported usage. The successful one-token schema diagnostic reported 63 total tokens. Failed HTTP 400 attempts reported no usage.

After that evidence, the bounded operation budget was increased from 45 to 75 seconds and specialist requests from 15 to 20 seconds, allowing planning plus the two-action isolation/verification path. Counts remain 2–4 specialists, at most 8 decisions each / 33 model calls, unchanged token caps, and the same shared inference pool. Final mocked browser/runtime checks cover these limits; **the increased window and clarified defender plan prompt have not been retested with paid inference**. No provider retry, model upgrade or fixture fallback was added. Provider latency/adherence remains the outstanding live-demo reliability check.

### Running deployment

The existing `sudoko-chat-backend.service` was restarted in place and its SpacetimeDB module updated without resetting the fleet or deleting operation/history evidence. Only unreferenced fixture seed agents are retired. Later user-submitted operations remain intact. The local app is http://127.0.0.1:4180/; the existing ingress is https://neo.taile1abc7.ts.net:4174/. No ingress routes were changed.

From `/tmp/sudoko-chat-integration`, start in the foreground with:

```sh
npm run build:fleet
node --env-file=.env --env-file=.demo.env --env-file=output/deployment/backend.env sandbox/src/service.ts
```

If the supervised service is already active, use `systemctl --user restart sudoko-chat-backend.service` instead of starting a second listener. The operator helper in `output/deployment/fleet-control.mjs` retains explicit status/stop/reset, and reset now creates zero agents. No production isolation/deployment or load-test claim is made.

Final validation commands passed: `npm run typecheck`, `npm run spacetime:build`, `npm run build:fleet`, `SPACETIME_BINARY=… npm test` (27 passed, zero skipped), and `SPACETIME_BINARY=… PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=… npm run test:fleet-chat -- --demo`. Browser checks use explicitly mocked inference and real databases. Natural-language “What is the status of our fleet?” now uses the existing read-only status command rather than starting an unintended deployment; the browser check exercises duplicate protection and refresh for that phrase.

## Conversational routing, attacker execution and latency — 2026-10-24

The previous section is historical evidence from the layout/lifecycle repair. The following supersedes its chat and latency limitations.

The actual failed attacker operation `661fd9a3-6179-4f2a-884f-c1420bf879e5` (`Discover vulnerabilities and exploit`) was traced from the current durable database. Submission and authentication succeeded, but the coordinator timed out after **20,041ms**, before returning any plan. Tasks/agents/actions were empty. The first failing stage was inference, not target discovery, IDs, role/epoch validation or subscriptions. A separate earlier defender status question had incorrectly entered the deployment pipeline; the general fallback was forcing all non-keyword text into a plan. Sanitized baseline and inference records are in `output/conversation-repair/baseline.json`.

Changes reuse the same service, authentication, shared DecisionPool, SpacetimeDB reducers and model adapter:

- Ordinary chat uses private durable conversation turns with immediate message/turn IDs. One complete structured response answers, clarifies or produces a validated deployment plan. That plan is reused directly without another coordinator call.
- Context is bounded and role-private. Questions make no fleet mutations; state and failure explanations use the caller's observations, receipt/error summaries and validated evidence IDs. General questions work before any deployment. Follow-ups resolve against recent messages/assignments. Active replacement joins cancellation before deploying, and Stop/Pause bypass model inference. Continue creates a fresh bounded plan, rather than claiming exact worker resumption.
- The same configured `zai-org/GLM-5.3-Flash` model remains independently configurable for coordinator and specialists. Low reasoning was measured before use. Output caps are now 1,536/512 tokens; concise context and default two-agent plans reduce unnecessary reasoning/output. No automatic retries or model switching were introduced.
- Existing polling accelerates from 750ms to 250ms while work is active. Queued/running turns are visible; full answers/plans append as available. Complete actions remain schema-validated before reducer execution. Provider failures appear in chat and Activity without fixture substitution.
- Timing records distinguish context construction, queue wait, inference, validation/deployment, reducer commit and receipt reads. Public reports must not confuse request acceptance with operation completion.

Small real model benchmark (`output/conversation-repair/model-benchmark.json`): identical bounded question/schema, provider default **2,718ms / 372 completion tokens**, low effort **1,587ms / 66 tokens** and **839ms / 63 tokens**. These are three small observations, not a general model-speed guarantee; no model was changed.

Credentialed Chromium acceptance passed against an isolated real SpacetimeDB fleet (`output/conversation-real/report.json`):

| Browser measurement | Fresh attack | Defensive recovery | Hardened attack |
| --- | ---: | ---: | ---: |
| Acknowledgment | 372ms | 1,020ms | 613ms |
| First visible acceptance/progress | 382ms | 1,144ms | 691ms |
| Useful coordinator/plan reply observed in chat | 4,573ms | 4,014ms | 2,986ms |
| Server coordinator reply available | 2,243ms | 1,436ms | 1,820ms |
| First executed action | 3,517ms | 3,289ms | 3,560ms |
| Full operation completion | 4,987ms | 4,748ms | 5,130ms |

The browser/polling observation and server timings have different measurement points. The browser's useful-reply check waits for a persisted reply bubble, so it can finish after the first action. This capture preceded the final 250ms active polling change; those numbers are not claimed as a new measurement of that final interval. No baseline acknowledgment or first-progress timing had been recorded for the old failed operation, so those before values are unavailable, not zero.

In the successful fresh attack, coordinator inference was **1,845ms**, validation/deployment **39ms**, specialist calls **675–768ms**, and action commit plus receipt read **90–118ms**. The earlier capture's `queueWaitMs` also included initial progress persistence (17–109ms across calls), so those are admission overhead upper bounds, not evidence of inference congestion. Final instrumentation measures the actual pool wait separately and separates reducer commit from receipt reads.

“What can you do?” produced a useful answer/clarification with zero agents (270ms acknowledgment, useful reply observed by 2,197ms). “What is the current swarm status?” reported the absence of attacker discoveries/evidence (390ms acknowledgment, useful reply by 1,472ms), without inventing private fleet state. The attack discovered from an empty target-observation list and committed **two unauthorized control changes**, evidence IDs 3/4. The “Why did that fail?” question did not deploy; the contextual follow-up stayed on the same targets and committed another accepted command. Defenders in the same epoch produced **two verified recoveries**, evidence IDs 10/13, with corresponding unauthorized 403 and legitimate 200 probes. The hardened fleet produced **two 403 command denials**, evidence IDs 16/17, and zero unauthorized control changes. A pending real coordinator request was cancelled through Stop, with no later actions; refresh restored conversation and operations.

That run contains 21 completed recorded inference calls and **10,670 reported total tokens**, plus a cancelled request whose usage was not reported. The three small benchmark requests reported 672 tokens total. No real model requests targeted external systems; all effects are owned reducer-simulation outcomes. Screenshots: `output/conversation-real/questions-zero-agents.png`, `attacker-executed.png`, `defender-recovery.png`, `hardened-denial.png`.

Final mocked inference + real database/browser checks additionally cover active-operation replacement, Pause cancellation of running specialists, Continue with revalidation, provider rate-limit visibility, bounded role-private context, and durable pending-turn interruption on restart. The final complete runtime suite has 27 passing tests with zero skipped; existing fleet UI regressions also pass. Commands: `npm run typecheck`, `npm run build:fleet`, `SPACETIME_BINARY=… npm test`, `SPACETIME_BINARY=… PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=… npm run test:fleet-conversation`, and the existing `test:fleet-chat -- --demo`. A fresh paid acceptance can be requested with `npm run smoke:fleet-conversation`; it is not run automatically.

No production isolation, sustained-load, or provider-wide latency guarantee is established by these tests.

The updated existing HTTPS deployment was also checked in Chromium without resetting it. Asking **“Why did that attack fail?”** returned: “The operation failed before any attack activity ran: recorded failures show provider_timeout at the coordinator stage, so no commands were accepted or blocked and no targets were reached. It was an infrastructure timeout, not a target defense.” Acknowledgment was **199ms**, visible answer **1,595ms**, exact inference-pool wait **0ms**, context construction **19ms**, and provider inference **1,219ms**. Agent/evidence/operation counts remained exactly **3 / 10 / 2**. There were no browser page errors. Capture: `output/conversation-repair/live-question.json` and `live-failure-explanation.png`. This confirms the actual failed live session is explained rather than silently redeployed. The answer was 624 reported tokens, including one reasoning token. The existing backend/HTTPS route remains running; no credentials, history or other-side operation was reset.
