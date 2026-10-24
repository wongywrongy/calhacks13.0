# AGENTS.md

The four autonomous agents in the arena. (For repo setup and conventions see `README.md`;
for safety boundaries see `SECURITY.md` — those boundaries are binding on the code here.)

All four share one runtime (`agents/common/`): a SpacetimeDB client (subscribe + call
reducers), an LLM client pointed at a **Bitdeer**-hosted model (OpenAI-compatible endpoint),
and a **tool bus** that exposes a *fixed, tiny* set of tools per role. An agent has no shell,
no filesystem, no network beyond the arena service and the arena DB. That tool surface **is**
the containment — do not widen it.

## Shared loop

```
subscribe to the tables this agent needs
loop:
  observe  → read the latest relevant rows from SpacetimeDB
  decide   → one LLM call: given state + the catalog, pick the next action
  act      → call exactly one allowed tool
  wait     → short backoff, then repeat
```

Keep each decision to a single tool call. Log every action as an `event`. Agents are
catalog-driven: they choose from the documented weakness/rule sets — they do **not** generate
novel exploit code.

## Tool surface (the whole list)

| Agent        | Tools (and nothing else)                                              |
|--------------|-----------------------------------------------------------------------|
| red_attack   | `request(path, method, params)` → service · `submit_flag(value)`      |
| blue_attack  | `request(path, method, params)` → service · `submit_flag(value)`      |
| red_defend   | `read_events(since)` · `list_rules()` · `write_rule(rule)` *(red ns only)* |
| blue_defend  | `read_events(since)` · `list_rules()` · `write_rule(rule)` *(blue ns only)* |

`request` can reach **only** the arena service. `write_rule` can write **only** the agent's
own namespace (enforced in the reducer, not just here).

## Contracts

### red_attack / blue_attack
- **Goal:** retrieve the *enemy's* current flag and submit it before the referee rotates it.
- **Input:** the enemy's flag endpoints (from the catalog) + recent responses.
- **Decide:** pick a weakness class from the catalog to probe next; form the request from the
  catalog entry. On a flag-shaped response, `submit_flag`.
- **Output:** `request` calls and `submit_flag`. A correct submit → `record_capture`.
- **Boundary:** target only the enemy's flag endpoints on the arena service.

### red_defend / blue_defend
- **Goal:** keep your own flags unstolen **without failing SLA**.
- **Input:** recent `event` rows for your endpoints + your current rules.
- **Decide:** match the attack signature to a weakness class; select the library rule that
  closes it (`patch_rule`). Avoid rules that would block known-good traffic.
- **Output:** `write_rule` into your namespace (bumps `rules_version`); the guard picks it up
  on the next request.
- **Boundary:** write only your namespace. A rule that tanks your SLA is a self-inflicted loss
  — the loop should back off an over-broad rule.

## Model config (Bitdeer)

- One model for all agents to start; set `BITDEER_BASE_URL`, `BITDEER_API_KEY`, `MODEL` in env.
- Deterministic-ish: low temperature, hard cap on tokens per decision, hard cap on tool calls
  per tick. Budget matters in a 36h run — don't let an agent spin.
- Timeouts + retries in `agents/common/`, not per agent.

## Definition of done (per agent)

1. Connects to the arena, subscribes, and acts within its tool surface only.
2. One clean action per decision, every action logged as an `event`.
3. Attackers capture a planted flag; defenders close a class and hold SLA.
4. Respects every boundary in `SECURITY.md`. If a change needs a new tool, stop and raise it —
   widening the tool surface is a security decision, not a feature.