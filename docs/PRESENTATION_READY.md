# SudoKO presentation readiness plan

> **Historical planning document** (baseline commit `8667003`). Its "do not expand into a
> larger fleet" scope and checkpoint schedule predate fleet mode and are not current
> requirements. See `README.md` for entry points and `FLEET.md` for the swarm workspace.

Planning baseline: backend commit `8667003`, draft PR #4. Current implementation has
15 passing tests and 111 ordered HTTP assertions. Real inference, live board integration,
and Docker execution are not yet verified. This plan narrows the hackathon delivery;
`TARGET_SPEC.md` remains the longer-term design, not a checklist to finish this weekend.

## The deliverable

A judge can watch two teams operate against a synthetic application, see a measured
breach and defensive response, inspect why the result happened, and understand what is
fixture-driven versus model-driven. The same application runs a repeatable regression
scenario and preserves a recorded model run for dependable presentation.

Pitch: **SudoKO is an evaluation arena for testing whether AI security teams stop breaches
without breaking legitimate operations.** The first user is an engineer building an AI
security assistant who needs to test model or policy changes before deployment. Success
means finding a failing control, verifying a repair, and retaining the evidence to catch
regressions. The current prototype evaluates our own planted application weaknesses.

The minimum presentation has:

- Two teams with three attacker specialists and two defenders each; no additional roles.
- The current two namespace assets, displayed honestly as two application assets.
- The existing three scenario families and three legitimate application workflows.
- One working Bitdeer model configuration with captured decision evidence.
- A Spacetime-backed live board and a labelled recorded-run mode.
- One deterministic breach/recovery demonstration, plus actual model-run evidence.
- A tested launch/reset procedure and a local video backup.

Do not expand into a larger fleet, real hardware, new CVEs, additional databases, general
agent frameworks, autonomous code patching, or production security certification.
Cartesia is optional after the core demonstration passes all release gates.

## Delivery order and checkpoints

Times below are target checkpoints in Pacific time, not effort guarantees. The published
submission deadline is Sunday, October 25 at 9:00 AM PDT. Aim to submit by 8:15 AM.
If starting later, cut optional work; protect recording, rehearsal and submission time.

| Checkpoint | Outcome | Evidence required |
| --- | --- | --- |
| First hour | Model credentials, Docker host, Spacetime deployment access and board choice settled | One real model response; available runtime; a selected UI branch |
| Saturday noon | Real-model backend and minimum live event path work | Model action reaches HTTP; two viewers receive measured events |
| Saturday 6 PM | Complete demo candidate | Breach, defense, verification and control change appear on the board |
| Saturday 10 PM | Integrated rehearsal and model evidence complete | Repeated runs, clean reset, labelled replay and captured comparison |
| Sunday 6 AM | Release candidate and recordings frozen | Tested commit, video, screenshots and submission draft |
| Sunday 7:30 AM | Three-minute presentation rehearsed | Runs from the actual demo laptop; backup plays offline |
| Sunday 8:15 AM | Submission complete | Repository link, video, image, description and applicable tracks checked |

Use one integration branch based on PR #4. Port the useful fleet view/subscription code
from existing branches deliberately; do not merge all prototypes wholesale. Keep the
service/referee as the authority. After checks pass, make the submitted default branch or
explicit release link point to the tested build, not the stale main prototype.

## 1. Prove the provider path before building more UI

Obtain the Bitdeer API key and an available model ID through the team's account. Keep keys
outside git and recordings. Confirm one real request before scheduling a multi-agent run.
Bitdeer's event starter guide provides the credit-request and Model Studio setup path.

Improve `inferenceMessages` before evaluating agents. Give each runtime model the scenario
descriptions, action argument schemas, role objective, team scope, task lifecycle, relevant
request outcomes and remaining budget. Scenario IDs alone are insufficient context.
Keep untrusted request content clearly distinguishable from operator instructions.

Run one decision end to end, then the existing ten-security-agent configuration. Verify
the model's parsed action caused a measured request or policy change. Record provider,
model, inference latency, usage when supplied, invalid actions and provider failures.
Use explicit completion/call budgets; do not equate ten loops with ten isolated models.

Pass: a credentialed run completes, at least one attacker and defender action is evidenced,
and every reported outcome comes from the application/referee. If models do not coordinate
or do not follow the deceptive instruction, retain that result. The fixture validator
still demonstrates the mechanism; it must not be described as model behavior.

Blocked path: if provider access fails, the backend and UI can proceed using fixtures,
but the release cannot claim demonstrated autonomous AI or working Bitdeer integration.

## 2. Connect the measured backend to Spacetime

Build the smallest trusted publisher from service/referee events to Spacetime. It can
consume incremental snapshots with an event cursor; a new distributed event system is
unnecessary. Use authenticated ingestion and bind writes to the publisher identity.
The browser subscribes to sanitized match, actor, asset and event projections.

Required fields: match ID, event sequence, round, timestamp, actor/team, kind, target,
scenario, policy version and causation/evidence references. Publish structured actions
and outcomes, not raw tokens, provider keys or private model reasoning. Include run engine
and model metadata. Per-kind public field selection should be explicit.

Exclude the old public flag/token tables and unrestricted outcome reducers from the live
deployment. Viewers and security agents cannot publish scores, invent events or reclaim
assets. A service-side verified transition is the only cause of a control change.

Pass: two browser windows show the same real event; refresh/reconnect restores the same
state without duplicate captures; a viewer write is rejected; a new match resets the
projection; no secret appears in a subscription. Pin compatible server/SDK versions and
test the actual deployment rather than assuming the old Rust and newer client align.

## 3. Make the board explain the experiment

Reuse the current fleet design where useful, but show two application assets until more
assets exist. Remove invented drone counts, CPU, memory, latency and container identifiers.
Use a read-only board; terminal-based start/stop is acceptable for the presentation and
avoids building an unrelated operator authentication interface this weekend.

The first screen must answer:

- Who is acting? Show both rosters, individual specialist role and latest action.
- What happened? Show actual asset control, captures and verified recoveries separately.
- Did legitimate work survive? Show request counts, success rate and p95 latency.
- Why did control change? Open the request → decision → rule → verification evidence.
- What am I watching? Separate Fixture/actual model from Live/Recorded/Disconnected.

Show unverified patches as pending. Never animate a reclaim merely because a rule was
written. On disconnect, freeze the last known state and show its age. A replay reads saved
events; it must not generate a convenient timeline. The recorded JSON viewer can remain
an engineering tool, but judges should not need to navigate raw files to understand impact.

Pass: someone who has not built the backend can identify the breach, the applied defense,
the legitimate-traffic outcome and whether the run uses a real model within 20 seconds.

## 4. Establish a small, honest evidence set

Keep two separate modes of proof:

| Proof | What it establishes | What it does not establish |
| --- | --- | --- |
| Ordered HTTP validator | Repeated breach, handoff, repair, utility and revocation assertions | Autonomous discovery or predictable model behavior |
| Model-driven matches | What actual configured models chose and what those choices caused | Guaranteed outcomes, general security, or enterprise-scale performance |

Run `npm test` and `npm run sandbox:validate` on the release candidate. Then run at least
three paired baseline/hardened model comparisons with the same model, prompts, scenario
version, actor counts and workload settings. Preserve unsuccessful trials. Report counts
and ranges; do not claim statistical significance from this small sample.

The comparison should show captures, verified recoveries, legitimate successes/attempts,
latency, completed handoffs and inference errors. Show a failed defense or availability
regression when it occurs. If a model never attempts maintenance-open, explain that the
authorization boundary was exercised by the deterministic validator rather than claiming
the model resisted a successful attack. Do not repeatedly tune the same case until a
desired result appears and then describe it as representative.

Select one intelligible captured run for presentation and retain a compact summary of all
trials. Label the selected recording and disclose its scenario/engine. This is a demo, not
a benchmark against Armadin or other commercial security products.

## 5. Verify deployment and reset on the actual demo machine

Run Compose on a Docker-capable host. Verify startup, inference-proxy readiness, restricted
service/runner egress, declared resource ceilings, stop behavior, credential revocation and
fresh state after restart. Ensure the results volume is writable by the runtime user.
Check proxy startup ordering and error behavior under an unavailable provider.

The attack target remains the internal application. Run the board/publisher through a
deliberate read-only projection boundary; never expose referee credentials to the browser.
Confirm venue networking only affects provider/live sync, not playback of the backup.

Pass: three consecutive start → run → stop → reset cycles work without hand-editing state.
One command starts the documented demo. A teammate can follow the README on the demo host.
The prerecorded video and saved evidence remain available with Wi-Fi disabled.

If Docker cannot be validated, accurately describe local mode as a loopback application
experiment. Do not advertise tested container isolation. This limits the claim, not the
validity of the measured application breach.

## 6. Add Cartesia only after the core works

If time remains, stream brief commentary from verified events: breach confirmed, patch
applied, recovery verified, legitimate traffic degraded. Use a small narration queue,
mute control and stale-event dropping. Voice failure must not block the experiment.
Avoid reading every request or making unsupported claims about what an agent intended.

Pass: actual Cartesia audio is heard during a run and helps a new viewer understand the
evidence. Otherwise omit the integration claim and the Cartesia prize submission.

## 7. Rehearse the three-minute presentation

| Time | What the judge sees/hears |
| --- | --- |
| 0:00–0:25 | Problem and user: engineers need to test AI defenders before trusting them with security actions |
| 0:25–0:45 | Two teams, owned application, normal users, evidence-based referee |
| 0:45–1:35 | Demonstration: actual leak, teammate evidence, defense, blocked retest, preserved utility and recovery |
| 1:35–2:10 | Actual model-run evidence and baseline/hardened results, with fixture/recording labels visible |
| 2:10–2:40 | Why the architecture matters: private authority, independently checked outcomes, real-time shared state |
| 2:40–3:00 | Practical impact and next step: regression testing for model/policy changes; state current limits |

Use live model decisions only if they run reliably within the time budget. Otherwise show
a labelled captured model run alongside the repeatable functional demonstration. Do not
promise the exact same live outcome. Prepare an uninterrupted local video under three
minutes and a short evidence-focused clip for asynchronous sponsor review.

Prepare concise answers to: What is genuinely breached? What is synthetic? Where does the
model decide? Why are multiple actors useful? What independently proves recovery? What
happens if legitimate traffic fails? What would a customer need to bring their own service?
The last answer is a roadmap: arbitrary customer-service onboarding is not implemented.

## Release gate

- [ ] Correct code is reachable from the submission repository/release link.
- [ ] Tests and ordered validator pass on the final commit.
- [ ] At least one actual model run has usable, accurately labelled evidence.
- [ ] Live measured events reach the board through authenticated Spacetime ingestion.
- [ ] Viewer writes fail and published data contains no private tokens or credentials.
- [ ] Reconnect, stop and reset work; an old run cannot contaminate a new match.
- [ ] Every claimed capture/recovery has application/referee evidence.
- [ ] Legitimate utility and errors remain visible, including unfavorable results.
- [ ] Deployment isolation claims match what was actually tested.
- [ ] Three rehearsals fit the presentation time, including an offline backup.
- [ ] Video, screenshot, project description, team and sponsor selections are submitted.

An unchecked item is a known limitation. Missing model evidence or the live board means
the full promised demo is not ready. Missing Cartesia or a larger fleet does not.

## Ownership if the team splits work

Backend owner handles model context, provider execution, publisher authority and reset.
Frontend owner handles subscriptions, evidence presentation and replay. A third teammate
can run trials and deployment checks; a fourth can record, rehearse and prepare submission.
Agree on the event contract first. With fewer people, follow the dependency order above
and drop narration. This allocation is a suggested team workflow, not additional runtime
agents or a requirement to introduce a multi-agent coding system.

## Sources

- Event requirements, judging and tracks: https://cal-hacks-13-0.devpost.com/
- Spacetime sponsor/prize announcement: https://spacetimedb.com/blog/spacetime-at-calhacks
- Bitdeer event setup: https://www.bitdeer.ai/en/blog/bitdeer-ai-starter-pack-for-cal-hacks-13-0/
- Cartesia capabilities: https://docs.cartesia.ai/get-started/overview
- Armadin's product direction: https://www.armadin.com/platform

Published pages were checked during the readiness review. Track titles do not supply a
complete sponsor-specific scoring rubric; confirm additional booth/event instructions
before submitting. Prioritize Armadin and genuine Bitdeer/Spacetime use over extra logos.
