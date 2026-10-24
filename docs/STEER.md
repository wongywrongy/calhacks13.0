# STEER.md — drone-swarm theme + control mechanic

Drop-in steering prompt for whoever (human or coding-agent) continues this build. It fixes
the demo theme and the one new mechanic so work stays coherent. Read `SECURITY.md` first —
nothing below relaxes a single boundary in it.

## The one-paragraph brief

SudoKO's practice service is **themed as a fleet controller**, and the target is a **swarm of
drones**. Each drone is one endpoint on the service carrying a *synthetic* command token. An
attacker that exfiltrates a drone's token (via a catalog weakness) **seizes** that drone;
a defender that hardens the controller **reclaims** it. Control is live, contested state — it
swings both ways. The board shows this as a left-right **control bar**: red share grows from
center-left, blue from center-right, neutral in the middle. This is a **skin over the existing
arena**, not a new game: one target, synthetic tokens, catalog-bounded, no egress. Do not let
the drone theme leak into any claim about real aircraft, real C2, or real-world hijacking —
it is a fleet-themed practice service and the pitch says exactly that.

## What's already landed

- `arena/` — `drone` table (`callsign`, `controlled_by`, `token`, `last_action`) + reducers
  `deploy_drones`, `seize(by_team, callsign, token)`, `reclaim(by_team, callsign)`. Control is
  tracked only on the drone row (current possession), **separate** from `team.flags_stolen`
  (cumulative captures). Two numbers, two stories.
- `arena/test/deterministic.sh` — a seize→wrong-token→reclaim→seize scenario that proves
  control swings both directions. Keep it green before any agent touches the arena.
- `web/index.html` — board reskinned to the swarm + control bar. It is **source-agnostic**:
  it runs off the hardcoded `TIMELINE` today, but `apply(e)` reads generic event fields. To go
  live, delete `TIMELINE` and feed `apply()` one object per SpacetimeDB `event`/`drone` row.

## Build next, in this order

1. **Service = fleet controller.** Endpoints per drone (`/drone/:callsign/...`) that genuinely
   leak the synthetic token when hit the documented catalog way (IDOR, injection, SSRF to an
   internal token URL). The leak must be real code that really breaks — not a label. Every
   request emits an `event` row.
2. **Catalog entry per weakness** in `practice-app/catalog/`, each mapping a drone endpoint to
   its `probe` and its library `patch_rule`. Agents pick from this set only.
3. **Attacker earns the seize.** `seize` must succeed only because the agent's `request()` got
   the token out of the controller — never a value handed in by a script. Capture → `seize` →
   drone flips → control bar moves, all as side effects.
4. **Defender's reclaim is provable.** `write_rule` into the guard; the referee re-probes; the
   identical seize now returns blocked and the SLA check confirms good traffic still passes.
   Then (and only then) call `reclaim`.
5. **Referee** owns `deploy_drones` each wave, re-probe, SLA, and the reclaim signal.

## Invariants — do not break

- The control bar only tells the truth if `controlled_by` is written by real seizes/reclaims.
  **Skin it, don't fake it.** No pre-authored outcomes once the backend is live.
- One target. Synthetic tokens. Catalog-bounded. Tiny tool surface (see `AGENTS.md`). No egress
  beyond Bitdeer inference. If a task seems to need crossing any of these, stop and rescope.
- Each agent is one contained entity whose only reach is the arena service and the arena DB —
  N independent attackers hammering the one controller. That containment is the pitch's spine;
  lead the demo with it, especially because "drone swarm" raises the stakes in a judge's head.
