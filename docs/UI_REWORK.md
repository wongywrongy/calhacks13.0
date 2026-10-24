# Fleet UI rework — chat/log split + role-view polish

Target files: `web/fleet.html`, `web/fleet.ts`. Applies to both the **attacker** and
**defender** role views, which must stay structurally identical (only color and copy
differ). The **observer** view keeps its dual-rail layout but adopts the same components.

Reference mockup: Claude Design canvas "SudoKO chat + log rework"
(Main = attacker, Defender, Stability = layout spec).

## The two problems this fixes

1. **The chat and the log were the same stream.** The right panel showed activity rows,
   drone cards, and operator messages all mixed together.
   - The **right panel is a chat only**: the operator's messages and the agent's replies,
     as bubbles. Nothing else.
   - The **bottom panel (Activity log) holds everything that happens**: agent actions,
     threats, and the operator's own queued commands — one row each.

2. **The screen jittered when data changed.** Content-sized flex rows reflowed on every
   tick. Everything below is now fixed-track / fixed-height so a value change never moves
   a neighbor.

## Layout (both role views)

One-screen app shell, `100dvh`, only inner panels scroll.

```
┌─ header 56px ───────────────────────────────────────────────┐
│ SUDOKO · [role switch]   match · badge · sub   Live · clock  │
├─ rail 288 ─┬─ map (flex) ──────────────────────┬─ chat 360 ──┤
│ gauge+chips│  viewport (overlays, absolute)    │ transcript  │
│ ──────────  │                                   │ ──────────  │
│ agent cards │  ┌─ activity log 300px ────────┐ │ context 40  │
│  (scroll)   │  │ filter · rows (scroll)       │ │ input 48    │
└────────────┴──┴──────────────────────────────┴─┴─────────────┘
```

### Header — 56px, `grid-template-columns: auto minmax(0,1fr) auto`
- **Left**: `SUDOKO` wordmark + role switch as a **segmented control** (pill group, 2px
  inset padding, active = `#141e28` with `inset 0 0 0 1px #242e3a`). Attacker/Defender/
  Observer, each with its color dot.
- **Middle**: match line `Red team · FC-01` / `Blue team · FC-01` (ellipsis, `min-width:0`)
  + a state badge (attacker `ENGAGED`, defender `CRITICAL`, both red), then a muted sub
  line (`Fleet size unknown · red credential` / `48 drones · blue credential`).
- **Right**: a **"Live" pill** — text only, light-green border `#7ee8b0` + light-green text
  on `#0c2619`, fixed 64px. (Other states reuse the pill: `Stale` amber, `Replay` grey.)
  Then the clock with a 3px progress bar under it. Use `tabular-nums` on the clock.
- No `/ Attack` breadcrumb — the active role is already in the switch.

### Left rail — 288px
- A **40px label bar**, then a **headline gauge block** (16px inset):
  - A 64px SVG ring, red arc = share held/compromised, **percentage in the center** (`6%`).
  - Beside it: a bold line (`of the fleet held` / `of the fleet compromised`) and a muted
    `3 of 48 drones`.
  - Below: the held/unrecovered drones as **chips on a fixed 3-col grid** — drone id left,
    hold-time right, quiet style (`#0e1620` fill, `#182227` border; not red-filled).
- Another **40px label bar** (`My agents · 8`), then the **agent cards** (scroll).

### Agent card — fixed 56px, click opens a modal
- Row 1: status **dot** + agent name (mono) + current drone (right, muted).
- Row 2: **one plain sentence** of what it's doing, ellipsized.
- Dot color = state: **working** `#5b9dff` (pulses), **failed** `#e8b04f`, **done**
  `#2bd47f`, **paused** `#a9b4c1`. No stat numbers on the card.
- **Click → modal**: scrim + centered dialog (440px) with the dot+name+state tag, the full
  sentence, a 3-stat row (attacker: target / held / 403s; defender: drone / recovered /
  blocked), and that agent's last few log lines. Close on × or scrim click. Esc closes too.

### Map header — 40px bar
- Label (`DISCOVERED SWARM · 48` / `MANAGED SWARM · 48`), spacer, then a **Fit/Top-down
  segmented control** (same pill-group style as the role switch). No tick readout in the bar.

### Viewport overlays — all absolute, never push layout
One shared surface for all three: `rgba(10,18,26,0.9)`, `1px solid #242e3a`, `6px` radius.
- **top-right**: selected-drone card — id (mono) + state tag + × + **one line** only.
  (Drop the ctrl/off-slot/pos/tick/batt/policy grid — too much.)
- **bottom-left**: controls key — `Drag → Orbit`, `Right-drag → Pan`, `Scroll → Zoom`,
  `Double-click → Reframe` (input mono/white left, action grey right).
- **bottom-right**: legend — one swatch+label per line. Corners never overlap.

### Activity log — docked under the map, fixed 300px
- 40px header: `ACTIVITY` label, then a **segmented filter**: `All` / `Problems` /
  `You`. Only **Problems** carries a count (failed actions + threats), as a small amber
  badge. On the right, an `Only DR-0xx` toggle appears when a drone is selected.
- Rows: `grid-template-columns: 44px minmax(0,1fr)` — timestamp (mono, muted) + **one
  sentence** with the actor bolded, left-aligned, filling the row, ellipsized, full text in
  `title`. **No status-code or policy columns.** Fixed 34px rows.
- Actor color still signals threats: attacker "Defense" amber, defender "Unknown origin"
  red; agents use the team color; "You" white.

### Chat panel — 360px, conversation only
- 40px header: agent name (`CRIMSON` / `SENTINEL`) + `attacking FC-01` / `defending FC-01`.
- Transcript: your bubbles (team-tinted, right) and agent bubbles (`#0e1620`, left), newest
  at the bottom. A "working…" typing bubble while awaiting a reply.
  **Append new nodes; never `replaceChildren` the whole transcript** (that caused the scroll
  jumps). Keep the stick-to-bottom behavior.
- A **fixed 40px context slot** above the input: empty = "Click a drone to talk about it";
  a drone selected = a detach-able chip. This replaces the old in-transcript drone card.
- **No quick-action buttons** — just the message field (48px) + send.

## Stability rules (make jitter impossible)
- `font-variant-numeric: tabular-nums` on every number that ticks.
- Fixed heights: header 56, bars 40, agent card 56, log rows 34, context slot 40, input 48.
- Grid tracks, not content-sized flex, for the log rows, the header, the agent card, the
  chip grid, the status gauge.
- Overlays are `position:absolute` — the map only pans/zooms under them.
- Status/role/live labels have reserved width so sibling elements don't slide.

## Acceptance
- Attacker and defender are pixel-structurally identical; diffing their markup shows only
  color tokens and copy.
- Play a recording start→finish: no element shifts except the values themselves and the
  map. No horizontal page scroll ≥1280px; panels stack cleanly below that.
- Chat shows only messages; the log shows every action/threat/operator command.
- Agent card → modal works; Esc and scrim close it.
- `npm run check:fleet` (or the repo's lint/build) passes; no TS errors in `fleet.ts`.
