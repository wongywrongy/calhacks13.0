# Security boundaries

SudoKO is a self-contained educational evaluation of a fixed catalog of planted
weaknesses in its own synthetic practice service. It is not a general pentest tool.

## Required boundaries

- Only the loopback/Compose practice service is an attack target. Agent tools compile
  catalog IDs into fixed paths; no arbitrary host, URL, payload or redirect is accepted.
- Models receive no shell, filesystem or code-execution tool. Actors cannot create new
  techniques, real-CVE reproductions or network destinations.
- All flags, credentials and data are synthetic. Random flags and actor credentials are
  private. Public reports redact flags and omit all credentials.
- Defender writes are authorized from caller identity, restricted to its namespace,
  evidence-linked and checked against a rule version. Hardened mode denies the catalog
  maintenance-open action even if an agent requests it.
- Only the referee can start/stop/rotate a match. No score-write operation exists. Service
  outcomes and independent probes determine results. Agents cannot alter the referee.
- Per-actor rate/action limits, global request/event limits and a server-enforced deadline
  bound work. Stop prevents in-flight requests from releasing artifacts.

## Network and process model

Local development runs on loopback. It is not an OS security boundary. The trusted
scheduler hosts multiple independent agent loops in one process; these are not mutually
isolated processes and this system does not execute hostile agent code.

The provided Compose configuration isolates the service and runner on an internal Docker
network with no host-published ports. Containers have read-only filesystems, non-root
users, dropped capabilities and CPU/memory/process limits. They have no Docker socket or
host source mounts. Results use a dedicated volume. Docker isolation must be tested on
the deployment host; passing HTTP/tool tests alone does not establish it.

Optional model inference uses a separate authenticated proxy with one hardcoded Bitdeer
HTTPS endpoint, a configured model and bounded completion parameters. Only that proxy
joins an egress-capable network. The service and runner do not gain general egress.
The proxy code is trusted infrastructure, not an untrusted-code sandbox.

## Honest demonstrations

Fixture runs deliberately use a susceptible policy and must be labelled as such. Real
Bitdeer results require a credentialed run and may not follow the same narrative. Provider
errors never trigger a silent fixture fallback. A recorded run must be labelled recorded.
The earlier `web/index.html` mock timeline is not evidence from this runtime.

Use isolated local/container runs and a captured replay for venue demonstrations. Never
point the experiment at venue devices, third-party software, or real fleet equipment.
The old `arena/` module is not a security authority: public flags and unauthenticated
reducers need correction before it can receive anything beyond sanitized telemetry.
