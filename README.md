# SudoKO

A controlled security arena with concurrent attackers, defenders, normal clients and an
independent referee. The runnable experiment is in `sandbox/`. Requests actually reach
an HTTP service; synthetic artifacts leak before isolation is applied; bounded expensive
requests compete with normal traffic for worker capacity.

The [target specification](docs/TARGET_SPEC.md) separates the intended multi-agent product
from this working baseline. The [implementation handoff](docs/STEER.md) gives the next
builder a concrete scope. The current fleet-themed board and runtime are not yet one
integrated live demo.

## Run

Node 24 or later; no npm dependencies are required.

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

## Bitdeer decisions

Set `BITDEER_API_KEY` and `BITDEER_MODEL` in your shell, then run:

```bash
npm run sandbox -- --engine bitdeer --seconds 45
```

The adapter uses the documented Bitdeer chat-completions endpoint. Models choose one
catalog action at a time. They cannot choose a URL, new payload, executable code or
privileged referee operation. Provider failures and malformed output are recorded as
errors; there is no silent fixture fallback. Credentials never appear in traces.

## Container isolation

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

## Scope and remaining integration

Implemented: actual HTTP interactions, private random artifacts, verified captures,
concurrent specialists, rule-write conflicts, bounded capacity pressure, background traffic,
Bitdeer adapter, independent probes and evidence inspection.

The target/weaknesses are synthetic. This is service-level evaluation, not untrusted-code
execution, a real-CVE harness, a kernel/container escape test, or real fleet control.
The Bitdeer adapter needs a credentialed run before claims about AI behavior. Compose needs
verification on a Docker host; local tests do not prove container network isolation.

`arena/` and `web/index.html` are the earlier SpacetimeDB/display prototype. This harness
**does not trust those reducers**, and its results are not yet streamed to that board.
The next integration is publishing redacted measured events into SpacetimeDB and replacing
the board timeline, with private artifacts and referee permissions kept protected.

See [architecture](docs/ARCHITECTURE.md), [agent contracts](AGENTS.md),
[catalog](practice-app/catalog/README.md), [security](docs/SECURITY.md), and
[validation](docs/SANDBOX_VALIDATION.md).

## Backend validation and stress

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
There is one contested asset per namespace today. The larger fleet board is still pending.
