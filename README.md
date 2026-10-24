# SudoKO

A cybersecurity simulation sandbox with independently operating attacker agents,
defender agents and drones. The repository contains two separate, both-supported
implementations plus labelled historical prototypes.

| Mode | Entry point | What it is |
| --- | --- | --- |
| **Fleet mode (current presentation)** | `npm run demo:fleet` → http://127.0.0.1:4174 | Drone-swarm simulation in SpacetimeDB (`arena-live/src/fleet.rs`, `web/fleet.html`). Three genuinely separate workspaces: attacker, defender, observer. See [docs/FLEET.md](docs/FLEET.md) and the [design audit](docs/DESIGN_AUDIT.md). |
| **HTTP security scenario suite** | `npm test`, `npm run sandbox:validate`, board via `npm run demo` → http://127.0.0.1:4173 | Measured HTTP attacks against the synthetic practice service in `sandbox/`. Its board (`web/live.html`) is a two-namespace operations view for that suite, not the swarm workspace. |
| Historical prototypes | none | `arena/` (initial SpacetimeDB module) and `web/index.html` (mock timeline). Not run by any script, not a security authority. `docs/STEER.md` and `docs/PRESENTATION_READY.md` are planning documents from before fleet mode. |

Fleet command checks run inside database reducers; the HTTP suite makes real HTTP
requests. Both use fixture decisions unless a Bitdeer model is configured for the HTTP
suite. Neither is a real drone or flight-controller test.

## Fleet mode

Requires Node 24, a Rust toolchain with `wasm32-unknown-unknown`, and SpacetimeDB 2.13.

```bash
npm ci
npm run spacetime:build
SPACETIME_BINARY=/path/to/spacetimedb-standalone npm run test:fleet   # 128 drones / 32 agents integration check
SPACETIME_BINARY=/path/to/spacetimedb-standalone npm run demo:fleet   # verify, then serve on :4174
npm run export:fleet                                                   # static recorded replay
```

The hosted preview is a measured recording, not a running backend. Role isolation is
enforced by identity-scoped database views, not by hiding replay data. Details, limits
and verification evidence: [docs/FLEET.md](docs/FLEET.md).

## HTTP security scenario suite

The runnable experiment is in `sandbox/`. Requests actually reach an HTTP service;
synthetic artifacts leak before isolation is applied; bounded expensive requests compete
with normal traffic for worker capacity. The [target specification](docs/TARGET_SPEC.md)
separates the intended multi-agent product from this working baseline.

### Run

Node 24 or later. Run `npm ci` for the board and development checks; the core
HTTP fixture runner uses Node built-ins.

```bash
npm test
npm run sandbox:validate
npm run sandbox:compare
# Counts are per team: 16 security agents + 12 clients + 2 probes.
npm run sandbox -- --compare --seconds 8 --attackers 6 --defenders 2 --clients 6
```

Defaults per team: three attackers (scout, deceiver, pressure), two defenders (policy,
availability), four normal clients. Each agent has a separate identity, memory and action
budget. The trusted runner schedules independent loops concurrently in one process.

The default decision engine is a **policy fixture, not an LLM**. It deliberately models a
defender that trusts a catalogued maintenance note. Both configurations use the same
policy; hardened mode adds a deterministic authorization check. Fixture results validate
mechanics, not the susceptibility of real models.

JSON results in `output/sandbox/` include measured outcomes, redacted events, decisions,
rule versions and referee checks. Open `web/report.html` and choose a result to inspect it.

### Bitdeer decisions

Set `BITDEER_API_KEY` and `BITDEER_MODEL` in your shell, then run:

```bash
npm run sandbox -- --engine bitdeer --seconds 45
```

The adapter uses the documented Bitdeer chat-completions endpoint. Models choose one
catalog action at a time. They cannot choose a URL, new payload, executable code or
privileged referee operation. Provider failures and malformed output are recorded as
errors; there is no silent fixture fallback. Credentials never appear in traces.

### Container isolation

Local mode binds to loopback and is for development. For container network/resource limits:

```bash
npm run sandbox:configure
docker compose --env-file .sandbox.env -f compose.sandbox.yaml up --build --abort-on-container-exit --exit-code-from runner
mkdir -p output
docker compose --env-file .sandbox.env -f compose.sandbox.yaml cp runner:/results ./output/sandbox
docker compose --env-file .sandbox.env -f compose.sandbox.yaml down
```

Service and runner use an internal network with no published ports. Containers are non-root,
read-only, capability-restricted and resource-limited. Results use a named volume, preserved
by `down`. The configuration script refuses to overwrite an existing credential file.

For a model run, export the Bitdeer credentials/model and use:

```bash
SUDOKO_ENGINE=bitdeer docker compose --env-file .sandbox.env -f compose.sandbox.yaml --profile llm up --build --abort-on-container-exit --exit-code-from runner
```

Only the inference proxy has an external network. Its upstream route, model, concurrency,
response-size check and token ceiling are fixed; it is not a general HTTP proxy.

### Scope and remaining integration

Implemented: actual HTTP interactions, private random artifacts, verified captures,
concurrent specialists, rule-write conflicts, bounded capacity pressure, background traffic,
Bitdeer adapter, independent probes and evidence inspection.

The target/weaknesses are synthetic. This is service-level evaluation, not untrusted-code
execution, a real-CVE harness, a kernel/container escape test, or real fleet control.
The Bitdeer adapter needs a credentialed run before claims about AI behavior. Compose needs
verification on a Docker host; local tests do not prove container network isolation.

`arena/` and `web/index.html` are the earlier SpacetimeDB/display prototype. This harness
**does not trust those reducers**. Redacted snapshots of this suite can be published to
the `arena-live` module (`npm run demo:spacetime`); the drone fleet simulation in the same
module is a separate implementation with its own validation (see Fleet mode above).

See [architecture](docs/ARCHITECTURE.md), [agent contracts](AGENTS.md),
[catalog](practice-app/catalog/README.md), [security](docs/SECURITY.md), and
[validation](docs/SANDBOX_VALIDATION.md).

### Backend validation and stress

`npm run sandbox:validate` proves a real tenant-boundary leak, verified capture, teammate
reproduction, patch effectiveness, untrusted-telemetry authorization, preserved normal
workflows, verified reclaim and stolen-token revocation. It repeats both modes three
times; any unexpected HTTP outcome fails the command. Evidence is redacted and saved to
`output/validation/evidence.json`. These ordered fixtures validate functionality, not AI.

For concurrent workload measurement:

```bash
npm run sandbox -- --compare --seconds 8 --attackers 6 --defenders 2 --clients 6 --load-profile burst
```

This runs 16 security actors, 12 normal clients and two probes, with steady, burst and
recovery phases. Attackers can select any catalog case and share team-private tasks.
Reports include measured handoffs, captures, reclaims and per-phase legitimate outcomes.
There is one contested asset per namespace in this suite; the multi-drone fleet is the
separate fleet mode above.

### HTTP suite board (`npm run demo`)

```bash
npm ci
npm run demo -- --autorun
# Open http://127.0.0.1:4173; Enter in the terminal starts another comparison.
```

This serves `web/live.html`, the HTTP suite's operations board. It shows both
namespaces with an attacker/defender perspective toggle; it is not the role-isolated
swarm workspace of fleet mode. It runs baseline then hardened tests with ten concurrent
security actors and normal application clients, showing real requests, asset control, service
success, team handoffs, and evidence-linked captures/recoveries. Fixture decisions
are explicitly labelled. Completed runs can be imported, exported, scrubbed and
played back. The board HTTP service is read-only and listens on loopback.

For actual model decisions, configure `BITDEER_API_KEY` and `BITDEER_MODEL`, then
run `npm run demo -- --engine bitdeer --autorun`. Missing credentials fail rather
than silently switching to fixtures. Live inference has not yet been verified.

For SpacetimeDB 2.13.0, build `arena-live` with a Rust toolchain and the
`wasm32-unknown-unknown` target using `npm run spacetime:build`. Start a local
SpacetimeDB instance on port 3000, run `npm run spacetime:prepare`, then
`npm run demo:spacetime -- --autorun`. Preparation creates a new database and
writes a local ignored `.demo.env` with publisher credentials. Only its owner can
publish snapshots; viewers subscribe to a redacted public table. Do not deploy
the older `arena/` module as the authoritative backend.

`npm run test:spacetime` checks a running local instance (default port 3011).
Alternatively set `SPACETIME_BINARY` to a standalone executable to let the test
start its own ephemeral server. The test requires the compiled Wasm, installed
Playwright Chromium, and verifies two browser subscriptions, refresh, unauthorized
writes, stale updates, match reset, redaction, replay and responsive layout.

To export the same UI with real recorded fixture evidence for static hosting:

```bash
npm run build:board
node scripts/export-demo.ts output/demo-site
```

The static preview does not execute new attacks or connect to a live backend.

## Full local checks

`npm run typecheck`, `npm test`, `npm run sandbox:validate`, `npm run spacetime:build`,
`npm run build:fleet`, and `SPACETIME_BINARY=… npm run test:fleet`. Regenerate
`web/module_bindings` with `npm run spacetime:bindings` whenever `arena-live` changes.
Docker isolation and live Bitdeer inference remain separate unverified gates.
