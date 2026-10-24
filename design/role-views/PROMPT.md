# Role views: implementation prompt

The three files here are Claude Design artboards (`.dc.html`): `Observer`, `Attacker`, `Defender`. They need the Design runtime to render, so treat them as the visual spec: layout, copy, tokens and interaction. The numbers in them are one sample frame (t=0:42, 48 drones, 16 agents), not real data.

Hand the prompt below to Claude Code from the repo root.

---

```
Rebuild the swarm UI in web/fleet.html + web/fleet.ts to match the design spec in
design/role-views/ (Observer.dc.html, Attacker.dc.html, Defender.dc.html). Read all
three files first, plus docs/FLEET.md and docs/DESIGN_AUDIT.md.

KEEP (do not regress):
- Role scoping from docs/FLEET.md. Attacker sees only discovered drones, own agents and
  own outcomes; battery, policy and counters stay redacted. Defender sees its fleet and
  violations, never attacker IDs or discovery records. Observer sees full state. Every
  view renders only what its subscription returns; never derive hidden fields client-side.
- The SpacetimeDB subscriptions, recorded/export replay path, Three.js scene, the Canvas
  fallback when WebGL fails, timeline play/scrub, and the pinned-evidence fix.
- Real field and event names from arena-live/src/fleet.rs: drone {id,x,y,z,battery,tick,
  controller,isolated,policy_version,commands,rejected}; agent {id,role,step,target,
  last_action}; evidence kinds discovered, unauthorized_command_accepted,
  unauthorized_command_blocked, policy_applied, recovery_verified.

LAYOUT (same shell on all three views, edge to edge, no gutters, no rounded cards):
1. Header, 48px: "SUDOKO / <Attack|Defense|Observer>" breadcrumb plus a muted context
   line, then live dot, match clock, and the role switcher as flush tabs pinned to the
   top-right corner. The active tab gets a 2px team-color underline.
2. Status row: label-over-value cells split by 1px hairlines, with a severity badge first.
   - Defender: CRITICAL; compromised n/total with a thin bar and sparkline; last breach;
     mean time to recover; block rate; unrecovered drone chips.
   - Attacker: ENGAGED; seized n of discovered with bar and sparkline; last takeover;
     lost back; blocked; held drone chips.
   - Observer: CONTESTED; control share blue vs red with bar and sparkline; first
     takeover; mean time to recover; block rate; takeovers recovered.
   Compute every value from evidence rows. If a metric can't be derived from what that
   role can see, omit it rather than estimate it.
3. Main row, flush columns: agents rail | map | right column. The map header line holds
   the legend and the "sim coords · tick" caption. Observer has red rail | map | blue rail
   and an inline selected-drone strip above the map.
4. Full-width log table under the main row: Threats & responses / Operation log / Evidence.
   The Defender log shows "unknown origin" in place of attacker actor IDs.

CHAT (Attacker = Crimson, Defender = Sentinel; Observer has none):
- The right column is one transcript, one line per message: YOU / CRIMSON / SENTINEL.
- Clicking a drone on the map or a status chip posts "Pull up DR-xxx" and inserts an
  inline asset card, scoped to the role (attacker card shows battery and policy as redacted).
- Action chips sit in one segmented bar above the input, with an attached send button.
  Defender chips: Policy vN · DR-xxx, Isolate, Verify, Recover all. Attacker chips:
  Command DR-xxx, Discover, Hold, Skip hardened.
- No operator-command reducers exist yet. Chip and typed commands append to the
  transcript marked "queued", with no invented success text. Agent lines come only from
  real evidence: when a new evidence row lands for a drone that is pulled into chat (or
  any row, for the agent's own team), post a one-line plain-English summary. If you add
  operator-command reducers, they must respect the existing identity/role checks.

VISUAL TOKENS (from the spec):
- Colors: bg #050D14, panel #0A121A, raised #0E1620, line #182227, line2 #242E3A,
  fg #E8EEF6, muted #8A96A4.
- Team and status colors: red #F02D38 (text #FF5A63), blue #277DFD (text #5B9DFF),
  recovered #2BD47F, blocked #E8B04F.
- Type: Inter for UI; JetBrains Mono for numbers, IDs and tables. Section headings are
  11px, weight 600, letter-spacing .08em, muted.
- Keep the existing contrast fixes, 44px touch targets where the spec uses them, focus
  outlines, and prefers-reduced-motion. Only compromised and blocked drones pulse.

DONE WHEN:
- npm run typecheck and npm run build:fleet pass.
- test:fleet passes.
- A browser check of demo:fleet and the static export shows, for each role: no
  data from outside its scope, chat pull-up, status values matching the log, the
  WebGL-off fallback, and no horizontal overflow at 390px.

Update docs/FLEET.md and docs/DESIGN_AUDIT.md to describe the new layout and the
queued-command limitation. Commit on a branch and open a PR.
```
