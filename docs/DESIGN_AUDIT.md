# Swarm workspace audit — 2026-10-24

Applied Impeccable's craft floor and automated detector, with Taste's audit-first, brief-preserving guidance. Sources: https://impeccable.style/ and https://www.tasteskill.dev/docs. Scope is the drone fleet workspace; preserve the dark tactical identity and genuinely separate attacker/defender content.

## Findings and implemented fixes

| Finding | Fix |
| --- | --- |
| Attacker pressed/hover text contrast 4.1:1 | Lighter red accent; detector now reports no findings |
| 10–11 px functional text | Raised labels, timeline/status, legends, and agent metadata; body copy 14 px |
| Opposing roster leakage in prior design | Separate workspace renders backed by scoped database views |
| Observer labels said “My agents” | Observer uses “All fixture agents” and accurate metrics |
| Clicking evidence did not update selection | Synchronize asset list, map highlight, assessment, and event filter |
| Empty initial attacker map looked broken | Default to defender fleet; attacker still sees only discovered targets |
| Browser without WebGL had a blank primary area | Interactive Canvas projection with visible fallback notice |
| Drone selection showed a blank option | Explicit “Select a drone” placeholder |
| Unstable agent order during updates | Sort agents by ID |
| Live subscription could redraw for every row callback | Batch updates in a microtask |
| Camera clipped the fleet at the edge | Widened field of view and pulled camera back |

## Checks and limits

TypeScript and bundle build pass. Impeccable detector returns `[]` after the typography/contrast fixes. Browser QA checked defender fleet, timeline scrub, asset inspection, recovery evidence, and the fallback map. Separate runtime checks cover database visibility and real WebSocket subscriptions. The UI labels recordings and fixture logic honestly.

Responsive breakpoints collapse the roster and investigation panels below the map; controls have 44 px minimum height, focus outlines, accessible labels, and no continuous camera animation. Mobile viewport (390 px) and GPU WebGL (NVIDIA via ANGLE) renders were checked on 2026-10-24; see `FLEET.md`. Empty/disconnected states freeze observed state rather than inventing telemetry.

Reconciliation fixes (2026-10-24): the inspected evidence JSON was wiped by the next live update and the selected-event highlight was never applied; both now derive from a pinned event ID. Live redraws are batched per animation frame instead of per microtask. The static markup now starts on the defender workspace to match the script's default.

This audit does not certify production readiness. Remaining product work: real policy-agent adapters for fleet mode, controlled HTTP/flight-controller integration, measured scale/performance budgets, and remote role authentication. Keep these separate from the existing HTTP scenario suite's validation claims.
