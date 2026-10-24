# SudoKO target specification

SudoKO is a multi-agent security arena: two opposing teams operate against an owned
synthetic application while normal clients keep using it. Attacks must cause observable
application failures; defenders must change actual service behavior; the referee measures
security and utility together. The fleet is a visual metaphor for contested application
assets, with no real aircraft or hardware integration.

This is the intended design, not a claim that every item is built. `ARCHITECTURE.md`
describes the executable baseline and `SANDBOX_VALIDATION.md` records its test evidence.
This specification governs the HTTP scenario suite. The separate drone fleet simulation
(`FLEET.md`) implements multi-drone workspaces in SpacetimeDB reducers and is validated
on its own terms; it does not satisfy or replace the HTTP acceptance items below.
The acceptance criteria below govern the next implementation. They supersede the earlier
fleet branch's assumptions that a subscription alone completes the live transition or
that each runtime agent already has its own container.

## Backend progress after review

The runtime now supports cross-catalog attacker choices, bounded team-private tasks with
atomic claims and measured follow-up completion, one contested asset per namespace,
referee-gated reclaim with token revocation, three legitimate workflows, and a phased
burst workload. An ordered HTTP validator repeats breach-through-recovery assertions
across both defense modes. These are fixture-backed mechanics, not observed AI autonomy.
The review snapshot below records the earlier baseline. Larger fleets, live projection, actual inference and Docker checks remain pending.

## Review snapshot

Reviewed against these GitHub heads on 2026-10-24. Changes not pushed to these branches
are outside this review.

| Branch | Reviewed head | What it contributes |
| --- | --- | --- |
| main | `84483e3` | Initial SpacetimeDB schema and display prototype |
| mock-driver-live-board | `f7a216a` | Subscription plumbing with scripted event production |
| board-redesign | `443fc59` | Arcade visual design built on the subscription branch |
| feat/drone-swarm-control | `d26d490` | Fleet-themed board, scripted timeline, prototype asset reducers |
| feat/multi-agent-sandbox | `35d96c1` | Working HTTP experiment, fixtures, inference adapter, recorded report viewer |

**Review result: partial alignment; not yet an end-to-end live multi-agent demo.**

| Requirement | Current evidence | Remaining gap |
| --- | --- | --- |
| Real requests and consequences | HTTP artifact leakage, private token validation, policy writes and worker contention | Per-asset fleet state and additional application workflows |
| Multiple actors per side | Separate credentials, local memory and concurrent loops; 3 attackers and 2 defenders per side by default | Attackers have one scenario each; no explicit campaign handoffs or task ownership |
| Meaningful defense | Tenant checks, capacity reservation, overblocking and recovery alter request handling | Verified asset reclaim and richer legitimate-workload checks |
| Measured stress | Finite worker slots, real admission decisions, response status and measured latency | Load profiles, sustained-window comparisons, broader workload; host/container stress not demonstrated |
| Actual model decisions | Bitdeer adapter and mocked contract tests | Credentialed run, refusal/error reporting and recorded model evidence |
| Trustworthy fleet board | Fleet view exists separately; report viewer reads actual captured events | Authenticated event projection and replacement of timeline-derived outcomes and numbers |
| Containment | Loopback mode and restricted Compose definition | Docker execution, egress and resource-limit verification; agents share one process |

## Core mechanics

Each team contains attacker and defender specialists. Start with scout, deception, pressure,
policy and availability roles on each side, plus normal clients and a logically independent
referee. Roles have useful specialties, but the product should not reduce each attacker to
repeating one predetermined request forever. Scaling replicas alone is not coordination.

Agents need distinct identities, scoped observations, private working memory, budgets and
decisions influenced by recent results. Add a bounded team task board with target, scenario,
evidence references, task ownership and completion status. Only teammates may read/write it.
It carries observations and task requests, never referee authority or public credentials.
The existing shared summaries are a starting point, not this completed coordination layer.

At least one measured campaign must show a handoff: one actor identifies an exposed asset,
another chooses a permitted follow-up using that observation, and a defender changes policy
in response. Show a conflicting defender write being rejected and then reconsidered using
the new version. A fixed sequence is useful as a test fixture, but not proof of autonomous
coordination. Preserve actual model choices and failures in model runs.

## Scenario and workload requirements

The catalog is extensible. Every entry needs a service implementation, typed request schema,
observable effect, relevant defense, referee probe, legitimate-workload probe and resource
budget. Developers may add planted weaknesses and bounded request-field variations inside
the owned application. Agents must not choose arbitrary network destinations or execute
arbitrary programs. The platform remains useful without those capabilities.

The initial required families are tenant authorization failures, untrusted telemetry that
attempts to influence a defender, and contention for finite service capacity. Add choices
within these families: synthetic asset ID, reviewed telemetry variant and bounded workload
profile. Decisions must affect which requests happen and when, rather than only their labels.
Do not require real-CVE exploits or external infrastructure to satisfy this milestone.

Normal traffic must expand beyond `/status`: include at least one authenticated own-asset
read and one synthetic application update. Derive legitimate classification from credentials,
not a request-supplied boolean. Keep security-agent, legitimate-client and referee traffic
separate in all metrics so successful attacks cannot inflate availability.

Add steady, burst and recovery workload profiles, with explicit concurrency, request count
and duration limits. Record offered/completed requests, rejections, failures, legitimate
success rate and latency percentiles per phase. A rate-limited attack is not a service outage;
a rejected legitimate request is a utility failure. Do not count missing samples as successes.
The existing asynchronous worker model measures application capacity contention; CPU, memory
and kernel stress require separate actual measurements before those claims appear in the UI.

## Asset control and authority

Give each synthetic asset a stable ID, home team, current controller, match ID and round.
The practice service owns random private tokens and authoritative outcomes. A verified
capture changes control; merely attempting a request does not. Bind capture evidence to
the actor/team, asset and current round. Reject duplicate, wrong-asset, expired and cross-match
submissions. Do not place token values in public database tables, logs or board subscriptions.

A defender's rule write starts verification; it does not itself reclaim an asset. The
referee must check the original leak path is blocked and legitimate workflows still work
under the same policy version. Rotate/revoke the compromised token before reclaim so an
old captured credential cannot immediately seize the asset again. Only a verified referee
transition may commit reclaim. A 503/timeout is inconclusive for isolation, not proof of a
fix. Compare HTTP leak-path behavior; a flag-submission endpoint is not a substitute probe.

Keep cumulative verified captures separate from current asset control and legitimate
availability. Do not invent one composite score until its formula and SLA gate are explicit
and tested. A board may display these three measures side by side without declaring a winner.

The old arena is a release blocker for direct live integration: public `flag.value`, public
and predictable `drone.token`, caller-supplied team IDs, and unrestricted score/reclaim
reducers undermine the evidence chain. The intended integration uses a trusted publisher
with authenticated ingestion and sanitized public views. Ordinary agents and viewers must
not write scores, fabricate events, seize assets directly, or authorize reclaim. Keep one
authoritative service/referee path rather than two independently mutable game states.

## Live board contract

Keep the fleet concept, but show all active specialists rather than two large agent panels
implying a one-versus-one match. The primary view needs asset control, team rosters with
role/activity, legitimate success and latency, offered load, an event feed, and a selectable
evidence chain: request → observation → decision → applied rule → verification → control change.

Every projected event needs a schema version, match ID, round, unique event ID, timestamp,
kind, actor/team, target asset when applicable, and relevant scenario, policy version and
causation references. Use a per-kind allowlist for public fields. Do not forward raw request
bodies, tokens, actor credentials, provider keys or unrestricted model text. Store minimal
decision summaries and structured actions, not private model reasoning.

Replay and reconnect must rebuild the same state without double counting. Reject stale
match events, deduplicate event IDs, and reconcile a snapshot with subsequent ordered events.
An event named `patch` means applied, not verified; only verified outcomes change control.
An attempted capture, a successful leak and a verified capture are different events.

Use two independent mode labels: `Fixture decisions` or the actual provider/model, and
`Live`, `Recorded` or `Disconnected`. A live fixture run is possible; a recorded model run
is possible. Neither label may imply the other. On loss of connection, show the last event
time and freeze the last known state. No timer-driven fallback that continues the battle.
If resource telemetry is unavailable, omit it or show unavailable rather than fabricated
CPU, memory, container IDs, latency, location or tool-budget numbers.

## Acceptance gates

Unchecked items remain pending even if a visual approximation exists.

- [x] Actual HTTP requests, synthetic artifact capture, versioned policies, normal traffic
  and paired referee checks exist in the baseline; automated tests cover these mechanics.
- [x] Multiple concurrent security actors have individual credentials and local memory.
- [ ] A bounded campaign/task channel supports an evidenced cross-agent handoff and adapts
  to new request results; role specialties allow meaningful choices among permitted actions.
- [ ] At least three controlled scenario families exercise real behavior with validated
  variations, and at least three legitimate workflows survive the intended defenses.
- [ ] Steady/burst/recovery profiles produce actual saturation or admission rejections and
  measured recovery, with explicit budgets and complete per-phase denominators.
- [ ] Per-asset capture/reclaim tests cover private tokens, rotation, matching versions,
  preservation of utility, duplicate evidence, old rounds and fresh-match reset.
- [ ] An actual credentialed model run records provider/model, actions, latency, errors and
  outcomes. A refusal is visible as an inference failure, never a defensive win or fixture swap.
- [ ] Authenticated SpacetimeDB projection rejects viewer/agent writes, exposes no secrets,
  and produces identical board state from replay and live events, including reconnect.
- [ ] The fleet UI shows each active specialist, measured metrics, evidence and correct
  decision/transport labels, with no scripted outcome path enabled in live mode.
- [ ] Docker-host tests verify no external egress from runner/service, working inference
  through the narrow proxy, resource ceilings, stop behavior and clean reset.
- [ ] Several baseline/hardened runs report security and utility together with matching
  scenario/model/load settings, failures and variability; conclusions stay within the data.

## Build order and demo definition

1. Extend the working runtime with bounded choices and team coordination. Keep the fixture
   engine for repeatable mechanism tests and add credentialed inference evidence separately.
2. Add per-asset authority, reclaim verification and the richer normal/stress workloads.
3. Correct the public-data/authorization boundary, then add the authenticated event publisher.
   Reuse subscription and fleet-view work only after adapting it to the event contract above.
4. Drive the board from those events, verify reconnect/replay, and run the container/model
   acceptance gates on a host with Docker and configured provider credentials.

A credible judging demonstration shows multiple specialists operating simultaneously,
one consequential application failure, a defended recovery verified without losing normal
utility, and a comparison with the protection disabled. The model may fail to produce that
narrative live: keep an accurately labelled captured run available, and retain unsuccessful
runs. Explain sponsor integrations by the actual function they perform; do not add unrelated
services or claim integrations that have not run. Prize eligibility is not established here.
