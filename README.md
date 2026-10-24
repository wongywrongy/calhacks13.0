# SudoKO — backend

An autonomous red-vs-blue security arena. Two agent teams fight over **one shared practice
service**: each team attacks the other team's flags and defends its own by writing guard
rules, while a referee plants flags, probes them, checks service health, and scores — every
tick. This repo is the **backend**: service, guard, referee, agents, and the SpacetimeDB
arena. Frontend is a separate workstream and out of scope here.

> This is a self-contained **educational evaluation harness**. It runs only against its own
> purpose-built practice service, in an isolated sandbox, with synthetic data. It is not a
> tool for use against real systems. See `SECURITY.md` — read it before writing any code.

## Scope

**In scope (backend):**
- One practice **service** with two flag stores and an event stream.
- A **guard** layer with two rule namespaces (one writable per team).
- A **referee** tick loop: plant → probe → SLA check → score.
- Four **agents** (red/blue × attack/defend) running on Bitdeer-hosted models.
- **SpacetimeDB** as the single live-state hub everything subscribes to.

**Out of scope (for now):** the dashboard UI, Cartesia commentary, auth/accounts, any target
other than the practice service, any attack technique outside the documented catalog.

## Stack

| Piece            | Choice                                        |
|------------------|-----------------------------------------------|
| Arena (state)    | SpacetimeDB module (Rust)                     |
| Service + guard  | TypeScript (Node, Fastify)                    |
| Referee          | TypeScript (SpacetimeDB TS client)            |
| Agents           | TypeScript + LLM via Bitdeer (OpenAI-compat)  |
| Orchestration    | Docker Compose, one internal network, no egress |

One language for all clients (TS); Rust only for the arena module. Don't add a third.

## Repo layout

```
sudoko/
├── arena/          # SpacetimeDB module — tables + reducers (Rust)
├── service/        # practice service: 2 flag stores, emits events
├── guard/          # filter middleware: red_rules / blue_rules namespaces
├── referee/        # tick loop: plant · probe · SLA · score
├── agents/
│   ├── common/     # shared runtime: STDB client, LLM client, tool bus
│   ├── red_attack/  red_defend/  blue_attack/  blue_defend/
├── practice-app/   # the weakness catalog (fixtures) + the rule library
└── docs/           # ARCHITECTURE.md · AGENTS.md · SECURITY.md
```

## Quickstart

```bash
docker compose up        # arena, service+guard, referee, 4 agents
# dashboard connects to the arena separately (other workstream)
```

## Build order (first, unblock everyone)

1. **arena + referee** — schema live; referee plants one flag, probes it, writes one score. (A)
2. **service + guard** — one planted weakness, one guard rule that closes it. (B)
3. **agents/common + one attacker + one defender** — close the loop end to end. (C)
4. Add weakness classes (3–4 total), the SLA check, and the remaining two agents.
5. Frontend starts only after the loop scores a full round.

Integration gate: referee scores a flag that a hardcoded rule then blocks. Everything after
that is additive.

See `ARCHITECTURE.md` for the schema and contracts, `AGENTS.md` for the agent specs, and
`SECURITY.md` for the rules of engagement.