# Sandbox validation

Validated with Node v24.19.0 in the implementation workspace. This records the first
runnable HTTP/multi-agent milestone, not a production security certification.

## Automated checks

`npm test`: 12 passed, 0 failed (approximately 3.5 seconds).

Coverage includes real HTTP artifact capture and duplicate/expired submission rejection;
private observations; identity/namespace checks; concurrent rule-write conflicts; actual
injection-to-rule effects; hardened rejection of weakening isolation; real worker-pool
exhaustion and capacity reservation; overblocking/recovery; fixed tool/target restrictions;
stop/restart isolation; version-correct referee checks; model response validation; explicit
provider errors; and a complete ten-security-agent run with redacted output.

Compose YAML parsed and its declared network topology checked. `git diff --check` passed.
The report viewer's JavaScript parsed successfully. Visual browser QA was attempted but
Chromium is not installed in this environment.

## Measured workload run

```bash
npm run sandbox -- --compare --seconds 8 --attackers 6 --defenders 2 --clients 6
```

Each mode ran 16 security agents, 12 legitimate clients, and two referee probes. Both used
the same deliberately susceptible **fixture policy**, with no model inference. Hardening
adds deterministic authorization against maintenance-open. Wall-clock scheduling varies;
this is one paired sample, not a statistical benchmark or a model-performance result.

| Observation | Baseline red | Baseline blue | Hardened red | Hardened blue |
| --- | ---: | ---: | ---: | ---: |
| Legitimate requests | 324 | 307 | 325 | 308 |
| Legitimate success | 98.77% | 98.05% | 94.46% | 98.70% |
| Secret-bearing attack responses | 25 | 30 | 0 | 4 |
| Verified captures | 2 | 2 | 0 | 1 |
| Legitimate worker-capacity failures | 4 | 5 | 17 | 3 |
| Isolation probe passes | 5 / 21 | 12 / 21 | 20 / 21 | 21 / 22 |

Baseline: 1,412 recorded events and 734 decisions. Hardened: 1,454 events and 731
decisions. Both runs had zero agent errors and zero infrastructure errors. Output was
checked for unredacted synthetic flag values. The hardened result reduces leakage in this
sample while revealing that availability still needs work under competing traffic. Initial
exposure is possible before a defender applies a rule; the experiment starts vulnerable.

Run IDs: baseline `1e4188aa-2637-49d2-95ee-98d12a26e4c1`; hardened
`b9a8a757-8adc-4813-a0fe-8f4b2ca3a708`. Full traces are generated locally in
`output/sandbox/` (ignored by Git); use `web/report.html` to inspect a new run.

## Not verified here

- Actual Bitdeer inference: no account credentials/model were configured. The adapter's
  contract and failure behavior were tested with local response stubs.
- Docker image execution, packet egress, and cgroup limits: Docker is unavailable. Verify
  these on the deployment host before describing the Compose environment as tested.
- Report viewer browser rendering: no Chromium executable available.
- SpacetimeDB/live-board integration: deliberately not connected to the new authority.
  The existing public-token/unauthenticated-reducer prototype remains outside this runtime.

Next milestone: run the Bitdeer mode in the isolated container setup, repeat several
trials, then publish sanitized measured events to SpacetimeDB and wire the live board.

## Backend v2 validation

The extended backend passes 15 tests. `npm run sandbox:validate` completes three baseline
and three hardened runs: 19 assertions per baseline and 18 per hardened run, 111 total.
Named HTTP outcomes repeat exactly; random credentials/tokens and latency are not fixed.
The suite verifies task privacy, atomic claims, required follow-up request evidence,
actual cross-tenant leakage, mitigation, three authorized workflows, referee-only recovery
and revocation of the compromised token. See `DEMO.md` for the exact demonstration.

The new runtime supports all three catalog choices for each attacker, team task handoffs,
namespace asset ownership, fresh post-capture verification, and phased workloads. Capacity
reservation now covers all authenticated legitimate-client workflows rather than status
alone. Model and container limitations listed above still apply.

Final v2 burst comparison (one fixture sample; 30 actors per mode):

| Mode | Team | Captures | Reclaims | Handoffs | Legitimate success |
| --- | --- | ---: | ---: | ---: | ---: |
| baseline | red | 2 | 2 | 24 | 96.91% |
| baseline | blue | 4 | 3 | 24 | 97.77% |
| hardened | red | 0 | 0 | 24 | 93.64% |
| hardened | blue | 1 | 1 | 24 | 97.31% |

Both modes completed with zero agent/infrastructure errors. All phases contained measured
requests. Exported output was checked for raw flag values. These are fixture results.
