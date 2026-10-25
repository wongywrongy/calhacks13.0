# SudoKO production deployment

Project: `calhacks13.0-mjcc` (`prj_CZVafdKgSFtinyZaYRaEO6jZnwus`) in `wongywrongys-projects`, authenticated as `wongywrongy`. All three existing project domains are verified: https://sudo-ko.us, https://www.sudo-ko.us and https://calhacks130-mjcc.vercel.app. No DNS or domain ownership changes were needed. The application is consolidated onto `main`; Vercel is linked to this existing project, not a new project.

## Build and runtime

- App root: repository root. Existing entry points: `web/fleet.html`, `web/fleet.ts`.
- Framework: Other/static HTML and TypeScript; esbuild and Three.js are retained.
- Node: project uses 24.x. Install: `npm ci`. Build: `npm run build:vercel`.
- Output: `output/vercel-static`, containing only `index.html`, `fleet.js` and `assets/swarm-blockout.glb`.
- `vercel.json` forwards `/fleet-config`, `/api/*`, `/signin` and `/healthz` to the existing backend's public HTTPS origin. Configuration/conversation responses are not cached. The fleet-config rewrite selects the internet subscription address.
- The trusted Node backend, shared inference pool, scheduler lease, asynchronous workers and SpacetimeDB remain on the existing Neo host. Moving that process into request-scoped Vercel Functions would change its lifecycle, so no such migration was made.
- No application secrets are required on Vercel. `.vercelignore` limits source uploads, and `.env*`, `.vercel/` and `output/` are excluded from Git. The generated client bundle was checked for server credential references.

Server-only configuration remains on the backend: `BITDEER_API_KEY`, independent `BITDEER_COORDINATOR_MODEL`/`BITDEER_SPECIALIST_MODEL`, `SPACETIME_URI`, `SPACETIME_DATABASE`, `SPACETIME_TOKEN`, `SUDOKO_OPERATOR_TOKEN`, the existing role credentials and granted demo viewer credentials. Optional `SUDOKO_SESSION_SECRET` otherwise derives from the operator secret. Provider and privileged database credentials never reach Vercel's static assets. Browsers receive only their scoped read-only subscription credential through the existing authenticated configuration endpoint.

`SUDOKO_ALLOWED_ORIGINS` lists the three exact production origins; no wildcard Vercel origin is accepted. Existing `SUDOKO_PUBLIC_ORIGIN` and `FLEET_PUBLIC_URI` preserve the private/local entry point. `FLEET_INTERNET_URI` selects the public subscription origin only for the Vercel configuration rewrite. The existing login-free hackathon role switching remains enabled intentionally; visitors may operate either scoped role.

## Narrow public ingress

The existing Tailscale installation publishes only these paths on HTTPS 443:

- `/healthz`, `/fleet-config`, `/api/chat/`, `/api/session`, `/signin` → existing Node backend.
- `/v1/identity/websocket-token` → authenticated short-lived subscription token exchange.
- `/v1/database/sudoko-chat-live-20261024/subscribe` → this database's subscription transport.

The backend root, privileged `/v1/fleet/*` routes, raw database SQL and unrelated database subscriptions return 404 at this public ingress. Existing tailnet routes on other ports were preserved. The initial proposal to publish the entire backend was rejected by automatic approval review; the narrower route configuration was approved and verified instead.

Ordinary public-DNS clients resolve `neo.taile1abc7.ts.net` to the Funnel relay. On the backend host, tailnet DNS resolves it to a private IP where an unrelated service already owns port 443. The original production browser verification used the public DNS relay address with normal TLS hostname verification. If the direct WebSocket fails, the UI now reads authoritative snapshots every second through same-origin `/api/chat/state`. That endpoint queries only the four existing identity-scoped views using the authenticated viewer credential, never the owner token. This avoids private DNS/TLS and browser local-network permission failures without changing the database's permissions or another service's listener. If HTTPS also fails, the last frame stays frozen and the badge shows Disconnected; successful polling restores live updates.

## Verification

Initial production deployment: `dpl_HJV3cPUdkXG3Me3UAkhQPd2kj19S`, built locally with the project's production settings, uploaded as a prebuilt staged production build, then promoted to the existing domains. All three domains returned HTTP 200 for the app and backend health.

Actual Chromium verification on https://sudo-ko.us used real Bitdeer calls and preserved the existing fleet epoch/history:

- General conversation answered without creating agents.
- The initial live attempts exposed malformed coordinator assignments and a mistaken clarification that treated no discovered telemetry as no catalog targets. The coordinator now receives explicit catalog target IDs and the fact that discovery is available before observation. Node/reducer validation is unchanged; invalid output remains visible and never deploys.
- Two prompted attackers, Swarm Probe A and Swarm Probe B, discovered two drones and committed unauthorized control changes (evidence 13/14).
- Two prompted defenders, Sentinel and Warden, operated in the same epoch and verified recovery with paired unauthorized-denial/legitimate-acceptance evidence (recovery 19/22).
- 307 WebSocket frames were received; names, role, conversation and operation state persisted through refresh. No browser page or network errors were recorded in the passing run.
- Attack acknowledgment: 366ms; first executed action: 2,104ms; completion: 4,196ms. Defense acknowledgment: 512ms; first action: 2,913ms; completion: 4,751ms. These are one bounded run, not an uptime or latency guarantee.

Evidence and screenshots are saved privately in `output/vercel-deployment/`: `browser-evidence.json`, `production-conversation.png`, `production-attacker.png`, `production-defender.png`. Tests also cover exact-origin acceptance and rejection of lookalike/unrelated origins. Live drone updates use SpacetimeDB WebSockets; chat progress retains the existing lightweight polling, not token-by-token text streaming.

## Operations

The Vercel frontend is independent of the backend process but still depends on the existing Neo host, SpacetimeDB and Funnel being online. The backend runs from the main checkout under the enabled user service `sudoko-chat-backend.service`; its secrets remain outside Git. Restart only that service for backend updates. Do not reset Tailscale Serve/Funnel globally or reset the fleet to deploy a frontend change. Demo users can explicitly reset the shared fleet through the confirmed **Sandbox** button; pending work is cancelled before zero-agent initialization and history is retained.

Deploy from the main checkout after verifying the linked project:

```sh
vercel project inspect --non-interactive
vercel pull --yes --environment=production
vercel build --prod
vercel deploy --prebuilt --prod --skip-domain
vercel promote <the-ready-production-deployment>
```

No production isolation or sustained-load claim is made. Provider timeouts and invalid plans remain possible and are surfaced to the operator.
