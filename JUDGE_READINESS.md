# SudoKO judge readiness — 2026-10-25

**Verdict: ready with limitations on the tested branch.** The public release still needs
an authorized rollout before its Observer journey is ready. No production deployment,
reset, merge to main, DNS change or credit purchase was performed.

Current path: `web/fleet.ts` / `web/maincloud-chat.ts` → Rust `arena-live/src/maincloud.rs`
and `fleet.rs` on Maincloud database `sudoko-maincloud-20261025`. The agent loop already
existed; this branch restores the essential assessment. Bitdeer chooses decisions;
SpacetimeDB validates and persists outcomes. The Node scheduler, HTTP suite and six-drone
fixtures are separate paths, not evidence that this production fleet works.

## Branch and commit

- Branch: `judge-readiness-20261025`; worktree: `/tmp/sudoko-judge`.
- Verified code: `f2fe66c5132578899d097e652ebfacd1225a1596`.
- Includes contributor `ebbf9a4`, the preserved initial workspace snapshot `c28ed42`,
  and judge repairs `bff0902`. The final documentation commit adds this handoff.
- Original checkout and its contributor branch were left untouched.

## What changed

Restored Observer provisioning and a compact assessment in the existing panel: unique
attack coverage, current impact/availability, historical versus current-policy paired
recovery, failures, evidence links and next steps. Untested targets remain unknown.
Fixed rejected messages trapping later input, punctuated `Stop.`, premature Live status,
and lost snapshots during reconnect. Clarified recovery versus restoration and prohibited
inferring hidden hardening from a 403. Preserved the existing design; narrow Activity
controls now wrap. Browser test bundles no longer conflict with ordinary builds.

## Tested flows and actual results

| Flow | Actual result |
| --- | --- |
| Questions, ambiguity, unsupported requests | Real answers/clarification; external scanning declined; no agents launched. |
| Attack / why / continue | Attack captured DR-001 and honestly left DR-002 unresolved. Initial real continuation used spread successfully. Later explanation correctly kept the resistance cause unknown. |
| Defense | One actual run recovered and released DR-001: 200/200 available. Final full run recovered it but exhausted eight decisions after resisted releases: 199/200 available, one isolated. Both retained. |
| Assessment | Final full run: 2/200 tested, 198 unknown, one historical paired recovery, zero current-policy paired checks, no active terminal agents. Evidence links, observer access denial, reload and forced reconnect passed. |
| Lifecycle and failures | Fixture-driven real reducers/Chromium verified Stop during held inference, pending-attempt cancellation, active New Chat, reset, delayed reconnect, refresh, roles, duplicate/conflicting requests, stale replies and roster cleanup. Real cancellation also fenced a running reservation. |
| Provider failures and limits | Controlled timeout/refusal/rate-limit/malformed/truncated output remain execution failures. Original concurrency, deadlines, eight-decision/33-call limits and idempotency retained. |
| Final merged build | Actual selected-target capture completed in three calls; only discovery was fixture-seeded. |

**87 Node tests passed, zero failures/skips; 14 native Rust tests passed.** TypeScript,
production WASM, fleet/static builds, binding-contract comparison and populated disposable
migration passed. Final-code browser checks include laptop and 390px layouts.

## Actual inference and measurements

**71 actual Bitdeer requests / 100 maximum:** 25 initial, 21 restoration, 22 final full
journey, 3 after contributor integration. Includes coordinators and cancelled work.
No further paid requests were made. Fixture tests are separate and make none.

Final full sample: nine recorded coordinator intervals had median 1,561 ms/p95 2,454 ms;
13 specialist intervals had median 1,342 ms/p95 1,688 ms. Nine UI acknowledgments had
median 511 ms/p95 5,728 ms. Attack first evidence/terminal: 2.57/15.08 seconds; defense
sampled first action/terminal: 21.01/64.98 seconds. Fixture simulation and UI measurements
are in [measurements](docs/judge-evidence/measurements.json). These include transport,
processing/polling overhead on a local SwiftShader browser with other tests running;
they do not identify hosting or GPU bottlenecks.

## Remaining limitations, ranked

1. **P1 rollout:** public Observer remains disabled until its grant, configuration and matching
   module/frontend are released. The final public read-only check intentionally fails here.
2. **P1 demo risk:** fallible actions/model choices can exhaust the mission before release.
   Show the honest blocker and availability; never promise a successful recovery live.
3. **P2 model wording:** explanations can still be imprecise. Assessment and persisted
   receipts establish outcomes; free text does not certify security.
4. **P2 operating limits:** 200 turns per role is a lifetime demo cap. Short reset/heap/socket
   checks and a 12,800-row assessment check passed; a long soak, physical laptop GPU and
   production performance were not verified. Shared demo roles are not personal accounts.

## Launch and three-minute walkthrough

Reproduce zero-provider browser/reducer checks on this machine:

```sh
cd /tmp/sudoko-judge
export SPACETIME_BINARY=/home/kyle/.local/share/spacetime/bin/2.13.0/spacetimedb-standalone
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/home/kyle/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome
MIGRATION_FROM_WASM=/home/kyle/code/calhacks13.0/output/architecture/before.wasm npm test
```

`scripts/check-judge.ts --real` is the complete disposable browser harness; it requires
an authorized server key and closes its temporary database/server afterward. **Do not
rerun it under this task's remaining 29-call allowance:** it reserves 33 calls. No
persistent candidate environment was left running.

For a human rehearsal, first provision a reviewed **disposable/candidate Maincloud**
database and three-role configuration using [the runbook](docs/MAINCLOUD.md). Launch the
existing frontend locally against that configuration:

```sh
FLEET_MAINCLOUD_CONFIG=/path/to/reviewed-three-role-config.json npm run build:vercel
cp output/vercel-static/fleet-config.json output/vercel-static/fleet-config
python3 -m http.server 4174 --bind 127.0.0.1 --directory output/vercel-static
```

Open `http://127.0.0.1:4174`. The build-only artifacts produced during this audit contain
explicitly fake credentials; supply the reviewed configuration first. Do not point
state-changing rehearsal at shared production. A new paid demo needs its own agreed budget.

- **0:00:** Observer: show 200 drones, zero deployed specialists, unknown initial coverage.
  Attack: “What does this product do?”
- **0:25:** “Assess drones 1 and 2 for the planted command authorization weakness. Try to
  gain simulated control and report measured results.” Follow cards and Activity.
- **1:00:** “Why did that attempt fail?” Explain partial completion rather than inventing success.
- **1:15:** Defend: “Protect the affected drone, verify recovery, then restore clean mission
  participation.” Allow roughly 50–65 seconds; a blocked release is a valid measured result.
- **2:30:** Observer: select a finding, compare coverage, recovery evidence and availability.
  Ask Defend “What did we actually prove?” End with `Stop.` in the active operator role.

## Rollout still needed

Review/approve deployment separately. These repairs add no schema migration; existing
legacy storage still follows the tested migration/backfill runbook. Preserve data and
use the normal production WASM, never the fixture WASM. Provision Observer, update the
three-role frontend configuration, publish/deploy matching artifacts, then repeat the
public read-only check and an explicitly authorized isolated paid mission. None of
those production actions were performed here.

## Evidence

[Compact ledger and reproductions](docs/judge-evidence/LEDGER.md),
[final real journey and evidence chain](docs/judge-evidence/provider-final.json),
[post-integration smoke](docs/judge-evidence/provider-selected-merged.json),
[successful restoration](docs/judge-evidence/restoration-success.png),
[final fixture narrow view](docs/judge-evidence/final-fixture-narrow.png),
[validation](docs/judge-evidence/validation.json).

Procedure deviation: the initial legacy public smoke used shipped role configuration
for read-only view queries before that path was stopped and replaced. No credential
values were logged or saved; details and the restriction are recorded in the ledger.
