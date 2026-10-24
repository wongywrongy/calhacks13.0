# SudoKO arena (SpacetimeDB module)

The single source of truth: tables + reducers. The referee and the four agents are thin
clients that call these reducers; the dashboard subscribes to the tables. Build this and
get the deterministic test green **before** wiring up any agent.

## Setup

1. Install the SpacetimeDB CLI — https://spacetimedb.com/install
2. Start a local instance in its own terminal:
   ```
   spacetime start
   ```

## Build, publish, test

```
cd arena
spacetime publish sudoko-arena
bash test/deterministic.sh sudoko-arena
```

`deterministic.sh` runs a fixed scenario through the reducers and asserts the resulting
state:

```
start_match
plant_flags 1 RED_FLAG_1 BLUE_FLAG_1
submit_flag red  BLUE_FLAG_1    # red steals blue's flag  -> red +1
submit_flag blue WRONG_GUESS    # blue misses             -> no score
write_rule  blue {"path":"/flag"} block
record_sla  blue 90
record_score 1 1 0 100 90
```

Expected: red `flags_stolen = 1`, blue `flags_stolen = 0`, blue `sla_pct = 90`, blue's
round-1 flag `stolen`, red's `held`. Same inputs, same output, every run — that's the point.

## Reducers

| Reducer        | Args                                             | Who calls it |
|----------------|--------------------------------------------------|--------------|
| `start_match`  | —                                                | referee      |
| `plant_flags`  | round, red_value, blue_value                     | referee      |
| `submit_flag`  | by_team, value                                   | attackers    |
| `write_rule`   | team, match_json, action                         | defenders (own ns) |
| `record_event` | kind, actor, target, detail_json                 | service, referee |
| `record_sla`   | team, sla_pct                                    | referee      |
| `record_score` | round, red_flags, blue_flags, red_sla, blue_sla  | referee      |

## Notes

- The `spacetimedb` crate version in `Cargo.toml` must match your CLI. If `spacetime
  build` complains, align it with what `spacetime init --lang rust tmp` pins.
- `write_rule` rejects any team that isn't `red`/`blue` — the namespace boundary. Binding
  a rule write to the caller's identity is a later hardening (see `../SECURITY.md`).
- Swapping scripted calls for agent calls does not change the arena. The agents just call
  `submit_flag` / `write_rule` instead of the test script.
