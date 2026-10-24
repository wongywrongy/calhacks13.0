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
