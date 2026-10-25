# Viewport performance — 2026-10-25

Reviewed GitHub `main` at `881945b` (local HEAD matched after fetching), plus the
workspace's existing uncommitted flock visualization and chat changes. The before
measurements include those flock changes. This work does not change Rust reducers,
authoritative positions, role credentials, subscriptions, or HTTP state transport.

## What was slow

- The blockout has nine meshes. Cloning those meshes, ground discs and altitude
  stems for every drone produced 601 / 1,591 / 3,177 draw calls at 48 / 128 / 256
  drones in the controlled scene. At 256, synchronous draw submission averaged
  16.3 ms per frame, before GPU completion.
- Trails and cohesion links disposed and recreated their geometry and GPU buffers
  each frame. Dashed tethers also replaced their distance attributes every frame.
  The 256-drone sample created 1,035 WebGL buffers and explicitly deleted 180 in
  five seconds. Trail arrays also repeatedly grew, shifted and converted to typed arrays.
- The viewport rendered at up to DPR 2 regardless of sustained frame pressure.
  Reduced motion stopped drawing idle frames but still calculated the flock and links.
- The page has no React layer. Subscription changes already coalesce into one
  presentation update per animation frame. In the real subscription comparison,
  deriving state and updating panels averaged roughly 2–3 ms per update, less than
  the baseline rendering cost. No subscription throttling was introduced.

## Changes

`web/fleet.ts` now instances drone bodies and ground discs by their existing state
material, preserving diffuse and emissive colors. The existing GLTF parts are baked
once into shared geometry with their original transforms and normals. Altitude
stems share one line draw. Model loading swaps shared geometry without recreating
drone objects, clocks or trails. The procedural model remains available if loading fails.

Trails use bounded circular histories; trails, links and stems update reusable
dynamic GPU attributes and draw ranges. Tether distance attributes update in place.
Link topology changes only when visible drone IDs change. Capacity growth disposes
old buffers; fleet resets retain reusable instance capacity and clear displayed counts.

`web/fleet-render.ts` contains the geometry/buffer helpers and a small resolution
controller. DPR starts at most 1.5, drops by 0.25 after a two-second window above
22 ms average frame time, and recovers after four windows below 18 ms. The floor is
0.75, or the device DPR if lower. UI text stays at native CSS resolution. Scene
geometry, terrain, contours, lighting, state markers, trails and broken links remain.

Hidden pages skip presentation work; reduced-motion idle frames skip it too.
Position easing and flock clocks remain display-only and use elapsed time. The
long-frame animation cap increases from 100 to 250 ms to avoid slowing the flock
at the measured low frame rates. Database positions are never written by animation.

## Measurements

Headless Chromium 153.0.8010.12, 1440×900, device DPR 1, ANGLE Vulkan **SwiftShader software
rendering**. Five-second samples follow warmup. Temporary instrumentation measured
animation-frame intervals, function durations, renderer counters, buffer creation,
CDP CPU profiles and browser heap/task metrics. These are local engineering
comparisons, not desktop GPU benchmarks or GPU utilization measurements.

Controlled synthetic scene: fixed IDs, compromised/recovered drones, drifting
positions, isolated markers, ghost slots, two-second trails and cohesion links;
authoritative snapshots supplied every 250 ms independently of animation.

| Drones | Draw calls before → after | FPS before | Instancing/buffers at unchanged DPR 1 | Final adaptive FPS | p95 frame time before → final |
| --- | --- | --- | --- | --- | --- |
| 48 | 601 → 35 | 19.7 | 24.4 | 28.8 | 66.6 → 50.0 ms |
| 128 | 1,591 → 65 | 13.4 | 18.6 | 21.9 | 83.4 → 50.1 ms |
| 256 | 3,177 → 115 | 8.8 | 13.7 | 14.8 | 133.3 → 83.4 ms |

The final adaptive samples settled at DPR 0.75 on this software renderer. Triangle
counts were identical before/after: 114,212 / 143,140 / 189,540. At 256 drones,
average draw submission fell from 16.3 to 2.4 ms (~85%). All final warmed samples
created and deleted zero WebGL buffers during their measurement windows. Heap
snapshots were smaller, but these short runs do not establish long-term memory bounds.

A separate real local SpacetimeDB run used the unchanged scheduled fixture reducers,
authenticated viewer identities, actual WebSocket subscriptions and four agents per
side. FPS changed from 19.2 → 25.5, 13.2 → 19.8 and 8.8 → 14.0 at the three sizes.
The first drone advanced 16 authoritative ticks during the slowest baseline sample
and 18 during the corresponding optimized sample. Simulation continued independently
of browser animation. Full-fleet local SQL reads took 16–201 ms across the samples;
transport/backend latency remains a separate concern. These timings are not command
latency measurements, and fixture activity is not model behavior.

A 22-second, 48-drone figure-eight presentation run averaged 31.1 FPS, p95 33.4 ms,
with zero buffer creations/deletions and no terrain rebuilds during the sample.
Terrain keeps its existing 220×220 grid; rendering it still contributes to software
rasterization cost. No geometry reduction was justified from this environment alone.

## Validation and deployment

- `npm test` with the local SpacetimeDB binary: 37 passed, zero skipped or failed.
  New tests cover merged transforms/normals, buffer reuse/growth/disposal, and adaptive
  resolution bounds, hysteresis and very slow frames. Those focused tests were rerun
  after the final small changes.
- `npm run typecheck`, `npm run build:fleet`, `npm run build:vercel`, and
  `git diff --check` passed. The UI detector reported no findings.
- Actual browser checks passed for attacker, defender and observer: scoped agent
  views, state snapshots, selection, top-down, Fit, orbit and zoom. Reduced motion
  stops idle drawing and resumes animation when disabled. Forced WebGL failure
  renders Canvas; forced GLTF failure renders the procedural drones. DPR 2 caps at 1.5.
- Static DPR 1 screenshots match across all three roles: fewer than 0.013% of pixels
  differ by more than 10/255 in any RGB channel. Animated screenshots were inspected
  for healthy, compromised and recovering colors, trails, isolation and selection.

Temporary harnesses, JSON results, CPU profiles, logs and screenshots remain in
ignored `output/viewport-perf/` (`profile.mjs`, `live.mjs`, `visual.mjs`, `long.mjs`).
No profiling API or monitoring dependency ships. The deployable static output is
`output/vercel-static/`; `web/dist/fleet.js` is also rebuilt without instrumentation.
Production was subsequently deployed on request to https://sudo-ko.us as
`dpl_FPnWeRWcnsV1BBTVsAbk9ygsUpUq` from the tested working tree. No commit was made;
pre-existing workspace changes were preserved. The source upload allowlist now includes
the flock/render helpers and shared outcome module needed by the client build.
Vercel reported READY and assigned the existing domains. The served JavaScript SHA-256
matched the local tested build exactly:
`0d5d07d02fb09e4925ea9f31220974d54ee97e887240ad82c5acf0d7648e78f2`.
The app and health endpoint returned 200. Production Chromium checks passed for
defender (48 managed drones), attacker (zero discovered drones), top-down and Fit,
with no page exceptions. The observer role is not enabled on this production backend.
On this host the documented tailnet TLS issue prevents direct WebSockets; the existing
authoritative HTTPS snapshot fallback connected successfully. No fleet reset or model
operation was performed. Sanitized smoke evidence is in `output/viewport-deployment/`.

60 FPS on typical hardware remains a target to verify on the venue's hardware.
There was no hardware GPU, mobile device or production WAN benchmark in this run.
Adaptive resolution can soften the 3D canvas on weak devices. Instanced batches use
GPU clipping rather than per-drone frustum culling so moving bounds cannot hide
drones; the server's existing maximum is 256. Long-running sessions with much larger
event histories need separate profiling before changing the panel/state update path.

The implementation follows Three.js's existing [instancing API](https://threejs.org/docs/pages/InstancedMesh)
and [dynamic buffer attributes](https://threejs.org/docs/pages/BufferAttribute.html).
