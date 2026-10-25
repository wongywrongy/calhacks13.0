import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

// Other pages on the arena shell system: live.html (demo board, BOARD_URL), report.html and
// index.html (any static server over web/, STATIC_URL). Screenshots at 1440x900 and 390x844,
// header 56px, section bars 44px, event rows 32px, no horizontal scroll at 390px.
const board = process.env.BOARD_URL ?? "http://127.0.0.1:4173";
const statics = process.env.STATIC_URL ?? "http://127.0.0.1:4175";
const output = process.env.ARENA_OUTPUT ?? "output/arena-shell-v2";
await mkdir(output, { recursive: true });
const runFile = (await readdir("output/demo").catch(() => [] as string[])).filter((f) => f.endsWith(".json")).map((f) => `output/demo/${f}`).at(-1);
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox"] });
const report: Record<string, any> = {};
const problems: string[] = [];
const measure = (page: import("@playwright/test").Page) => page.evaluate(() => ({
  width: innerWidth,
  scrollWidth: document.documentElement.scrollWidth,
  header: document.querySelector(".page-head")!.getBoundingClientRect().height,
  bars: Array.from(document.querySelectorAll(".bar")).map((b) => b.getBoundingClientRect().height),
  rows: Array.from(document.querySelectorAll(".row, tr[data-event]")).slice(0, 30).map((r) => r.getBoundingClientRect().height),
  tinted: Array.from(document.querySelectorAll(".row[data-tone], tr[data-kind]")).slice(0, 30).map((r) => getComputedStyle(r).backgroundColor),
}));
try {
  const shots: [string, string, (p: import("@playwright/test").Page) => Promise<void>][] = [
    ["live", "attack", async (p) => { await p.goto(board); await p.waitForFunction(() => document.querySelectorAll("#events .event").length > 0, null, { timeout: 60000 }); }],
    ["live", "defense", async (p) => { await p.goto(board); await p.waitForFunction(() => document.querySelectorAll("#events .event").length > 0, null, { timeout: 60000 }); await p.locator("#defense-view").click(); await p.waitForTimeout(300); }],
    ["report", "observer", async (p) => { await p.goto(`${statics}/report.html`); if (runFile) { await p.setInputFiles("#file", runFile); await p.waitForFunction(() => document.querySelectorAll("tr[data-event]").length > 0); } }],
    ["index", "observer", async (p) => { await p.goto(`${statics}/index.html`); for (let i = 0; i < 4; i++) await p.locator("#step").click(); await p.waitForTimeout(500); }],
  ];
  for (const [name, role, setup] of shots) {
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      const page = await browser.newPage({ viewport: { width, height } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await setup(page);
      await page.screenshot({ path: `${output}/${name}-${role}-${width}.png`, fullPage: width === 390 });
      const m = await measure(page);
      report[`${name}-${role}-${width}`] = { ...m, errors };
      if (width === 1440) assert.equal(m.header, 56, `${name}: header 56px`);
      else if (m.scrollWidth > m.width) problems.push(`${name}@390: horizontal scroll ${m.scrollWidth} > ${m.width}`);
      if (width === 1440) for (const h of m.bars) if (Math.abs(h - 44) > 0.5) problems.push(`${name}@${width}: bar ${h}px`);
      for (const h of m.rows) if (Math.abs(h - 32) > 0.5) problems.push(`${name}@${width}: row ${h}px`);
      for (const bg of m.tinted) if (bg === "rgba(0, 0, 0, 0)") problems.push(`${name}@${width}: untinted state row`);
      assert.deepEqual(errors, [], `${name}: no page errors`);
      await page.close();
    }
  }
} finally {
  await browser.close();
}
report.problems = problems;
await writeFile(`${output}/pages.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (problems.length) { console.error("Problems:", problems); process.exit(1); }
