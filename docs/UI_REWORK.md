# Fleet UI — the arena shell

Target files: `web/fleet.html`, `web/fleet.ts`. One shell serves the **attacker**, **defender**
and **observer** views; only colour, copy and the right column differ. The visual spec is
`design/arena-shell/Defender.dc.html` (`PROMPT.md` beside it has the tokens and copy;
`before.png` is the screen it replaced). The KEEP list in `design/role-views/PROMPT.md` still
applies: role scoping, SpacetimeDB subscriptions, replay/export, the Canvas fallback, the
Three.js scene with its in-scene drone label and selection ring, and real field names.

## The page grid

One CSS grid on `body` keeps every line aligned; flex columns drift.

```
grid-template-columns: 272px minmax(0,1fr) 352px;
grid-template-rows:    56px  52px  minmax(0,1fr);   height: 100dvh
```

```
┌ SUDOKO ──┬ Attack|Defend|Observer │ Blue team · FC-01 · … ┬ ● Live · state ┬ ⋯ ┐  56
├ RED HOLDS n ┼ ███████░░░░░░░ (red share, 50% tick) ───────┼ n BLUE HOLDS ─┤  52
├ AGENTS   n ┼ SWARM │ legend+counts │  Follow Fit Top-down ┼ SENTINEL · + ┤  44
│ agent cards│  #viewport (Three.js, no overlays)           │ transcript    │ 440
├ SELECTED ×┼ ACTIVITY │ All Problems You     DR-040 only ─┼ SUGGESTED ────┤  44
│ DR-040 tag │ time │ drone │ ● state │ detail …            │ 3 chips       │ rest
│ sentence   │                                              │ About DR-040  │
│            │                                              │ [ input ][→]  │
└────────────┴──────────────────────────────────────────────┴───────────────┘
```

Every main-row column is the same stack: 44px header, 440px body, 44px header, body that
fills the rest. So three rules cross all three columns: the top headers, the bottom of the
viewport, and the lower headers. `#head` and `#possession` are `display: contents` wrappers,
so their cells are children of the page grid; below 1100px they become their own grids and
the columns stack (rail, map, chat) with the possession bar still full width.

Borders are 1px `--line` (#2A3345) on every cell edge and 1px `--row-line` (#1B2230) between
rows inside a list. Dividers inside bars are full-height rules (`.rule`), never gaps. Insets
are 20px, or 12px on the right when a button sits on the edge (`.bar.btn-r`).

Type has five roles: 11px mono labels (`h2`, `.label`), 13px Inter for text and controls,
12px mono for IDs/times/counts (`.mono`), 18px mono for the two possession counts, 14px
mono with .32em tracking for the wordmark. Controls are 28px tall in bars and 32px in the
header. The old palette is remapped onto the arena tokens (`--bg`, `--panel`, `--raised`,
`--active`, `--line`, `--row-line`, `--control-border`, `--fg`, `--text-2`, `--muted`,
`--faint`, team and state colours); there is one palette, not two.

## What each row holds

- **Header.** Wordmark; role segmented control with 8px colour dots; the team line
  (`Red team · FC-01 · Fleet size unknown, red credential` on Attack, `Blue team · FC-01 ·
  120 drones, blue credential` on Defend, `Observer · FC-01 · n drones, both teams`); the
  recording play/scrub and match clock when a recording or fixture run is shown (hidden in
  demo mode); then the **one status cell** (`#live`: dot, connection word, `·`, chat state in
  `#chat-sub`) and the ⋯ button. The old header badge, "Live" pill and chat-header status are
  gone.
- **⋯ menu.** Reset swarm, Reset demo (demo mode only, same handlers as before), Presenter
  mode, and the camera help that used to float on the map. Presenter mode (also the **P** key)
  hides the menu button.
- **Possession.** `RED HOLDS n | bar | n BLUE HOLDS`. The red share animates its width over
  600ms; a 2px tick marks 50%. Defend: compromised vs own fleet. Observer: full fleet. Attack:
  the attacker cannot see the fleet size, so the right side is the discovered count and is
  labelled **DISCOVERED**; no total the role cannot see is ever shown.
- **Left column.** AGENTS (count on the right) over the existing agent cards; clicking a card
  opens the existing modal. SELECTED (clear button) over the selected drone: mono ID, state
  tag and the full evidence sentence from `oneLine`, scoped to the role. This replaces the
  viewport popover and the fleet gauge.
- **Swarm strip.** Label, rule, then the legend with live counts, then the camera control.
  Defend/Observer: Home, Compromised/Unauthorized, Recovered, Blocked (last 3s), Isolated.
  Attack shows only states it can derive: Seized, Home, Lost (controller back home after a
  takeover it saw), Blocked. Isolation and recovery rows are not in the attacker's view, so
  they are omitted rather than estimated.
- **Activity.** All / Problems / You tabs after a rule, drone filter chip on the right. Rows
  are a 40px grid `72px 64px 112px 1fr`: time, drone ID, state dot + label, detail with
  ellipsis (full text in `title`). The state column comes from the evidence kind or the
  operation result status. The modal reuses the same rows with the time and detail only.
- **Right column (Attack/Defend).** CRIMSON or SENTINEL header with the provider muted and a
  28px new-chat button; transcript in the 440 body, bottom-aligned; SUGGESTED header; three
  36px suggestion buttons; composer with an "About DR-xxx" context chip and a 40px input with
  the attached 44px send button.
- **Right column (Observer).** BLUE AGENTS over the blue cards; EVIDENCE over the activity
  rows for the selected drone. The left column becomes RED AGENTS + SELECTED.

The feedback lines (`#error`, `#reset-status`) are a fixed toast at the bottom, outside the
grid, so a message never shifts the layout.

## Follow camera

The camera control is Follow / Fit / Top-down. Fit and Top-down are the previous behaviours.
**Follow** is a toggle (off by default, so there is still no unsolicited camera motion until
asked). While on, `mapScene` records every drone whose state flipped (home → compromised,
compromised → recovered, and so on). Drones that flipped in the last 6 s are framed with the
existing fit solver (`solve`, the same frustum search `fit` uses), and the camera eases toward
that framing over roughly half a second instead of snapping. Any user camera input (drag,
pan, scroll) cancels the ease and pauses Follow for 5 s; Fit or a double-click cancels it
too. Switching Follow off or changing epoch clears the tracked flips.

## Suggestions

The three SUGGESTED chips come from a static template map (`SUGGESTIONS` in `fleet.ts`),
keyed on role and a fleet phase derived from the role's own evidence. No model call makes
them.

- Defend: idle (nothing held, nothing recovered) → *Probe the fleet controller*, *What is
  exposed right now?*, *Trace DR-xxx's last 3 commands*; contested (something held) → *Why
  did these drones flip?*, *Isolate the compromised cluster*, *Write a guard rule for this
  exploit*; recovered (nothing held, recoveries seen) → *Summarize what was blocked*, *Show
  the guard rule that held*, *Replay the takeover on DR-xxx*.
- Attack: idle → *Discover drones on FC-01*, *What is the fleet controller exposing?*,
  *Command DR-xxx*; engaged (holding drones) → *Hold what we have*, *Why was DR-xxx
  blocked?*, *Try another drone*; repelled (commands seen, nothing held) → *Summarize what
  got blocked*, *Find a new entry point*.

`DR-xxx` is the selected drone when there is one, otherwise the most relevant visible drone
(last blocked for Attack, first compromised or last recovered for Defend, else the first
drone); a chip that needs a drone is dropped when none is visible. Clicking a chip calls
`say(text)`, the same path as typed input, so it is subject to the same session, epoch and
pending-message rules.

## Stability rules (unchanged in spirit)

- `font-variant-numeric: tabular-nums` on every number that ticks.
- Fixed tracks: header 56, possession 52, bars 44, bodies 440, agent card 56, log row 40,
  suggestion 36, input 40.
- Lists are patched node by node (`patchList`) and the transcript appends; nothing
  `replaceChildren`s a whole panel on a tick.
- Nothing floats over the viewport except the in-scene hover/selection labels; the map only
  pans and zooms under the strip and the activity header.

## Verification

`scripts/check-arena-shell.ts` runs against a `demo:fleet` server (`FLEET_URL`, default
`http://127.0.0.1:4174`): it loads each role at 1440×900 and 390×844, saves
`output/arena-shell/<role>-<width>.png`, and asserts with `getBoundingClientRect` that the
three top headers share a bottom, the viewport bottom equals the left and right 440px bodies,
the three lower headers share a top, the column borders sit at x=272 and x=width−352 in the
header, possession and main rows, and that there is no horizontal scroll at 390px. It also
checks: no step band, no viewport overlays, one status indicator, resets only inside the
menu, and role scoping (the attacker page never shows a fleet total, isolation, recovery or
policy text). `npm run typecheck`, `npm run build:fleet` and `npm run test:fleet` are the
gate.
