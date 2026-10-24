# Mock match driver

A **mock** — no LLM, no randomness. Scripted stand-ins for the referee and the four agents
play one full match through the real `sudoko-arena` reducers, so `web/index.html` can show
it live from the arena tables. It is the same script as the board's built-in `TIMELINE`
(same order and values), and it talks only to the local SpacetimeDB instance.

## Run

```bash
spacetime start                                   # terminal 1 (listens on :3000)
cd arena && spacetime publish sudoko-arena        # terminal 2
cd ../driver && npm install && npm start          # plays one ~84s match
```

Open `web/index.html` before or during the run. It subscribes to the arena and shows the
match as it happens. If the arena can't be reached, it falls back to its built-in timeline.
Run `npm start` again for a rematch; `start_match` resets the board.

| env        | default                 | meaning                                     |
|------------|-------------------------|---------------------------------------------|
| `STDB_URI` | `http://127.0.0.1:3000` | local SpacetimeDB instance                  |
| `STDB_DB`  | `sudoko-arena`          | database name                               |
| `SPEED`    | `1`                     | time multiplier (`4` = 21s match); values never change |

The board takes the same settings from its query string:
`web/index.html?arena=http://127.0.0.1:3001&db=sudoko-arena`. Use `?mock` to force the
offline timeline.

## What each scripted step calls

| step       | mock of          | reducers                                                      |
|------------|------------------|---------------------------------------------------------------|
| `rotate`   | referee          | `record_score` (previous round) · `plant_flags`               |
| `steal`    | `*_attack`       | `submit_flag(team, enemy flag)` · `record_event capture`      |
| `blocked`  | `*_attack`       | `record_event request`                                        |
| `patch`    | `*_defend`       | `write_rule(team, …, block)` · `record_event rule_change`     |
| `patchbad` | `*_defend` + ref | `write_rule` (broad) · `record_event rule_change` · `record_sla −15` |
| `recover`  | referee          | `record_sla +12` · `record_event sla`                         |
| `end`      | referee          | `record_score` (final round)                                  |

Flag values are synthetic (`MOCK_RED_FLAG_1`, …) and distinct from `deterministic.sh`'s, so
the two can share a database. `event.detail_json` carries the step (`{step, round, team,
kls, msg}`) so the board can narrate it.

## Gaps in the fixed schema (flagged, not invented)

- **No `end_match` reducer.** Nothing sets `match.status = "done"`. The final-round
  `score_tick` serves as the end marker.
- **No reducer to edit or remove a rule.** "blue tightened the rule" is narrated, and only the
  SLA recovery is recorded.
- **Rows aren't scoped to a match.** The board uses the latest `game_match.started_at` to
  filter `flag`/`event`/`score_tick`. `rule` has no timestamp, so the patch count comes from
  `team.rules_version`.

## Bindings

`src/module_bindings/` is generated. If the module ever changes, regenerate with
`spacetime generate --lang typescript --out-dir src/module_bindings --module-path ../arena`.
Also update the schema mirror in `web/index.html` (`goLive`).
