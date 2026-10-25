# Arena shell v2: spec and implementation prompt

`Defender.dc.html` is a Claude Design artboard (1440×900) of the Defend view. It needs the
Design runtime to render, so read it as markup: it is the source of truth for sizes,
colors, copy and structure. Its `phase` / `redHeld` props and its agent, event and chat
rows are sample states for layout, not real data. The viewport in it is a cleaned
screenshot of the current Three.js scene (`viewport-reference.png`); the scene itself does
not change.

- `before.png`: the screen before the arena shell.
- `implemented-v1.png`: the first implementation (ui/arena-shell). v2 below fixes it.

## What changed from v1

1. The possession bar is no longer its own row. It is a 6px band along the top edge of the
   SWARM row (red share from the left, blue the rest, 2px tick at 50%). The separate
   RED HOLDS / BLUE HOLDS cells are gone.
2. Row 2 is 50px and carries the column headers: AGENTS (left), SWARM row (middle),
   SENTINEL (right). The viewport sits directly under it, so it moves up and the activity
   log gets the space (~310px at 900px tall instead of ~264px).
3. Camera control: Follow / Fit / Top-down are flush full-height tabs at the right end of the
   SWARM row, split by 1px rules. Active tab: background #121823 + inset 2px #5B8CFF underline.
4. State legend is tighter: 12px between items, 5px inside an item.
5. Activity log is compact: 32px single-line rows, whole-row tint by state, no left border.
6. The "DR-040 only" chip is a drone filter selector, flush right in the ACTIVITY bar.
7. Sentinel: no ASK SENTINEL / SUGGESTED bars. The transcript runs from the SENTINEL header
   to a composer docked at the bottom: one bordered box with the suggestions stacked above
   the input. The drone context chip sits inside the input on the left.

## Layout (1440×900 reference)

Page: one CSS grid. `grid-template-columns: 272px minmax(0,1fr) 352px`;
`grid-template-rows: 56px 50px minmax(0,1fr)`; height 100dvh; only inner bodies scroll.
Borders: 1px #2A3345 on every cell edge; 1px #1B2230 between rows in lists. Dividers
inside bars are full-height rules, never gaps. Insets 20px left/right (12px when a button
sits on the right edge).

Row 1, header (56px): SUDOKO wordmark | role segmented control (Attack / Defend /
Observer, 32px buttons) + full-height rule + "Blue team · FC-01 · 120 drones, blue
credential" | status dot + "Live" + state text, then a 56px cell with the "⋯" demo menu
(Reset swarm, Reset demo, Presenter mode, camera help).

Row 2 (50px, content sits under a 6px top inset so labels line up across all three cells):
- Left: AGENTS label + count.
- Middle: possession band (absolute, top 0, 6px) / SWARM label / full-height rule / legend
  (Home, Compromised, Recovered, Blocked, Isolated with live counts) / spacer / camera tabs.
- Right: SENTINEL label + provider (muted) + 28px new-chat button.

Row 3:
- Left: agent list (440px body) / SELECTED header (44px, clear button) / selected drone:
  mono ID + state tag + full evidence sentence.
- Middle: viewport (440px) / ACTIVITY header (44px): label, rule, All / Problems / You
  tabs, spacer, drone filter selector / log body.
- Right: transcript (fills, bottom-aligned bubbles) / composer docked at the bottom.

Alignment checks at 1440×900: the bottom of the viewport equals the bottom of the agent
list; the SELECTED and ACTIVITY headers share a top; the row-2 bottom rule runs unbroken
across all three columns; column rules sit at x=272 and x=width-352 from top to bottom.

## Components

Activity log
- Sticky 32px top row: SENTINEL label, status dot, status text ("Waiting for user
  instructions"). Replaces the "Sentinel · team controller" block.
- Event row: a `<button>`, 32px, grid `64px 56px 104px 1fr`, gap 12px: time (mono 12,
  muted) | drone (mono 12) | state word (500, state color) | action ID (mono 12, #8FB0FF)
  + detail (ellipsis, one line). Click selects that drone.
- Whole-row tint, no left border, 1px #0A0D13 bottom border between rows:
  compromised rgba(255,90,95,.13) / #FF7A7E; blocked rgba(232,176,74,.12) / #E8B04A;
  contained or isolated rgba(91,140,255,.12) / #8FB0FF; recovered rgba(56,192,122,.12) /
  #5FD495. Hover or selected: raise the tint alpha by about .08.
- Routine-check groups: one untinted muted row, state "Routine ×N", action ID,
  "checks with minor results"; expanding inserts the child rows in the same format.

Drone filter selector: flush full-height cell behind a 1px rule at the right of the
ACTIVITY bar: funnel icon, "Drone" (muted), value (mono 12, #8FB0FF, "All" when unset),
chevron. Opens a listbox: "All drones", then drone IDs. Replaces the amber chip.

Composer: one box (1px #3A4760, radius 8, bg #0A0D13), 16px from the bottom and 20px from
the sides. Top: suggestions list, three 36px rows (arrow icon, text, first row highlighted
with a "Tab" hint), 1px rule. Bottom: 44px input row: context chip (mono 12, ×) inside the
left edge, input, attached 44px send button (#3D6FE6). Tab fills the highlighted suggestion,
Enter sends; clicking a suggestion sends it through the same path as typed input.
Suggestions come from a static template map keyed on fleet state and the selected drone,
never a model call.

## Tokens and type

- bg #0A0D13, panel #0D1118, raised #121823, active #18202E, line #2A3345,
  row-line #1B2230, control-border #3A4760.
- fg #E7EBF2, text-2 #A3ACBC, muted #8C96A8, faint #7F8A9D.
- red #FF5A5F (text #FF7A7E), blue #5B8CFF (text #8FB0FF, send #3D6FE6),
  green #38C07A (text #5FD495), amber #E8B04A.
- Type, five roles only: 11px JetBrains Mono 500 uppercase .14em (#A3ACBC) for labels;
  13px Inter for all text and buttons (400 / 500 controls / 600 emphasis); 12px JetBrains
  Mono 500-600 for IDs, times, counts; 14px JetBrains Mono 600 .32em for the wordmark.
- Controls 28px in 44px bars, 32px in the header; status dots 8px; 44px touch targets for
  icon-only buttons.

## Per role

- Defend: as drawn.
- Attack: same shell, red copy. The attacker cannot see fleet size: the possession band
  shows held vs discovered, and the legend lists only states the attacker can see. Chat is
  CRIMSON. Suggestions: idle "Discover drones on FC-01", "What is the fleet controller
  exposing?", "Command DR-xxx"; engaged "Hold what we have", "Why was DR-xxx blocked?",
  "Try another drone"; repelled "Summarize what got blocked", "Find a new entry point".
- Observer: no chat. Left = RED AGENTS + SELECTED; right = BLUE AGENTS (top) + EVIDENCE
  for the selected drone (lower section, header aligned with ACTIVITY).

## Other pages

`web/index.html`, `web/live.html` and `web/report.html` adopt the same system: shared
tokens and type, the same 56px header (wordmark cell + page nav + status cell), 1px rule
grid, 44px section headers with 11px mono labels, and 32px tinted rows for any event or
evidence table. No changes to what data they show.
