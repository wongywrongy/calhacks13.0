# TRANSITION.md — from demo board to live arena

The board (`web/index.html`) is finished as a **demo**: a grounded drone-ops console
driven by a hardcoded `TIMELINE`. This is the prompt to make it **live** — every pixel on
screen a side effect of a real seize/reclaim against the practice service, nothing
pre-authored. Read `SECURITY.md` first; nothing here relaxes a boundary in it.

## The transition, in one line

Delete `TIMELINE`, subscribe to the arena's `event` / `drone` / `team` tables, and feed each
row into the board's existing `apply(e)` — the view is already source-agnostic, so the UI does
not change, only its data source does.

## Contract the board already expects

`apply(e)` reads these generic fields (see the header comment in `web/index.html`):

```
kind:   deploy | wave | seize | reclaim | patch | patchbad | recover | blocked | end
fields: t (clock), round, team ('red'|'blue'), cs (callsign | "DR-01..DR-08" | array),
        kls (catalog id), n (deploy count)
```

Map arena rows → these events:
- `drone` row inserted (controller deploys a swarm) → `{kind:'deploy', n}`
- `drone.controlled_by` flips to an attacker via `seize` → `{kind:'seize', team, cs, kls}`
- `drone.controlled_by` flips to a defender via `reclaim` → `{kind:'reclaim', team, cs}`
- `event.kind='rule_change'` (defender wrote a guard rule) → `{kind:'patch'|'patchbad', team, kls}`
- `event.kind='request'` with result 403 on a flag endpoint → `{kind:'blocked', team, cs, kls}`
- `team.sla_pct` recovers after a tightened rule → `{kind:'recover', team}`

Everything else on screen (control counts, SLA bars, tool-call budget, the event-log table,
the control bar) is derived from state in `render()` — no extra wiring needed.

## Build order (each step makes more of the feed real)

1. **Wire the subscription.** Add a SpacetimeDB TS client in the page (or a thin WS relay),
   subscribe to `event`, `drone`, `team`, translate rows → `apply()` objects, call `render()`.
   Keep `TIMELINE` behind a `?demo=1` flag so the mock still runs offline for judging.
2. **Service = fleet controller.** Endpoints per drone (`/drone/:callsign/token`) that genuinely
   leak the synthetic token when hit the documented catalog way (IDOR / injection / SSRF to an
   internal token URL). Real code that really breaks — not a label. Every request emits an
   `event` row with actor, target, result code, latency.
3. **Catalog entry per weakness** in `practice-app/catalog/` (`WK-01..`), each mapping a drone
   endpoint to its `probe` and its library `patch_rule`. Agents pick from this set only.
4. **Attacker earns the seize.** `seize(team, callsign, token)` succeeds only because the agent's
   `request()` got the token out of the controller — never a value handed in by a script.
5. **Defender's reclaim is provable.** `write_rule` into the guard → referee re-probes → the
   identical seize now returns 403 and the SLA check confirms good traffic still passes → then
   `reclaim`. The amber block animation on the board is now backed by a real 403.
6. **Referee** owns `deploy_drones` each wave, re-probe, the SLA check, and the reclaim signal.

## Field-honesty rules (keep the board truthful)

- `container id`, `model`, tool-call budget: wire to the real agent runtime. Until then they are
  representative placeholders — do not present them as live telemetry in the pitch.
- The map's sector grid is deliberately abstract (no GPS, no satellite). Do not re-add fabricated
  geography; the arena has no real location.
- Latency, result codes, SLA: must come from real `event` rows once the service exists. No
  invented numbers once step 2 lands.

## Invariants — do not break

- One target. Synthetic tokens. Catalog-bounded. Tiny tool surface (`AGENTS.md`). No egress
  beyond Bitdeer inference. Each agent is one contained entity reaching only the arena service
  and the arena DB — that containment is the pitch's spine (`SANDBOX · NO EGRESS` on the board).
- Skin it, don't fake it: once live, the control bar and feed must reflect real seizes/reclaims.
  No pre-authored outcomes.
