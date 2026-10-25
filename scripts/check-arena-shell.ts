import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

// Arena shell layout check against a running demo:fleet (http://127.0.0.1:4174).
// Screenshots per role at 1440x900 and 390x844, plus the alignment measurements.
const base = process.env.FLEET_URL ?? "http://127.0.0.1:4174";
const output = "output/arena-shell";
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
      await page.screenshot({ path: `${output}/${role}-${width}.png` });
      const m = await page.evaluate(() => {
        const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
        const bars = (col: string) => Array.from(document.querySelectorAll<HTMLElement>(`${col} > .bar`)).map((b) => b.getBoundingClientRect());
        const right = document.body.dataset.role === "observer" ? "#rail-right" : "#chat";
        const cols = ["#rail-left", "section.col", right];
        const top = cols.map((c) => bars(c)[0].bottom);
        const lower = cols.map((c) => bars(c)[1].top);
        const bodies = cols.map((c) => document.querySelector<HTMLElement>(`${c} > .body`)!.getBoundingClientRect().bottom);
        return {
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          topHeaderBottoms: top,
          viewportBottom: r("#viewport").bottom,
          bodyBottoms: bodies,
          lowerHeaderTops: lower,
          leftBorderX: r("#rail-left").right,
          rightBorderX: r(right).left,
          headerLeftBorderX: r("#head > .cell.l").right,
          headerRightBorderX: r("#head > .cell.r").left,
          possessionLeftBorderX: r("#possession > .cell.l").right,
          possessionRightBorderX: r("#possession > .cell.r").left,
          railBottom: r("#rail-left").bottom,
          rightBottom: r(right).bottom,
          stepBand: !!document.querySelector("#judge-guide"),
          overlays: document.querySelectorAll("#viewport .ov, #ov-sel, #legend:not(.rule)").length,
          statusIndicators: document.querySelectorAll("#live, .pill, #badge").length,
          resetsOutsideMenu: document.querySelectorAll("#reset-swarm:not(#menu *), #reset-sandbox:not(#menu *)").length,
          text: document.body.innerText,
          possession: { red: document.querySelector("#red-held")!.textContent, right: document.querySelector("#blue-held")!.textContent, label: document.querySelector("#blue-label")!.textContent },
          legend: Array.from(document.querySelectorAll("#legend li")).map((l) => l.textContent),
        };
      });
      report[`${role}-${width}`] = { ...m, text: undefined, errors };
      const near = (a: number, b: number, what: string) => { if (Math.abs(a - b) > 0.5) mismatches.push(`${role}@${width}: ${what}: ${a} vs ${b}`); };
      if (width === 1440) {
        near(m.topHeaderBottoms[0], m.topHeaderBottoms[1], "top header bottoms L/M");
        near(m.topHeaderBottoms[1], m.topHeaderBottoms[2], "top header bottoms M/R");
        near(m.viewportBottom, m.bodyBottoms[0], "viewport bottom vs left body");
        near(m.viewportBottom, m.bodyBottoms[2], "viewport bottom vs right body");
        near(m.lowerHeaderTops[0], m.lowerHeaderTops[1], "lower header tops L/M");
        near(m.lowerHeaderTops[1], m.lowerHeaderTops[2], "lower header tops M/R");
        for (const [k, v] of [["leftBorderX", m.leftBorderX], ["headerLeftBorderX", m.headerLeftBorderX], ["possessionLeftBorderX", m.possessionLeftBorderX]]) near(v as number, 272, `${k}`);
        for (const [k, v] of [["rightBorderX", m.rightBorderX], ["headerRightBorderX", m.headerRightBorderX], ["possessionRightBorderX", m.possessionRightBorderX]]) near(v as number, width - 352, `${k}`);
        near(m.railBottom, height, "left column reaches the bottom");
        near(m.rightBottom, height, "right column reaches the bottom");
      } else near(m.scrollWidth, m.width, "no horizontal scroll");
      assert.equal(m.stepBand, false, "step band removed");
      assert.equal(m.overlays, 0, "no viewport overlays");
      assert.equal(m.statusIndicators, 1, "one status indicator");
      assert.equal(m.resetsOutsideMenu, 0, "resets only in the menu");
      assert.deepEqual(errors, []);
      // Role scoping: attacker never sees fleet size or defense-only data.
      if (role === "attacker") {
        assert.equal(m.possession.label, "Discovered");
        assert.doesNotMatch(m.text, /48 drones|Isolated|Recovered|policy v/i);
      } else assert.equal(m.possession.label, "Blue holds");
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
