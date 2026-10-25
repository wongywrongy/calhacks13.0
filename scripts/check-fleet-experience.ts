import { FLEET } from "../shared/fleet.ts";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { testDatabase } from "../sandbox/test/spacetime-helper.ts";
import { startService } from "../sandbox/src/service.ts";

// Real reducers and receipts; inference is explicitly mocked for repeatable UX cases.
const output = "output/fleet-experience";
await mkdir(output, { recursive: true });
await build({ entryPoints: ["web/fleet.ts"], bundle: true, format: "esm", outfile: "web/dist/fleet.js" });
const original = globalThis.fetch;
let mode = "normal", held = true, calls = 0;
globalThis.fetch = async (input: any, init?: any) => {
  if (String(input) !== "https://api-inference.bitdeer.ai/v1/chat/completions") return original(input, init);
  calls++;
  const body = JSON.parse(init.body), system = JSON.parse(body.messages[0].content), context = JSON.parse(body.messages[1].content);
  while (held && !system.agents) await delay(50, undefined, { signal: init.signal });
  await delay(120, undefined, { signal: init.signal });
  const value = system.agents ? /\?/.test(context.message)
    ? { intent: "answer", answer: "This synthetic fleet supports scoped containment and verified recovery.", evidenceIds: [], tasks: [] }
    : { intent: "deploy", answer: "Prepare specialists", evidenceIds: [], tasks: ["Sentinel", "Warden"].map((name, i) => ({
      name, specialty: "Containment", target: mode === "partial" ? 1 : i + 1,
      objective: "Contain the assigned drone and verify unauthorized denial and legitimate control. " + "Retain measured evidence for the operator. ".repeat(4),
    })) }
    : { kind: context.observation.isolated ? "verify" : "isolate" };
  return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }] });
};
const db = await testDatabase();
const env = { ...process.env, ...db.env, FLEET_PUBLIC_URI: db.env.SPACETIME_URI, SUDOKO_PUBLIC_ORIGIN: "", BITDEER_API_KEY: "mock-only", SUDOKO_DEMO_MODE: "1" };
const service = await startService({ operatorToken: randomBytes(32).toString("hex"), env });
await service.store.call("start_fleet", [FLEET.drones, 0, 0, false]);
const call = service.store.call.bind(service.store);
service.store.call = async (name, args) => {
  if (mode === "partial" && name === "execute_fleet_chat_action") {
    const [row] = await service.store.query(`SELECT * FROM backend_chat WHERE id='${args[1]}'`);
    const task = JSON.parse(row.config).tasks.find((t: any) => t.agentId === args[3]);
    // Exercise a real stale-policy rejection for one worker; the other can recover.
    if (task.name === "Warden") args = [...args.slice(0, 6), Number(args[6]) + 1];
  }
  return call(name, args);
};
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const report: any = { inference: "explicitly mocked", database: "real local SpacetimeDB", checks: [] };
try {
  for (const role of ["attacker", "defender"]) {
    const viewer: any = await original(db.env.SPACETIME_URI + "/v1/identity", { method: "POST" }).then((r) => r.json());
    await call("grant_fleet_view", [viewer.identity, role]);
    (env as NodeJS.ProcessEnv)[`SUDOKO_DEMO_${role.toUpperCase()}_VIEWER_TOKEN`] = viewer.token;
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(service.url);
  await page.locator('nav [data-role="defender"]').click();
  await page.waitForFunction(() => document.body.dataset.role === "defender" && document.querySelector("#live")?.textContent?.startsWith("Live"));
  const conversation = () => page.request.get(service.url + "/api/chat/conversation", { headers: { "x-sudoko-role": "defender" } }).then((r) => r.json());
  let pendingTurnId = "";
  const send = async (message: string) => {
    await page.locator("#say").fill(message);
    const response = page.waitForResponse((r) => r.url().endsWith("/api/chat/messages") && r.request().method() === "POST");
    await page.locator("#say").press("Enter");
    const r = await response;
    assert.equal(r.status(), 202);
    const body = await r.json();
    if (body.accepted) pendingTurnId = body.accepted.id;
    return body;
  };
  const waitOp = async (terminal = true) => {
    for (let i = 0; i < 150; i++) {
      const c = await conversation(), op = c.operations.find((o: any) => o.turnId === pendingTurnId);
      if (op && (terminal ? !["running", "planning"].includes(op.state) : op.workers.length === 2)) return op;
      await delay(100);
    }
    assert.fail("Operation did not reach the expected phase");
  };
  await send("What is the status of our fleet?");
  assert.equal((await conversation()).operations.length, 0);
  assert.equal(calls, 0);
  await page.waitForFunction(() => document.querySelector("#transcript")?.textContent?.includes("currently compromised"));
  assert.match(await page.locator("#transcript").innerText(), new RegExp(`${FLEET.drones} drones; 0 currently compromised`));
  report.checks.push("Exact fleet-status question is read-only, concise and uses no model call");
  const accepted = await send("Deploy two agents to contain affected drones and verify control.");
  const running = await waitOp(false);
  const group = page.locator(`[data-origin-id="${running.messageId}"]`);
  await group.locator(".deployment").waitFor();
  assert.equal(await group.locator(".interaction-progress:visible").count(), 1);
  assert.equal(await group.locator(".deployment li").count(), 2);
  const progress = await group.locator(".interaction-progress").elementHandle();
  await send("What is the status of our fleet?");
  assert.equal((await conversation()).operations.length, 1);
  await delay(300);
  assert.ok(await progress!.evaluate((node) => node.isConnected));
  held = false;
  const complete = await waitOp();
  assert.equal(complete.outcome.status, "Completed");
  assert.equal(complete.outcome.succeeded, 2);
  await group.locator('.outcome[data-status="Completed"]').waitFor();
  assert.equal(await group.locator(".interaction-progress:visible").count(), 0);
  assert.doesNotMatch(await page.locator("#transcript").innerText(), /Message accepted|Validated assignments|No fixture fallback|Deployment accepted/);
  await page.screenshot({ path: output + "/chat.png" });
  for (const w of complete.workers) {
    const card = page.locator(`.agent[data-agent-id="${w.agentId}"]`);
    await card.click();
    await page.locator("#modal").waitFor({ state: "visible" });
    assert.equal(await page.locator("#modal-name").innerText(), w.name);
    assert.equal(await page.locator("#modal-state").innerText(), "Completed");
    assert.match(await page.locator("#modal-target").innerText(), new RegExp(`DR-00${w.target}`));
    assert.equal(await page.locator(`#modal-log [data-agent-id]:not([data-agent-id="${w.agentId}"])`).count(), 0);
    const times = await page.locator("#modal-log [data-timestamp]").evaluateAll((nodes) => nodes.map((n) => Number((n as HTMLElement).dataset.timestamp)));
    assert.deepEqual(times, [...times].sort((a, b) => a - b));
    assert.ok(times.every((t) => Math.abs(t / 1000 - Date.now()) < 60000));
    assert.doesNotMatch(await page.locator("#modal-log").innerText(), /NaN|−|\d:-/);
    assert.match(await page.locator("#modal-log .t").first().innerText(), /^\d{2}:\d{2}:\d{2} UTC$/);
    await page.screenshot({ path: `${output}/agent-${w.name.toLowerCase()}.png` });
    if (w.target === 1) {
      await page.locator("#modal-target button").click();
      assert.match(await page.locator("#context-slot").innerText(), /DR-001/);
      await card.click();
    }
    await page.keyboard.press("Escape");
    assert.ok(await card.evaluate((n) => n === document.activeElement));
  }
  report.checks.push("Two-agent deployment, one stable updating progress row, verified recovery, IDs, targets, chronological UTC timestamps and Escape focus return");
  mode = "partial";
  await send("Deploy two agents to verify DR-001 again.");
  const partial = await waitOp();
  assert.equal(partial.outcome.status, "Partially completed");
  assert.equal(partial.outcome.succeeded, 1);
  const failed = partial.workers.find((w: any) => w.state === "failed");
  assert.equal(failed.error, "stale_policy");
  await page.locator(`[data-origin-id="${partial.messageId}"] .outcome[data-status="Partially completed"]`).waitFor();
  await page.locator(`.agent[data-agent-id="${failed.agentId}"]`).click();
  assert.equal(await page.locator("#modal-state").innerText(), "Failed");
  assert.match(await page.locator("#modal-result").innerText(), /policy changed/);
  assert.match(await page.locator("#modal-current").innerText(), /authorized control.*Recovery was verified by Sentinel/);
  assert.equal(await page.locator(`#modal-log [data-agent-id]:not([data-agent-id="${failed.agentId}"])`).count(), 0);
  assert.match(await page.locator("#modal-name").innerText(), /Warden · DR-001/);
  await page.screenshot({ path: output + "/agent-failed.png" });
  await page.locator("#modal-details summary").click();
  assert.match(await page.locator("#modal-details").innerText(), /stale_policy/);
  await page.setViewportSize({ width: 390, height: 620 });
  await page.locator(".dialog").evaluate((n) => n.scrollTop = 220);
  const top = await page.locator(".dialog").evaluate((n) => n.scrollTop);
  await delay(1400);
  assert.ok(Math.abs(await page.locator(".dialog").evaluate((n) => n.scrollTop) - top) < 2);
  assert.ok(await page.locator("#modal-details details").evaluate((n) => (n as HTMLDetailsElement).open));
  const bounds = await page.locator(".dialog").boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 390 && bounds.y + bounds.height <= 620);
  assert.ok(await page.locator(".dialog").evaluate((n) => n.scrollHeight > n.clientHeight));
  await page.screenshot({ path: output + "/agent-narrow-details.png" });
  await page.locator("#modal-close").click();
  await page.setViewportSize({ width: 1440, height: 900 });
  const before = await conversation();
  await page.reload();
  await page.locator(`[data-origin-id="${partial.messageId}"] .outcome`).waitFor();
  const after = await conversation();
  assert.deepEqual(after.messages.map((m: any) => [m.id, m.replyTo, m.turnId, m.operation]), before.messages.map((m: any) => [m.id, m.replyTo, m.turnId, m.operation]));
  const ids = await page.locator(".interaction").evaluateAll((nodes) => nodes.map((n) => Number((n as HTMLElement).dataset.originId)));
  assert.deepEqual(ids, before.messages.filter((m: any) => m.speaker === "operator").map((m: any) => m.id));
  assert.equal(new Set(ids).size, ids.length);
  for (const w of [...complete.workers, ...partial.workers]) {
    await page.locator(`.agent[data-agent-id="${w.agentId}"]`).click();
    assert.equal(await page.locator(`#modal-log [data-agent-id]:not([data-agent-id="${w.agentId}"])`).count(), 0);
    assert.match(await page.locator("#modal-name").innerText(), new RegExp(w.name + " · DR-"));
    await page.locator("#modal-close").focus();
    await page.keyboard.press("Shift+Tab");
    assert.ok(await page.locator("#modal-details summary").evaluate((n) => n === document.activeElement));
    await page.keyboard.press("Tab");
    assert.ok(await page.locator("#modal-close").evaluate((n) => n === document.activeElement));
    await page.keyboard.press("Escape");
  }
  await page.locator(`[data-origin-id="${partial.messageId}"]`).scrollIntoViewIfNeeded();
  await page.screenshot({ path: output + "/chat-partial.png" });
  const beforeQuestion = await conversation();
  const question = await send("How does containment work?");
  await page.locator(`[data-origin-id="${question.messages.findLast((m: any) => m.speaker === "operator").id}"] .interaction-response .bubble`).waitFor();
  assert.equal((await conversation()).operations.length, beforeQuestion.operations.length);
  assert.match(await page.locator("#transcript").innerText(), /This synthetic fleet supports scoped containment/);
  report.checks.push("Real stale-policy failure and recovery by another agent, accurate partial outcome, duplicate names across operations, refresh associations and ordering, narrow viewport, long assignment, scroll stability, focus trap and natural read-only answers");
  assert.equal(accepted.accepted.id, complete.turnId);
  assert.deepEqual(errors, []);
  report.operations = [complete, partial];
  report.passed = true;
  console.log(JSON.stringify({ passed: true, checks: report.checks }, null, 2));
} catch (e) {
  report.error = String(e);
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) await page.screenshot({ path: output + "/failed.png" }).catch(() => {});
  throw e;
} finally {
  await writeFile(output + "/report.json", JSON.stringify(report, null, 2));
  held = false;
  await browser?.close();
  await service.close();
  globalThis.fetch = original;
  await db.close();
}
