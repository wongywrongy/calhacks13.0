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

## Rendering and assets

Three.js renders database positions with a reusable quadrotor from Higgsfield 3D Jutsu project `0680b9e1-329c-40ad-aff1-edc52fd7d7a2`, inspected revision 1. `web/assets/swarm-blockout.glb` is a 32 KB procedural blockout, not a photorealistic reconstruction. Drone geometry is shared across clones. Motion comes from measured state, without a background generative video or per-frame generation calls.

A projected Canvas map is available when WebGL cannot initialize. Selection works through the map or an accessible asset list. Playback pauses and scrubs; camera controls change projection. There is no unsolicited camera animation. The cloud QA browser disables WebGL, so its fallback was visually checked; the GLB Blender preview was inspected separately. The final WebGL path still needs visual confirmation on a GPU-enabled browser.
