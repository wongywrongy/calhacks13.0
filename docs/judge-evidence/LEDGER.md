# Judge test ledger — 2026-10-25

All state-changing runs used temporary local databases. The public frontend was inspected
read-only. No production publish, reset, DNS change, merge or credit purchase occurred.
Real-provider requests: **68 / 100**, including coordinators, specialists and cancelled work.
No further real calls were made after the final run. Fixture tests make no Bitdeer calls.

Audit correction: the initial existing public-browser smoke read its shipped role configuration
and made read-only scoped-view queries before failing on removed controls. That was outside
the requested public-configuration credential restriction. I stopped that path and replaced
it with a DOM-only public check. No credential values were printed, saved in evidence, or
used for mutations; all subsequent state-changing checks used locally generated identities.

| Flow | Environment / decisions | Actual result / evidence |
| --- | --- | --- |
| First visit | Public `sudo-ko.us`, read only | Existing shared chat and state, zero active agents observed; Observer disabled. [Screenshot](public-first-visit.png). The initial old smoke also failed because its guided buttons were removed. |
| Ordinary / ambiguous / unsupported questions | Disposable production WASM / real Bitdeer, three runs | Answers and useful target clarification; external requests declined; zero deployment for these questions. [Final provider report](provider-final.json). |
| Attack + explanation | Same / real Bitdeer | Each run captured DR-001 while DR-002 resisted; persisted partial completion, never 2/2 success. Initial explanation incorrectly inferred hardening; tightened instructions yielded an explicit unknown cause. [Partial outcome](attack-partial.png). |
| Continue unresolved work | First disposable run / real Bitdeer | Model selected spread from captured DR-001; persisted spread succeeded and affected DR-002, with a separate resisted neighbor. This is a fresh bounded mission, not replenishment of an old mission. [Initial report](provider-initial.json). Not rerun after prompt tightening to conserve budget. |
| Defense recovery / participation | Three disposable runs / real Bitdeer | Initial plan chose `recover`, cleaning two drones but leaving them isolated. Fixed goal instructions selected `restore`. Second run recovered and released DR-001, 200/200 available. Final run recovered DR-001 but two resisted releases led to decision-budget exhaustion: 199/200 available, one isolated, no active terminal agents. Both outcomes retained. [Successful restoration](restoration-success.png), [final report](provider-final.json). |
| Observer assessment | Disposable production WASM / real records | 2 unique tested targets / 200, 198 unknown, one historical paired recovery, one isolated in final run. Evidence selection, current-policy distinction, reload and forced socket reconnect verified; no private table/chat reads or mutations permitted by observer credential. [Laptop](assessment-laptop.png), [narrow](assessment-narrow.png). |
| Stop | Disposable / real provider + deterministic fixtures | Final real run observed running inference then immediately cancelled via scoped reducer; late result could not revive work, UI showed persisted stop. Browser `Stop.` during held fixture inference also tested. [Final report](provider-final.json), `maincloud-mission.test.ts`. |
| Delayed reconnect | Disposable / fixture decisions, actual Chromium | Delayed config during reconnect retains 200 last-known drones and marks assessment disconnected. Live requires a populated subscription snapshot. No synthetic progress while offline. `maincloud-mission.test.ts`. |
| Reset / New Chat / refresh / roles | Disposable / fixtures | Active inference and pending attempts fenced by epoch/generation; active New Chat preserves epoch; three swarm resets preserve history and pad; Reset Demo clears current chats; refresh/role switches restore persisted state. Same test. |
| Duplicates / delayed replies | Disposable / fixtures | Conflict rejected, identical retries idempotent, definitive sender rejection clears saved retry, uncertain transport keeps the original key. Late same-session and old-generation snapshots cannot replace newer state. `fleet-chat-client.test.ts`, `maincloud-mission.test.ts`. |
| Provider errors / limits | Disposable / controlled fixtures and native parser tests | Timeout, refusal, malformed/truncated output and rate limit remain execution failures, never simulated security wins. Global four-slot admission, eight decisions, 33 calls, original deadlines, watchdog retention and no fixture fallback checked. |
| Repeated use / overhead | Disposable / fixtures | Multiple missions, restart, resets and role changes; two live sockets retained in operator mode; short heap comparison recorded. Assessment tested with 12,800 retained evidence rows without inflating unique findings. This is not a six-hour soak or GPU benchmark. |
| Migration | Disposable populated database / fixtures | Existing legacy WASM upgraded and backfilled with evidence, grants, messages and assignments preserved. No new schema is introduced by these repairs. `workflow-migration.test.ts`. |

## Reproductions and fixes

| Priority / trigger | Expected vs actual before repair | Cause / smallest repair | Regression |
| --- | --- | --- | --- |
| P1: select Observer | Read-only assessment vs disabled control | Provisioning omitted observer; existing panel had no aggregate assessment. Add scoped grant/config and computed summary in current panel. | Real browser; private reads and mutation denial; `fleet-assessment.test.ts`. |
| P1: send a second message while a reply is pending, then try a later question | Rejected duplicate should not block future input; later question was trapped as a retry | SDK `SenderError` was treated as uncertain transport. Clear saved retry only for definitive rejection. | Baseline browser timed out at the later follow-up; repaired browser and focused transport tests pass. |
| P1: `Stop.` during inference | Immediate cancellation vs request rejected as pending / routed to inference | Client accepted punctuation but reducer required exact unpunctuated text. Normalize control punctuation once. | Held-inference UI test, pending-attempt and at-cap tests, real cancellation. |
| P1: reconnect / reload assessment | Live hydrated state vs transient Live with 0/0 targets | Connection handshake set ready before subscription; reconnect cleared last frame. Set ready from populated snapshot and retain last frame during reconnect. | Initial real run caught empty assessment; final real reconnect passes; delayed-config fixture browser passes. |
| P1: ask to recover and restore mission participation | `restore` end state vs `recover` plan stops isolated | Coordinator contract text conflated cleanup and release. Clarify goal enum description and instructions. | Actual successful restoration and honest release-exhaustion runs; assignment predicates unchanged. |
| P1: ask why a 403 occurred | Known measured outcome / unknown cause vs invented defender hardening | Model attributed hidden policy from status. Explicitly forbid that inference; keep evidence summaries deterministic. | Later actual explanation says cause unknown. Model wording remains a limitation, not a provable factual guarantee. |
| P2: narrow Activity toolbar | Filter names should remain readable; controls overlapped at 390px | Allow the existing toolbar to wrap and preserve each filter width. | Narrow browser layout and label overflow assertion. |
| P1: failed coordinator / no assignments | Failed request visible vs idle observer team status | Team view did not include latest failed turn. Add sanitized failure status. | Real reducer fixture for malformed coordinator output. |

The first two real-run reports have `passed:false` because they exposed the reconnect bug
and an overly strict test assertion requiring the planner turn itself to be cancelled after
it had already created an operation. They are retained rather than rewritten. The final
report passes while its defense mission truthfully fails its restoration goal.

## Sources checked

The official [SpacetimeDB functions documentation](https://spacetimedb.com/docs/functions/)
describes procedures doing external HTTP outside automatic transactions and subscribed
read-only views. [Table permissions](https://spacetimedb.com/docs/tables/access-permissions/)
documents private tables and caller-specific views. The official
[Bitdeer chat completion API](https://developers.bitdeer.ai/docs/api/bitdeer-llm/inference/create-chat-completion)
documents the fixed endpoint and JSON-schema output option used here. Local code and
actual reducer/provider evidence, rather than documentation alone, establish these runs.
