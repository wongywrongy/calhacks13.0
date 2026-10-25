import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

// Arena shell v2 layout check against a running demo:fleet (http://127.0.0.1:4174).
// Screenshots per page and role at 1440x900 and 390x844, plus the alignment measurements
// from docs/UI_REWORK.md: viewport bottom = agent-list bottom, SELECTED/ACTIVITY headers
// share a top, the row-2 rule is one y across the columns, column rules at 272 / width-352.
const base = process.env.FLEET_URL ?? "http://127.0.0.1:4174";
const output = process.env.ARENA_OUTPUT ?? "output/arena-shell-v2";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox"] });
const report: Record<string, any> = {};
const mismatches: string[] = [];
try {
  for (const role of ["attacker", "defender", "observer"] as const) {
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      const page = await browser.newPage({ viewport: { width, height } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(base);
      await page.locator(`nav [data-role="${role}"]`).click();
      await page.waitForFunction((r) => document.body.dataset.role === r && document.querySelector("#live")?.textContent?.startsWith("Live"), role, { timeout: 30000 });
      await page.waitForFunction(() => document.querySelectorAll("#legend li").length > 0);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${output}/fleet-${role}-${width}.png` });
      if (role === "observer") {
        assert.equal(await page.locator("#overview").isVisible(),true);
        assert.equal(await page.locator("#compose").isVisible(),false);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        if(width===1440){
          assert.equal(await page.locator(".overview-results").evaluate(n=>n.getBoundingClientRect().width),272);
          assert.equal(await page.locator(".overview-fleet").evaluate(n=>n.getBoundingClientRect().width),352);
        }
        assert.deepEqual(errors,[]);await page.close();continue;
      }
      const m = await page.evaluate(() => {
        const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
        const right = document.body.dataset.role === "observer" ? "#rail-right" : "#chat";
        const rows = Array.from(document.querySelectorAll<HTMLElement>("#log .row"));
        return {
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          row2Bottoms: ["#row2 > .cell.l", "#swarm", `#row2 > .cell.r:not([hidden])`].map((s) => r(s).bottom),
          viewportBottom: r("#viewport").bottom,
          agentListBottom: r("#rail-left > .body").bottom,
          lowerHeaderTops: ["#rail-left > .bar", "section.col > .bar", ...(right === "#rail-right" ? ["#rail-right > .bar"] : [])].map((s) => r(s).top),
          leftBorderX: [r("#head > .cell.l").right, r("#row2 > .cell.l").right, r("#rail-left").right],
          rightBorderX: [r("#head > .cell.r").left, r(`#row2 > .cell.r:not([hidden])`).left, r(right).left],
          railBottom: r("#rail-left").bottom,
          rightBottom: r(right).bottom,
          composerBottom: right === "#chat" ? r("#compose").bottom : null,
          rowHeights: rows.slice(0, 20).map((x) => x.getBoundingClientRect().height),
          rowBorderLeft: rows.slice(0, 20).map((x) => getComputedStyle(x).borderLeftWidth),
          rowSingleLine: rows.slice(0, 20).every((x) => Array.from(x.children).every((c) => c.getBoundingClientRect().height <= 20)),
          rowTints: rows.slice(0, 20).map((x) => [x.dataset.tone ?? "", getComputedStyle(x).backgroundColor]),
          camTabs: Array.from(document.querySelectorAll("#cam button")).map((b) => b.getBoundingClientRect().height),
          text: document.body.innerText,
          possession: document.querySelector("#poss-bar")!.getAttribute("aria-label"),
          legend: Array.from(document.querySelectorAll("#legend li")).map((l) => l.textContent),
          suggestions: Array.from(document.querySelectorAll("#suggest li")).map((l) => l.textContent),
        };
      });
      report[`fleet-${role}-${width}`] = { ...m, text: undefined, errors };
      const near = (a: number, b: number, what: string) => { if (Math.abs(a - b) > 0.5) mismatches.push(`${role}@${width}: ${what}: ${a} vs ${b}`); };
      if (width === 1440) {
        near(m.viewportBottom, m.agentListBottom, "viewport bottom vs agent-list bottom");
        for (const t of m.lowerHeaderTops.slice(1)) near(m.lowerHeaderTops[0], t, "SELECTED / ACTIVITY header tops");
        for (const b of m.row2Bottoms.slice(1)) near(m.row2Bottoms[0], b, "row-2 bottom rule");
        for (const x of m.leftBorderX) near(x, 272, "left column rule");
        for (const x of m.rightBorderX) near(x, width - 352, "right column rule");
        near(m.railBottom, height, "left column reaches the bottom");
        near(m.rightBottom, height, "right column reaches the bottom");
        if (m.composerBottom !== null) assert.ok(m.composerBottom <= height, "composer inside the viewport");
        for (const h of m.camTabs) assert.ok(h >= 42, `camera tabs full height (${h})`);
      } else near(m.scrollWidth, m.width, "no horizontal scroll");
      for (const h of m.rowHeights) near(h, 32, "activity row height");
      for (const b of m.rowBorderLeft) assert.equal(b, "0px", "no left border on rows");
      assert.ok(m.rowSingleLine, "activity rows are single-line");
      for (const [tone, bg] of m.rowTints) if (tone) assert.notEqual(bg, "rgba(0, 0, 0, 0)", `row tinted for ${tone}`);
      assert.deepEqual(errors, []);
      // Role scoping: the attacker never sees fleet size, isolation, recovery or policy data.
      if (role === "attacker") {
        assert.match(m.possession!, /discovered/);
        assert.doesNotMatch(m.text, /\d+ drones,|Isolated|Recovered|policy v|blue holds/i);
        assert.doesNotMatch(m.legend.join(), /Isolated|Recovered/);
      } else assert.match(m.possession!, /blue holds/);
      if (role === "defender") assert.doesNotMatch(m.text, /discovered|Agent \d\d · /i);
      await page.close();
    }
  }
} finally {
  await browser.close();
}
report.mismatches = mismatches;
await writeFile(`${output}/measurements.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (mismatches.length) { console.error("Alignment mismatches:", mismatches); process.exit(1); }
