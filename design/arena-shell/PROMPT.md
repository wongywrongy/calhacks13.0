# Arena shell: implementation prompt

`Defender.dc.html` is a Claude Design artboard (1440×900) of the Defend view. It needs the
Design runtime to render, so treat it as the visual spec: layout, line grid, type scale,
tokens and copy. The viewport in it is a cleaned screenshot of the current Three.js scene
(`viewport-reference.png`); the scene itself does not change. `before.png` is the screen
this replaces. The artboard's `phase` / `redHeld` props and its agent, event and chat rows
are sample states for layout only, not real data.

Apply the shell to all three role views (Attack, Defend, Observer). Hand the prompt below
to Codex or Claude Code from the repo root.

---

```
Restyle web/fleet.html + web/fleet.ts to the arena shell in design/arena-shell/
(Defender.dc.html is the spec; before.png is the current screen). Apply it to the
Attack, Defend and Observer views. Read the spec file first, plus docs/FLEET.md,
docs/UI_REWORK.md and design/role-views/PROMPT.md.

KEEP (do not regress):
- Everything in the KEEP list of design/role-views/PROMPT.md: role scoping, SpacetimeDB
  subscriptions, replay/export path, Canvas fallback, timeline, pinned evidence, real
  field and event names. Never derive a field a role cannot see.
- The Three.js scene, camera, in-scene drone label and selection ring. Do not change
  what renders inside #viewport except removing the overlays listed below.
- Chat in the right panel only, everything that happens in the activity log
  (docs/UI_REWORK.md).

REMOVE:
- The step band (#judge-guide: "Start a challenge -> respond -> inspect evidence",
  "1. Prepare challenge", "2. Prepare defense", "3. Findings").
- Viewport overlays: controls key (.ov.bl.key), legend (.ov.br.legend / #legend) and the
  selected-drone popover (.ov.tr, #ov-sel, #tip-sel). Selection moves to the left rail,
  the legend moves into the swarm strip, camera help moves into the demo menu.
- The fleet % gauge in the left rail (possession bar replaces it).
- Duplicate status: header badge + "Live · Awaiting objective" pill + chat-header status
  collapse into one header status cell.

GRID (one CSS grid for the page; this is what keeps lines aligned, flex columns drift):
- Page: grid-template-columns 272px minmax(0,1fr) 352px;
  grid-template-rows 56px 52px minmax(0,1fr); height 100dvh; only inner bodies scroll.
- Every column inside the main row is the same stack: header 44px, body 440px,
  header 44px, body fills the rest. So three horizontal rules cross all three columns:
  the top section headers, the bottom of the viewport, and the lower section headers.
- 1px #2A3345 borders on every cell edge; 1px #1B2230 between rows inside a list.
  Inner dividers in bars are full-height rules, never gaps.
- Insets: 20px left/right everywhere; 12px right when a button sits on the right edge.

ROW 1, header (56px), split on the same columns:
- Left cell: SUDOKO wordmark.
- Middle cell: role segmented control (Attack / Defend / Observer, 8px color dots,
  32px buttons), full-height divider, then "Blue team · FC-01 · 120 drones, blue
  credential" (red-team copy on Attack; Observer: "FC-01 · both teams").
- Right cell: status dot + "Live" + state text; then a 56px cell with a "⋯" button
  (44px target) opening the demo menu: Reset swarm, Reset demo, Presenter mode, camera
  controls help. Presenter mode (key P) hides the menu button.

ROW 2, possession (52px), same columns:
- Left: "RED HOLDS" label + count. Middle: 12px bar, red share from the left, blue
  fills the rest, 2px tick at 50%, width transition 600ms. Right: count + "BLUE HOLDS".
- Defend: compromised vs own fleet. Observer: full fleet. Attack: the attacker cannot see
  fleet size, so show held vs discovered and label the right side "DISCOVERED"; never
  show a total the role can't see.

ROW 3:
- Left column: AGENTS header (count right) / agent list in the 440 body (existing
  agent cards, click opens the existing modal) / SELECTED header (clear button) /
  selected drone: mono ID + state tag + the full evidence sentence (no truncation),
  scoped to the role.
- Middle column: SWARM strip (44px): label, full-height divider, then the state legend
  with live counts (Home, Compromised, Recovered, Blocked, Isolated; Attack shows only
  states it can see), then the camera segmented control: Follow (new), Fit, Top-down.
  Follow eases the camera to frame drones whose state just changed, and pauses for 5s
  after any user camera input. Then the 440px viewport. Then ACTIVITY header (All /
  Problems / You tabs after a full-height divider; drone filter chip on the right),
  then log rows: 40px grid of time | drone | state dot + label | detail (ellipsis).
- Right column, Attack/Defend: chat header (CRIMSON or SENTINEL, provider muted, 28px
  new-chat button) / transcript in the 440 body, bottom-aligned / SUGGESTED header /
  three 36px suggestion buttons / composer: "About DR-xxx" context chip, 40px input with
  attached 44px send button.
- Right column, Observer (no chat): BLUE AGENTS in the top section, EVIDENCE for the
  selected drone in the lower section; left column becomes RED AGENTS + SELECTED.

SUGGESTIONS:
- Generated from fleet state with a template map, no model call. Clicking one sends it
  as the chat message (same path as typed input). Include the selected drone ID when one
  is selected.
- Defend: idle -> "Probe the fleet controller", "What is exposed right now?",
  "Trace DR-xxx's last 3 commands"; contested -> "Why did these drones flip?",
  "Isolate the compromised cluster", "Write a guard rule for this exploit";
  recovered -> "Summarize what was blocked", "Show the guard rule that held",
  "Replay the takeover on DR-xxx".
- Attack: idle -> "Discover drones on FC-01", "What is the fleet controller exposing?",
  "Command DR-xxx"; engaged -> "Hold what we have", "Why was DR-xxx blocked?",
  "Try another drone"; repelled -> "Summarize what got blocked", "Find a new entry point".

TYPE (five roles only):
- 11px JetBrains Mono 500, letter-spacing .14em, uppercase, #A3ACBC: section labels.
- 13px Inter: all text and buttons (400 text, 500 controls, 600 emphasis).
- 12px JetBrains Mono 500-600: IDs, times, counts, filter chips.
- 18px JetBrains Mono 600: the two possession counts.
- 14px JetBrains Mono 600, letter-spacing .32em: wordmark.
- Controls: 28px tall in 44px bars, 32px in the header. Status dots 8px.

TOKENS (map existing CSS variables onto these):
- bg #0A0D13, panel #0D1118, raised #121823, active #18202E, line #2A3345,
  row-line #1B2230, control-border #3A4760.
- fg #E7EBF2, text-2 #A3ACBC, muted #8C96A8, faint #7F8A9D.
- red #FF5A5F (text #FF7A7E), blue #5B8CFF (text #8FB0FF, send #3D6FE6),
  green #38C07A (text #5FD495), amber #E8B04A.

RESPONSIVE: below ~1100px the three columns stack (rail, map, chat) and the possession
row keeps its bar full width; no horizontal page scroll at 390px.

DONE WHEN:
- npm run typecheck, npm run build:fleet and npm run test:fleet pass.
- At 1440x900 in each role, the three horizontal rules line up across all columns and
  the column borders run unbroken from the header to the bottom.
- No step band, no viewport overlays, one status indicator, resets only in the menu.
- Role scoping checks from design/role-views/PROMPT.md still hold.

Update docs/UI_REWORK.md to describe the shell. Commit on a branch and open a PR.
```
