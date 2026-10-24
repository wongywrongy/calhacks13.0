# Architecture — Model B

One service, per-team guard rules, a referee that scores every tick. Everything
communicates through **SpacetimeDB**; no component talks to another directly except HTTP
requests into the guard.

```
 red attack ─┐                                  ┌─ blue attack
 red defend ─┤→  GUARD  →  SERVICE  →  events →  │   blue defend
             │   (rules)   (2 flag stores)       │
          referee → plant · probe · SLA · scores → SpacetimeDB → dashboard
                                                      ▲ defenders subscribe
          Bitdeer hosts all four agents
```

## Components

**Service** (`service/`) — one running instance. Two flag stores (`red`, `blue`). Every
request becomes an `event` row in SpacetimeDB. Exposes the flag endpoints and a set of
"normal" endpoints the referee uses for the SLA check. Holds no attack logic itself — its
weaknesses come from the catalog in `practice-app/`.

**Guard** (`guard/`) — middleware in front of the service. Two rule namespaces. A request to
a team's flag endpoints is evaluated **only** against that team's rules. A rule is
`{match, action}` (below). Default action is `allow` (service ships vulnerable at kickoff).

**Referee** (`referee/`) — the only authority. Each tick (default 20s):
1. **plant** a fresh flag value in each store (rotates the old one out).
2. **probe** each store the way an attacker would, to detect already-captured flags.
3. **SLA check** — send known-good requests; record pass/fail per team.
4. **score** — write the tick result to SpacetimeDB.

**Agents** (`agents/`) — four autonomous loops on Bitdeer models. Specs and hard boundaries
in `AGENTS.md`.

**Arena** (`arena/`) — the SpacetimeDB module. Tables + reducers below.

## SpacetimeDB schema

Keep it to these tables. Reducers are the only write path; clients call reducers, subscribe
to tables.

| Table         | Key fields                                                             | Who writes        |
|---------------|------------------------------------------------------------------------|-------------------|
| `match`       | id, round, status (`lobby`/`live`/`done`), started_at                  | referee           |
| `team`        | id (`red`/`blue`), flags_stolen, sla_pct, rules_version                | referee           |
| `flag`        | id, owner (`red`/`blue`), round, value, status (`held`/`stolen`), stolen_by, planted_at | referee |
| `rule`        | id, owner, match_json, action (`block`/`allow`/`sanitize`), version    | defenders (own namespace only) |
| `event`       | id, ts, kind (`request`/`capture`/`rule_change`/`sla`), actor, target, detail_json | service, referee |
| `score_tick`  | round, ts, red_flags, blue_flags, red_sla, blue_sla                    | referee           |

Reducers (minimum):
`start_match`, `plant_flags`, `record_capture`, `write_rule(team, …)`, `record_event`,
`record_sla`, `record_score`. `write_rule` must reject writes to the other team's namespace —
this scoping is a safety boundary, not a nicety.

## Guard rule model (small on purpose)

```
rule = {
  match:  { path?, method?, param?, contains? | shape? },   // all provided fields must match
  action: "block" | "allow" | "sanitize"
}
```

- A rule applies only to requests hitting its owner's flag endpoints.
- Start with a fixed vocabulary: match on `path`, `method`, `param` name, and a `shape`
  predicate (e.g. "param looks like a nested query"). No regex soup, no full WAF.
- The **rule library** (`practice-app/rules/`) ships prewritten rules, one per weakness class.
  Defenders pick from it first; synthesizing a novel rule is a stretch goal.

## Scoring

- **Attack point:** your attacker retrieves the *current* flag from the enemy's store before
  the referee rotates it → `record_capture`, the enemy's `flag.status = stolen`, your
  `flags_stolen += 1`.
- **SLA gate:** each tick the referee runs known-good traffic through your rules. If your
  rules block it, your `sla_pct` drops. **Below the SLA threshold (e.g. 80%) your team stops
  earning points** — this is what stops "defend by blocking everything."
- **Match score** = `flags_stolen`, with `sla_pct` as the tiebreak. Two levers, one number.

## The weakness catalog

`practice-app/catalog/` holds the planted weaknesses, one entry per class:
```
{ id: "WK-01", class: "...", endpoint: "...", flag_store: "red",
  probe: <fn>,        // how the referee/attacker checks if it's open
  patch_rule: "R-01"  // the library rule that closes it
}
```
Everything the agents do is **catalog-driven**. Nothing lives outside this fixed, documented
set — see `SECURITY.md`.