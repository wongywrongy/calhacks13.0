import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const local = process.argv.includes("--local-assets");
const send = process.argv.includes("--send");
assert.ok(!(local && send), "Model smoke must run on the deployed assets");
const origin = "https://sudo-ko.us";
const output = `output/judge-${local ? "preflight" : "production"}`;
await mkdir(output, { recursive: true });
const report: any = { origin, at: new Date().toISOString(), localAssets: local, passed: false, errors: [], checks: [] };
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await context.newPage();
page.on("pageerror", (error) => report.errors.push(error.message));
const api = async (path: string, role = "defender") => {
  const response = await context.request.get(origin + path, { headers: { "x-sudoko-role": role } });
  assert.ok(response.ok(), `${path}: HTTP ${response.status()}`);
  return response.json();
};
try {
  if (local) for (const [path, file, contentType] of [["/", "index.html", "text/html"], ["/fleet.js", "fleet.js", "text/javascript"]]) {
    await page.route(origin + path, async (route) => route.fulfill({ body: await readFile("output/vercel-static/" + file), contentType }));
  }
  await page.addInitScript(() => sessionStorage.setItem("sudoko.role", "defender"));
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector("#live")?.textContent?.startsWith("Live"), { timeout: 30000 });
  const config = await api("/fleet-config?role=defender");
  assert.equal(config.engine, "bitdeer");
  const initial = await api("/api/chat/state");
  assert.ok(initial.drones.length > 0, "Live database must return drones");
  report.connection = { database: config.database, engine: config.engine, models: config.models, epoch: config.epoch, drones: initial.drones.length };
  for (const [role, name, objective] of [["attacker", "1. Prepare challenge", /Discover the simulated fleet/], ["defender", "2. Prepare defense", /Investigate the current fleet incident/]] as const) {
    await page.getByRole("button", { name, exact: true }).click();
    await page.waitForFunction(({ role, pattern }) => document.body.dataset.role === role && new RegExp(pattern).test((document.querySelector("#say") as HTMLInputElement).value), { role, pattern: objective.source });
    assert.match(await page.locator("#say").inputValue(), objective);
    assert.ok(await page.locator("#say").isEditable());
  }
  report.checks.push("Both guided controls switch roles and fill editable objectives against production");
  await page.locator("#judge-guide summary").click();
  const state = await api("/api/chat/state");
  if (state.events.length) {
    const evidence = state.events.at(-1);
    const button = page.locator(`#judge-findings [data-evidence-id="${evidence.id}"]`);
    await button.waitFor();
    await button.click();
    assert.equal(await button.getAttribute("aria-pressed"), "true");
    assert.match(await page.locator("#context-slot").innerText(), new RegExp("DR-" + String(evidence.drone).padStart(3, "0")));
    report.evidence = { id: evidence.id, drone: evidence.drone, kind: evidence.kind };
  } else throw Error("No persisted evidence is available to verify selection");
  assert.match(await page.locator("#judge-findings").innerText(), /Agent susceptibility and causal spread are not established/);
  for (const width of [1280, 1366, 1440]) {
    await page.setViewportSize({ width, height: 768 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    for (const selector of ["#compose", "#viewport", "#judge-guide"]) {
      const bounds = await page.locator(selector).boundingBox();
      assert.ok(bounds && bounds.height > 0 && bounds.y >= 0 && bounds.y + bounds.height <= 768, `${selector} must fit ${width}x768`);
    }
  }
  await page.screenshot({ path: output + "/findings-laptop.png" });
  await page.locator("#judge-guide summary").click();
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  const before = await api("/api/chat/conversation");
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("button", { name: "Reset sandbox", exact: true }).click();
  assert.equal((await api("/api/chat/conversation")).fleet.epoch, before.fleet.epoch);
  report.checks.push("Database evidence selects its drone; uncertainty remains explicit; laptop layouts fit; canceling reset preserves the epoch");
  if (send) {
    assert.ok(!before.turns.some((t: any) => ["queued", "running"].includes(t.state)), "Existing inference is active");
    assert.ok(!before.operations.some((o: any) => ["planning", "running"].includes(o.state)), "Existing agents are active");
    const message = "What does the currently visible fleet evidence establish? Answer briefly from observations only. Do not deploy agents or change the shared fleet.";
    await page.locator("#say").fill(message);
    const response = page.waitForResponse((r) => r.url().endsWith("/api/chat/messages") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const admission = await response, body = await admission.json();
    assert.equal(admission.status(), 202, JSON.stringify(body));
    assert.ok(body.accepted?.id);
    await page.waitForFunction(async (id) => {
      const r = await fetch("/api/chat/conversation", { headers: { "x-sudoko-role": "defender" } });
      const c = await r.json();
      return c.turns.some((t: any) => t.id === id && !["queued", "running"].includes(t.state));
    }, body.accepted.id, { timeout: 45000 });
    const after = await api("/api/chat/conversation");
    const turn = after.turns.find((t: any) => t.id === body.accepted.id);
    report.modelTurn = turn;
    assert.equal(turn?.state, "completed", JSON.stringify(turn));
    assert.equal(turn.intent, "answer", "The bounded smoke must remain read-only");
    assert.equal(after.operations.length, before.operations.length);
    assert.equal(after.fleet.epoch, before.fleet.epoch);
    const reply = after.messages.find((m: any) => m.turnId === turn.id && m.kind === "answer");
    assert.ok(reply?.text, "Missing persisted model answer");
    await page.waitForFunction((text) => document.querySelector("#transcript")?.textContent?.includes(text), reply.text);
    report.modelReply = reply.text;
    report.checks.push("One actual Bitdeer answer: Send → admitted turn → completed inference → persisted reply → browser; no agents or reset");
  }
  await page.screenshot({ path: output + "/connected.png" });
  assert.deepEqual(report.errors, []);
  report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.failure = String(error);
  await page.screenshot({ path: output + "/failed.png" }).catch(() => {});
  throw error;
} finally {
  await writeFile(output + "/report.json", JSON.stringify(report, null, 2));
  await browser.close();
}
