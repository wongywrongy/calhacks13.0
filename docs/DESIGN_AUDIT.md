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

## Role-view rebuild (2026-10-24)

`web/fleet.html` + `web/fleet.ts` now follow `design/role-views/`: one flush shell (48 px header with corner tabs, hairline status row, agents | map | right column, full-width log) with the spec tokens (bg `#050D14`, panel `#0A121A`, raised `#0E1620`, hairlines `#182227`/`#242E3A`, Inter for UI, JetBrains Mono for numbers and tables, 11 px/600/.08em muted section headings). Team colours are red `#F02D38` (text `#FF5A63`) and blue `#277DFD` (text `#5B9DFF`); recovered is `#2BD47F`, blocked `#E8B04F`. Kept from the earlier audit: 44 px chips and send button, 48 px tabs and inputs, focus outlines, reduced-motion, contrast-safe red/blue text variants, and the pinned-evidence and batched-redraw fixes.

Scoping is unchanged: each view renders only what its subscription returns and no hidden field is derived client-side. Status metrics are omitted rather than estimated when a role cannot see the rows (the attacker has no mean-time-to-recover cell). Mean time to recover is shown in milliseconds below one second because the fixture defender reacts within its next tick.

Known limitation: chat commands are queued only. There are no operator-command reducers, so chips and typed messages are marked "queued" and no agent reply is fabricated; agent lines are summaries of real evidence rows. This audit does not certify production readiness. Remaining product work: real policy-agent adapters for fleet mode, controlled HTTP/flight-controller integration, measured scale/performance budgets, and remote role authentication. Keep these separate from the existing HTTP scenario suite's validation claims.
