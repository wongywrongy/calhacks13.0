# Drone fleet workspaces

This is the current swarm UI. `web/fleet.html` + `web/fleet.ts` replaces the two-namespace board as the presentation entry point. The existing HTTP scenario suite remains available; this is a separate synthetic drone command simulation, not an extension of its HTTP referee.

## Run and verify

Requires Node 24, Rust with wasm32-unknown-unknown, and SpacetimeDB 2.13.

```sh
npm ci
npm run spacetime:build
SPACETIME_BINARY=/path/to/spacetimedb-standalone npm run test:fleet
SPACETIME_BINARY=/path/to/spacetimedb-standalone npm run demo:fleet
```

The local demo verifies the module first, then starts on http://127.0.0.1:4174. Enter restarts a 60-second baseline. Ctrl+C tears down its temporary database. Alternatively use CHECK_SPACETIME_URI for an existing loopback server. The local operator can switch between role credentials; this is not a public authentication gateway. Never expose that server unchanged on the Internet.

`npm run export:fleet` exports measured recording frames for static hosting. Hosted replay is explicitly labeled RECORDED / FIXTURE. It cannot run or stress the backend and intentionally includes all three exported workspaces. Do not treat exported recordings as confidential role isolation.

## Independent operation and access

Each drone has its own scheduled reducer, cadence, position, battery, controller, policy version, and counters. Each fixture agent has its own schedule, target, step, and observation/action state. These are independent database entities, not independent LLMs or OS processes. SpacetimeDB serializes reducer transactions; scheduling is best effort. Cadences and fixture decisions are fixed, but wall-clock ordering under load is not bit-for-bit deterministic.

Private entity, schedule, principal, discovery, and evidence tables are projected through identity-scoped views. Unassigned identities receive no fleet rows. Only the publisher can grant roles, start, or stop a run; scheduled callbacks reject client invocation.

- Attacker: own team agents, discovered drones, discovery and command outcomes. Discovered drone telemetry remains observable. Private policy, battery, and counters are redacted.
- Defender: managed fleet, own team agents, incoming command violations and responses. No attacker discovery records or attacker IDs.
- Observer: complete fleet evaluation state.

An unauthorized fixture command exploits a planted missing authorization check and changes a drone's controller, which changes how it flies (see Motion). A defender applies a per-drone command policy, exercises the same command handler with unauthorized and authorized probes, and restores control only for 403/200 outcomes under one policy version. Verification is atomic within a reducer. It is not an independent HTTP probe or real flight-controller exploit. Hardened mode blocks takeover from the beginning.

## Verification evidence

`test:fleet` deploys the compiled WASM to a new local database and checks:

- The configured default fleet / 16 agents in a measured replay, breach and recovery evidence.
- The same configured count / 32 agents in a hardened run; every drone ticks and no unauthorized command succeeds.
- Role privacy, private table denial, grant escalation denial, independent cadences, stop behavior, and clean reset.
- Actual SDK WebSocket subscriptions for attacker, defender, observer, and unassigned identities.

These are bounded integration checks, not a latency/throughput benchmark or evidence of thousand-agent scale. Supported input caps are 256 drones and 32 agents per team. Fixture runs stop scheduling after 60 seconds. Authenticated chat mode activates on the first attacker objective and keeps the shared sandbox running without a global timer; individual model operations remain bounded. See `FLEET_CHAT_API.md`.

## Motion

`arena-live/src/formation.rs` holds the motion model as pure functions with unit tests (`cargo test formation`); `drone_tick` applies it on each drone's own cadence.

- **Healthy** (home control): every drone targets the same formation pose on the shared match clock: its stable centered slot plus one common figure-eight offset (20 s period) and shared altitude wave. The whole swarm moves in lockstep and keeps its spacing. Within 0.6 m of that pose a drone locks onto it exactly.
- **Hijacked** (attacker control): the drone stops following the match clock. From the pose it held at takeover it drifts along its own heading (1.2 m/s, up to 18 m), wobbles at its own 0.35-0.6 Hz with amplitude growing from 0.6 to 3.5 m, and sinks toward 3 m. Every effect grows with time held. The takeover time is kept in the private `fleet_hold` table, which is not exposed through any view.
- **Recovered**: the hold is cleared and the drone glides back (35% of the gap per tick, no teleport) until it locks into step again.
- **Detection latency**: fixture defenders act only on a breach held at least 4 s (`DETECT_AFTER_US`), oldest first, so a hijack visibly pulls a drone out of formation before recovery. Without it the fixture recovered in tens of milliseconds and drift was invisible. This is a fixture decision, not a measured detection time; recovery still requires the 403/200 verification.

`test:fleet` asserts that some held drone in the measured replay is more than 2 m off the healthy formation, and that every drone in the hardened run (no takeovers) is within 1.5 m of it.

The client measures each drone's deviation from the formation using only the drones its role can see: the horizontal distance from its slot plus the median slot offset of visible healthy drones (the same definition as `check-fleet.ts`); the expected altitude, used only for the ghost marker, is the median altitude of healthy drones in the same column. Drones more than 2 m off (tick timing alone spreads healthy drones by up to ~1 m) count as **off formation** in the status row, get an `off-slot` value on asset cards, and are drawn with a ghost ring at their expected slot and a dashed tether to where they actually are. Displayed positions ease toward each new database position over ~0.15 s; jumps over 30 m (scrubbing) snap. Mean time to recover runs from the first acceptance after a drone's previous recovery, not from repeat commands on a drone already held.

## Layout and chat

All three role views share one edge-to-edge shell (`design/role-views/*.dc.html` is the visual spec). On screens at least 900 px wide and 600 px tall the whole workspace fits one viewport: the page never scrolls; the agent rails, chat transcript and log scroll inside their own panels. Narrower or shorter screens fall back to a stacked, scrolling page.

1. **Header** (48 px): `SUDOKO / Attack|Defense|Observer` breadcrumb with a context line, live/recorded dot, match clock, recording play/scrub, and the role switcher as flush tabs with a 2 px team-colour underline.
2. **Status row**: hairline-split label-over-value cells, severity badge first. Defender: compromised n/total with bar and sparkline, last breach, mean time to recover, block rate, unrecovered drone chips. Attacker: seized n of discovered, last takeover, lost back, blocked, held drone chips. Observer: control share blue vs red, first takeover, mean time to recover, block rate, takeovers recovered. Every value is computed from the evidence rows and drone rows that role's subscription returns; the attacker never sees recovery rows, so its sparkline is cumulative takeovers and "lost back" is derived from the visible controller field.
3. **Main row**: agents rail | Three.js map over the log | right column. The map header holds the legend, the `sim coords · tick` caption (truncated first when space is short), Fit, and the camera toggle. Observer shows red rail | map | blue rail with a selected-drone strip above the map. Compromised drones pulse; a drone whose most recent blocked violation is within the last 3 s of evidence time shows an amber ripple. `prefers-reduced-motion` disables both animations.
4. **Log**: docked under the map, about 30% of the column (Threats & responses / Operation log / Evidence). The defender log prints "unknown origin" where the view redacts the actor. Clicking a row pins that event and filters the log to its drone; "show all" clears it.
5. **Footer**: one line; the full fixture disclaimer opens from it.

The attacker and defender right columns are a chat with their agent (Crimson / Sentinel). Clicking a drone on the map, a status chip, or a log row posts "Pull up DR-xxx" and inserts an asset card scoped to the role (the attacker card shows battery and policy as redacted). Agent lines come only from real evidence rows: when a new row lands for a pulled-up drone, or for any row with an own-team actor, a one-line summary is posted.

**Queued-command limitation.** No operator-command reducers exist. Action chips (Policy / Isolate / Verify / Recover all; Command / Discover / Hold / Skip hardened) and typed messages are appended to the transcript marked "queued" and nothing acts on them; the UI never invents success text. Adding such reducers must keep the existing identity and role checks in `arena-live/src/fleet.rs`.

## Rendering and assets

Three.js renders database positions with a reusable quadrotor from Higgsfield 3D Jutsu project `0680b9e1-329c-40ad-aff1-edc52fd7d7a2`, inspected revision 1. `web/assets/swarm-blockout.glb` is a 32 KB procedural blockout, not a photorealistic reconstruction. Drone geometry is shared across clones. Motion comes from measured state, without a background generative video or per-frame generation calls.

Each drone is drawn at its database position with a stem to the ground, a state-tinted ground shadow, and (defender/observer) a dashed ground ring when isolated. Drones can come within about 4 m of each other between formation columns, so every per-drone marker stays inside a 2 m radius. Hovering shows a `DR-xxx · state` label; the selected drone keeps one.

The default is **200 drones in a 20 × 10 formation**, driven by `shared/fleet.json`.
Columns are 6 m apart and rows are 114/9 m apart: both axes span 114 m, centered on
(0, 0). Slot identity depends only on the drone ID and shared configuration, never arrival
order, discovery order, reconnect or replay time. Recovery returns to that same slot.
`arena-live/build.rs` embeds the JSON as Rust constants; `shared/fleet.ts` supplies the
same geometry to the client and checks. The separate maximum is an input cap, not a default.

The viewport restores the bird-like crescent, deterministic scatter, travelling waves and
banking in `web/flock.ts`, adapted to the shared 20-column geometry. These are display
effects: metrics, control changes and recovery still use authoritative reducer state.
Drone bodies, ghost slots, tethers, camera targeting and the Canvas fallback use the same
transform. Reduced-motion preferences retain the static flock shape without animated waves. Bodies and shadows use instanced
meshes, and stems, trails and neighbour links use shared line buffers.

The operating pad and survey grid are square and centered at the scene origin, sized from
role-visible bounds with a margin. Their size never uses the hidden session total. Terrain,
fog, dusk backdrop and mast remain scenery. Camera Fit uses the visible fleet and square
pad with the actual frustum and aspect ratio; Top-down exposes the even layout. Drag
orbits, right-drag pans, and scroll zooms. User navigation survives ordinary state updates.

A projected Canvas map is available when WebGL cannot initialize. Selection works through the map, status chips or log rows; a press that turns into a drag does not select. Playback pauses and scrubs. Inspecting an evidence row keeps that event pinned in the asset panel across live updates, and live redraws are coalesced to one per animation frame.

Browser checks (2026-10-24, Chromium 1243 via Playwright against `demo:fleet` and the static export): per role, no data from outside its scope (no defense internals, battery or policy for the attacker; no discovery rows or attacker IDs for the defender), chat pull-up and queued commands, status values matching the evidence rows, evidence-row pinning, recorded play/scrub, backend disconnect freezes the last state, WebGL disabled falls back to the Canvas map, and the 390 px viewport has no horizontal overflow. The camera auto-frames the visible fleet, so a 48-drone run and a 256-drone run both fill the map.

## Authenticated model operations

The existing UI also connects to the backend's model-driven chat mode. Its sessions are
derived from granted SpacetimeDB viewer identities. Coordinator plans, independent
specialist decisions and action receipts are durable; the existing simulation reducers
commit takeover, policy and verified recovery. Scheduled security fixtures are disabled
while movement continues. The 4-second fixture detection delay does not govern model
defenders. See [FLEET_CHAT_API.md](FLEET_CHAT_API.md) and
[FLEET_CHAT_VALIDATION.md](FLEET_CHAT_VALIDATION.md).

## Persistent battle attempts

Model-driven fleet operations now use scheduled, fallible battle attempts, cumulative local
contamination, readiness and explicit mission availability. See [FLEET_ATTEMPTS.md](FLEET_ATTEMPTS.md)
for the current backend mechanics, seeded validation and UI integration contract. The older
fixture and historical UI descriptions above are not proof of model behavior or new UI integration.

## Dusk basin environment (2026-10-25)

The Higgsfield WebP in [LANDSCAPE_HANDOFF.md](LANDSCAPE_HANDOFF.md) is a stationary distant
plane with its original aspect ratio, sRGB sampling and feathered sides/top/bottom. Its
photographic ground is masked below the real terrain. It fades out for side/rear views,
steep top-down views, extreme zoom-out and approaches to the plane. It never follows the
camera, wraps onto a sphere, or supplies simulation positions. Procedural terrain, sky
and fog remain in every direction and on image failure; the Canvas fallback keeps a dark,
readable projected map without loading the image.

The foreground basin is genuinely 3D, with a flat operating area, smoother lower ridges,
subtle nearby contours and two neutral distant outposts. Scenery is illustrative and is
excluded from drone selection. Shared dusk lighting/fog preserve team marker colors.
Fog follows camera distance so zooming out does not erase the fleet; resizing updates the
frustum while preserving an operator-adjusted camera. Fit still explicitly reframes it.

The image loads once per WebGL scene. Role switches, reconnects and resets reuse its mesh,
texture, the procedural sky and outpost geometry. Final page teardown cancels the render
loop and disposes the new resources; the back/forward cache retains them. Terrain density
is 128 × 128 cells rather than 220 × 220 (32,768 instead of 96,800 triangles), with two
triangles for the scenic card and one shared instanced geometry for the outposts.

The local backend and fixture demo explicitly serve
`/assets/environments/sudoko-dusk-basin.webp` as `image/webp`. Both static export and Vercel
build copy it to the same nested path; `.vercelignore` includes the source directory/file.
No generation URL is requested at runtime. Maincloud configuration is still required for
the production build; it is never generated or replaced by dummy credentials.

Checks (set `SPACETIME_BINARY` and, when necessary, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`):

```sh
npm run spacetime:build
npm run test:fleet
node scripts/check-landscape.ts --baseline
node scripts/check-landscape.ts
npm run export:fleet
FLEET_MAINCLOUD_CONFIG=/path/to/existing/fleet-config.json npm run build:vercel
node scripts/check-landscape-live.ts
npm run typecheck
npm test
```

The baseline check bundles the renderer at asset-handoff commit `7d60de5` and freezes a
single measured 48-drone replay. The updated check uses that same fixture, viewport, DPR
and baseline camera for its responsiveness comparison. Local screenshot/report artifacts
are in `output/landscape/`; full-page review captures are in `.impeccable/review/`.
The completed run inspected all roles, selection, default/side/rear/top-down and near/far
views, mobile/desktop resizing, zero drones, blocked image loading and disabled WebGL.
Five display resets retained resource identities and counts; three actual backend resets
with the former fleet default plus a database restart retained the image without another request.
Both serving paths returned identical bytes and MIME type, and export/production outputs
matched the original asset. The fixture demo can use `FLEET_PORT=0` for an isolated
port; its default remains 4174.

In the bounded 2.5-second Chromium software-WebGL comparison, the original renderer ran at
about 25 fps and updated samples in the low-to-mid 30s. This is an indicative local sample,
not a hardware GPU/mobile benchmark or a production-load result. At extreme zoom-out the
fleet naturally becomes small; Fit or scroll restores inspection scale. The flat image is
intentionally absent outside its suitable viewing range, while the 3D environment remains.
No simulation, chat, scoring, authorization or agent-lifecycle behavior was changed.
