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

An unauthorized fixture command exploits a planted missing authorization check and changes a drone's controller and simulated altitude. A defender applies a per-drone command policy, exercises the same command handler with unauthorized and authorized probes, and restores control only for 403/200 outcomes under one policy version. Verification is atomic within a reducer. It is not an independent HTTP probe or real flight-controller exploit. Hardened mode blocks takeover from the beginning.

## Verification evidence

`test:fleet` deploys the compiled WASM to a new local database and checks:

- 48 drones / 16 agents in a measured replay, breach and recovery evidence.
- 128 drones / 32 agents in a hardened run; every drone ticks and no unauthorized command succeeds.
- Role privacy, private table denial, grant escalation denial, independent cadences, stop behavior, and clean reset.
- Actual SDK WebSocket subscriptions for attacker, defender, observer, and unassigned identities.

These are bounded integration checks, not a latency/throughput benchmark or evidence of thousand-agent scale. Supported input caps are 256 drones and 32 agents per team. Runs stop scheduling after 60 seconds.

## Layout and chat

All three role views share one edge-to-edge shell (`design/role-views/*.dc.html` is the visual spec):

1. **Header** (48 px): `SUDOKO / Attack|Defense|Observer` breadcrumb with a context line, live/recorded dot, match clock, recording play/scrub, and the role switcher as flush tabs with a 2 px team-colour underline.
2. **Status row**: hairline-split label-over-value cells, severity badge first. Defender: compromised n/total with bar and sparkline, last breach, mean time to recover, block rate, unrecovered drone chips. Attacker: seized n of discovered, last takeover, lost back, blocked, held drone chips. Observer: control share blue vs red, first takeover, mean time to recover, block rate, takeovers recovered. Every value is computed from the evidence rows and drone rows that role's subscription returns; the attacker never sees recovery rows, so its sparkline is cumulative takeovers and "lost back" is derived from the visible controller field.
3. **Main row**: agents rail | Three.js map | right column. The map header holds the legend, the `sim coords · tick` caption, and the camera toggle. Observer shows red rail | map | blue rail with a selected-drone strip above the map. Only compromised and blocked drones pulse; `prefers-reduced-motion` disables it.
4. **Log**: full-width table (Threats & responses / Operation log / Evidence). The defender log prints "unknown origin" where the view redacts the actor. Clicking a row pins that event and filters the log to its drone; "show all" clears it.

The attacker and defender right columns are a chat with their agent (Crimson / Sentinel). Clicking a drone on the map, a status chip, or a log row posts "Pull up DR-xxx" and inserts an asset card scoped to the role (the attacker card shows battery and policy as redacted). Agent lines come only from real evidence rows: when a new row lands for a pulled-up drone, or for any row with an own-team actor, a one-line summary is posted.

**Queued-command limitation.** No operator-command reducers exist. Action chips (Policy / Isolate / Verify / Recover all; Command / Discover / Hold / Skip hardened) and typed messages are appended to the transcript marked "queued" and nothing acts on them; the UI never invents success text. Adding such reducers must keep the existing identity and role checks in `arena-live/src/fleet.rs`.

## Rendering and assets

Three.js renders database positions with a reusable quadrotor from Higgsfield 3D Jutsu project `0680b9e1-329c-40ad-aff1-edc52fd7d7a2`, inspected revision 1. `web/assets/swarm-blockout.glb` is a 32 KB procedural blockout, not a photorealistic reconstruction. Drone geometry is shared across clones. Motion comes from measured state, without a background generative video or per-frame generation calls.

A projected Canvas map is available when WebGL cannot initialize. Selection works through the map or an accessible asset list. Playback pauses and scrubs; camera controls change projection. There is no unsolicited camera animation. Inspecting an evidence row keeps that event pinned in the asset panel across live updates, and live redraws are coalesced to one per animation frame.

Browser checks (2026-10-24, Chromium 1243 via Playwright against `demo:fleet` and the static export): per role, no data from outside its scope (no defense internals, battery or policy for the attacker; no discovery rows or attacker IDs for the defender), chat pull-up and queued commands, status values matching the evidence rows, evidence-row pinning, recorded play/scrub, backend disconnect freezes the last state, WebGL disabled falls back to the Canvas map, and the 390 px viewport has no horizontal overflow. The camera auto-frames the visible fleet, so a 48-drone run and a 256-drone run both fill the map.
