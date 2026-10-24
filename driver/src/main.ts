// SudoKO MOCK match driver — scripted stand-ins for the referee and the four agents.
// No LLM, no randomness, no network beyond the local SpacetimeDB arena. It replays the
// same scenario web/index.html hardcodes in its TIMELINE, but through the real reducers,
// so the board renders it from the arena tables.
import { DbConnection } from "./module_bindings/index.ts";

type Team = "red" | "blue";
type Step = { t: string; round: number; team?: Team; kind: string; kls?: string; msg: string };

// Copy of web/index.html TIMELINE (same order and values) — keep the two in sync.
const TIMELINE: Step[] = [
  { t: "0:00", round: 1, kind: "rotate", msg: "Round 1 — flags planted" },
  { t: "0:06", round: 1, team: "red", kind: "steal", kls: "SQLI-01", msg: "red STOLE blue flag — SQLI-01" },
  { t: "0:12", round: 1, team: "blue", kind: "patch", kls: "SQLI-01", msg: "blue PATCHED SQLI-01 → re-test PASS" },
  { t: "0:17", round: 1, team: "blue", kind: "steal", kls: "XSS-02", msg: "blue STOLE red flag — XSS-02" },
  { t: "0:23", round: 1, team: "red", kind: "patch", kls: "XSS-02", msg: "red PATCHED XSS-02 → re-test PASS" },
  { t: "0:30", round: 2, kind: "rotate", msg: "Round 2 — fresh flags" },
  { t: "0:36", round: 2, team: "red", kind: "steal", kls: "IDOR-03", msg: "red STOLE blue flag — IDOR-03" },
  { t: "0:42", round: 2, team: "blue", kind: "patchbad", kls: "IDOR-03", msg: "blue PATCHED IDOR-03 → SLA dip (rule too broad)" },
  { t: "0:48", round: 2, team: "blue", kind: "blocked", kls: "XSS-02", msg: "blue tried red XSS-02 → BLOCKED" },
  { t: "0:54", round: 2, team: "blue", kind: "recover", msg: "blue tightened the rule → SLA recovered" },
  { t: "1:00", round: 3, kind: "rotate", msg: "Round 3 — fresh flags" },
  { t: "1:06", round: 3, team: "red", kind: "blocked", kls: "SQLI-01", msg: "red tried blue SQLI-01 → BLOCKED" },
  { t: "1:11", round: 3, team: "red", kind: "steal", kls: "SSRF-04", msg: "red STOLE blue flag — SSRF-04" },
  { t: "1:17", round: 3, team: "blue", kind: "patch", kls: "SSRF-04", msg: "blue PATCHED SSRF-04 → re-test PASS" },
  { t: "1:24", round: 3, kind: "end", msg: "Match complete — RED 3 · BLUE 1" },
];

const URI = process.env.STDB_URI ?? "http://127.0.0.1:3000";
const DB = process.env.STDB_DB ?? "sudoko-arena";
const SPEED = Number(process.env.SPEED ?? 1); // 2 = twice as fast; timing only, never values

const other = (t: Team): Team => (t === "red" ? "blue" : "red");
// Synthetic flag values; prefix keeps them distinct from deterministic.sh's RED_FLAG_1/BLUE_FLAG_1.
const flagValue = (owner: Team, round: number) => `MOCK_${owner.toUpperCase()}_FLAG_${round}`;
const secs = (t: string) => { const [m, s] = t.split(":").map(Number); return m * 60 + s; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const conn = await new Promise<DbConnection>((resolve, reject) =>
  DbConnection.builder()
    .withUri(URI)
    .withDatabaseName(DB)
    .onConnect((c) => resolve(c))
    .onConnectError((_ctx, err) => reject(err))
    .build(),
);
const r = conn.reducers;
console.log(`[mock] connected to ${DB} at ${URI}`);

// The referee's scoreboard, tracked locally because the script is fully known up front.
const steals = { red: 0, blue: 0 };
const sla = { red: 100, blue: 100 };
const score = (round: number) =>
  r.recordScore({ round, redFlags: steals.red, blueFlags: steals.blue, redSla: sla.red, blueSla: sla.blue });

// Every agent/referee action is logged as an event; detail_json carries the timeline step
// so the board can narrate it. kind stays within the schema's request|capture|rule_change|sla.
const log = (kind: string, actor: string, target: string, s: Step) =>
  r.recordEvent({ kind, actor, target, detailJson: JSON.stringify({ step: s.kind, round: s.round, team: s.team, kls: s.kls, msg: s.msg }) });

async function run(s: Step) {
  const team = s.team!;
  switch (s.kind) {
    case "rotate": // mock referee
      if (s.round > 1) await score(s.round - 1);
      await r.plantFlags({ round: s.round, redValue: flagValue("red", s.round), blueValue: flagValue("blue", s.round) });
      return;
    case "steal": // mock red_attack / blue_attack
      await r.submitFlag({ byTeam: team, value: flagValue(other(team), s.round) });
      steals[team]++;
      return log("capture", `${team}_attack`, other(team), s);
    case "blocked": // mock attacker probe that the enemy's guard rejected
      return log("request", `${team}_attack`, other(team), s);
    case "patch": // mock red_defend / blue_defend
      await r.writeRule({ team, matchJson: JSON.stringify({ path: "/flag", shape: s.kls }), action: "block" });
      return log("rule_change", `${team}_defend`, team, s);
    case "patchbad": // over-broad rule -> mock referee's SLA check catches known-good traffic
      await r.writeRule({ team, matchJson: JSON.stringify({ path: "/flag" }), action: "block" });
      await log("rule_change", `${team}_defend`, team, s);
      await r.recordSla({ team, slaPct: (sla[team] -= 15) });
      return;
    case "recover":
      // The arena has no reducer to edit/remove a rule, so the "tightened" rule is narrated
      // only; the SLA recovery is what the referee records.
      await r.recordSla({ team, slaPct: (sla[team] = Math.min(100, sla[team] + 12)) });
      return log("sla", "referee", team, s);
    case "end":
      // No end_match reducer / match.status="done" writer exists; the final score_tick is the end marker.
      return score(s.round);
  }
}

await r.startMatch({});
const t0 = Date.now();
for (const s of TIMELINE) {
  await sleep(t0 + (secs(s.t) * 1000) / SPEED - Date.now());
  await run(s);
  console.log(`[mock] ${s.t}  ${s.msg}`);
}
console.log(`[mock] done — RED ${steals.red} · BLUE ${steals.blue}`);
conn.disconnect();
