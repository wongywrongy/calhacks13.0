import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { testDatabase } from "../sandbox/test/spacetime-helper.ts";
import { startService } from "../sandbox/src/service.ts";
const real = process.argv.includes("--real");
const output = `output/conversation-${real ? "real" : "mocked"}`;
await mkdir(output, { recursive: true });
const { outputFiles } = await build({ stdin: { contents: await readFile("web/fleet.ts", "utf8") + `
Object.assign(globalThis, { sceneCheck: () => ({
  epoch: fleetEpoch, selected, frame, camera: camera.position.toArray(), target: controls.target.toArray(),
  terrainVertices: terrain.geometry.attributes.position.count,
  terrainAttached: scene.children.includes(terrain),
  aspect: camera.aspect, width: host.clientWidth, height: host.clientHeight,
  canvasWidth: renderer?.domElement.width, canvasHeight: renderer?.domElement.height,
  points: frame.drones.map(d => shown(d).project(camera).toArray()),
}) });`, resolveDir: process.cwd() + "/web", loader: "ts" }, bundle: true, format: "esm", minify: true, write: false, outfile: "web/dist/fleet.js" });
const original = globalThis.fetch;
let mode = "normal";
const inputs: any[] = [];
if (!real) globalThis.fetch = async (input: any, init?: any) => {
  if (String(input) !== "https://api-inference.bitdeer.ai/v1/chat/completions") return original(input, init);
  const b = JSON.parse(init.body), system = JSON.parse(b.messages[0].content), context = JSON.parse(b.messages[1].content);
  inputs.push({ system, context });
  if (mode === "late") await delay(6000); // Provider response deliberately arrives after cancellation.
  else if (mode === "blocked" || (mode === "blocked-specialists" && !system.agents)) await delay(30000, undefined, { signal: init.signal });
  else await delay(60, undefined, { signal: init.signal });
  if (mode === "failure") return new Response("{}", { status: 429 });
  let value: any;
  if (system.agents) {
    let tasks = [1, 2].map((target, i) => ({ name: i ? "Kestrel" : "Scout", specialty: system.role === "attacker" ? "recon" : "containment", goal: system.role === "attacker" ? "capture" : "recover", objective: system.role === "attacker" ? "Discover then command" : "Isolate then verify", target: context.selectedTarget ?? target }));
    if (system.task.startsWith("Route")) {
      const previous = context.operations.at(-1);
      if (/focus|continue|two agents/i.test(context.message) && previous?.tasks?.length) tasks = previous.tasks.map((t: any, i: number) => ({ ...tasks[i], target: t.target }));
      const question = /\?|what can|how does|what is|why did|which drones/i.test(context.message);
      const active = context.operations.some((o: any) => ["planning", "running"].includes(o.state));
      value = question || active
        ? { intent: active && !question ? "clarify" : "answer", answer: active && !question ? "Stop the current operation before replacing its objective. No change applied." : /what can/i.test(context.message) ? "I can explain this synthetic simulation and deploy bounded security specialists when you give an objective." : `Observed ${context.observations.length} drones; ${context.observations.filter((d: any) => d.controller === "attacker").length} currently compromised. ${previous?.failures?.map((f: any) => f.error).join(", ") || "See committed command outcomes."}`, evidenceIds: context.evidence.slice(-2).map((e: any) => e.id), tasks: [] }
        : { intent: "deploy", answer: "Prepare two specialists.", evidenceIds: [], tasks };
      if (active && /focus/i.test(context.message)) value = { intent: "replace", answer: "Replace the running plan", evidenceIds: [], tasks };
    } else value = { tasks };
  } else value = { kind: system.role === "attacker" ? context.observation.discovered === false ? "discover" : "command" : context.observation.isolated ? "verify" : "isolate" };
  if (!system.agents && system.allowed && !system.allowed.includes(value.kind)) value.kind=system.allowed.find((k:string)=>k!=="wait") ?? "wait";
  return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 70 } });
};
const db = await testDatabase();
const env = { ...process.env, ...db.env, FLEET_PUBLIC_URI: db.env.SPACETIME_URI, SUDOKO_PUBLIC_ORIGIN: "", BITDEER_API_KEY: real ? process.env.BITDEER_API_KEY : "mock-only", SUDOKO_DEMO_MODE: "1" };
const service = await startService({ operatorToken: randomBytes(32).toString("hex"), env });
await service.store.call("start_fleet", [48, 0, 0, false]);
const report: any = { engine: real ? "bitdeer" : "mocked-inference", at: new Date().toISOString(), turns: [], operations: [], latency: [], checks: [] };
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  for (const role of ["attacker", "defender", "observer"]) {
    const viewer: any = await original(db.env.SPACETIME_URI + "/v1/identity", { method: "POST" }).then((r) => r.json());
    await service.store.call("grant_fleet_view", [viewer.identity, role]);
    (env as NodeJS.ProcessEnv)[`SUDOKO_DEMO_${role.toUpperCase()}_VIEWER_TOKEN`] = viewer.token;
  }
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox"] });
  const browserContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await browserContext.route("**/fleet.js", route => route.fulfill({ contentType: "text/javascript", body: outputFiles[0].text }));
  const page = await browserContext.newPage();
  const errors: string[] = [];
  report.consoleErrors = [];
  page.on("console", message => { if (message.type() === "error") report.consoleErrors.push(message.text()); });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(service.url);
  let role = "attacker";
  const switchTo = async (next: string) => {
    role = next;
    await page.locator(`nav [data-role="${role}"]`).click();
    await page.waitForFunction((r) => document.body.dataset.role === r && sessionStorage.getItem("sudoko.role") === r && document.querySelector("#live")?.textContent?.startsWith("Live"), role);
  };
  await switchTo("attacker");
  const scene = async (targetPage = page) => targetPage.evaluate(() => (globalThis as any).sceneCheck());
  const checkScene = async (targetPage = page) => {
    const s = await scene(targetPage);
    assert.ok(s.terrainAttached && s.terrainVertices > 40000, "persistent terrain is built with zero discoveries");
    assert.ok(Math.abs(s.aspect - s.width / s.height) < 0.001, "camera aspect follows layout");
    assert.ok(Math.abs(s.canvasWidth / s.canvasHeight - s.width / s.height) <= (1 + s.width / s.height) / s.canvasHeight, "renderer dimensions follow layout within pixel rounding");
    assert.ok(s.camera.every(Number.isFinite));
    for (const p of s.points) assert.ok(Math.abs(p[0]) < 0.98 && Math.abs(p[1]) < 0.98 && p[2] > -1 && p[2] < 1, `Drone outside viewport: ${JSON.stringify(p)}`);
    return s;
  };
  await checkScene();
  await page.getByRole("button", { name: "Top-down", exact: true }).click();
  await checkScene();
  await page.getByRole("button", { name: "Top-down", exact: true }).click();
  const conversation = async () => {
    const r = await page.request.get(service.url + "/api/chat/conversation", { headers: { "x-sudoko-role": role } });
    assert.equal(r.status(), 200); return r.json();
  };
  const send = async (message: string, wait = true) => {
    await page.locator("#say").fill(message);
    const response = page.waitForResponse((r) => r.url().endsWith("/api/chat/messages") && r.request().method() === "POST");
    const began = Date.now();
    await page.locator("#say").press("Enter");
    const r = await response, body = await r.json();
    assert.equal(r.status(), 202, JSON.stringify(body));
    const timing: any = { message, role, acknowledgmentMs: Date.now() - began };
    assert.ok(timing.acknowledgmentMs < 2500, "Submission blocked on inference");
    assert.ok(body.messages.some((m: any) => m.speaker === "operator" && m.text === message));
    if (body.accepted) {
      assert.ok(body.turns.some((t: any) => t.id === body.accepted.id));
      await page.waitForFunction((text) => document.querySelector("#transcript")?.textContent?.includes(text), message);
      timing.firstVisibleProgressMs = Date.now() - began;
      if (wait) {
        let turn: any, latest: any;
        for (let i = 0; i < 180; i++) {
          const c = await conversation();
          latest = c;
          turn = c.turns.find((t: any) => t.id === body.accepted.id);
          if (turn && !["queued", "running"].includes(turn.state)) break;
          await delay(200);
        }
        assert.equal(turn?.state, "completed", JSON.stringify(turn));
        const reply = latest.messages.find((m: any) => m.key.endsWith(":" + body.accepted.id + ":reply"));
        if (reply) await page.waitForSelector(`#transcript [data-message-id="${reply.id}"]`);
        timing.firstUsefulResponseMs = Date.now() - began;
        timing.serverResponseMs = turn.updatedAt - turn.createdAt;
        report.turns.push(turn);
        report.latency.push(timing);
        return { body, turn, began };
      }
    }
    report.latency.push(timing); return { body, began, turn: undefined };
  };
  const finish = async (turn: any, began: number, outcome: string) => {
    assert.ok(turn.operationId, JSON.stringify(turn));
    let op: any;
    for (let i = 0; i < 400; i++) {
      const r = await page.request.get(`${service.url}/api/chat/operations/${turn.operationId}`, { headers: { "x-sudoko-role": role } });
      op = await r.json();
      if (!["planning", "running"].includes(op.state)) break;
      await delay(200);
    }
    report.operations.push(op);
    assert.equal(op.state, "completed", JSON.stringify(op));
    const actions = op.results.filter((r: any) => r.status === "executed");
    assert.ok(actions.some((r: any) => r.outcome === outcome && r.evidenceId > 0), JSON.stringify(op));
    report.latency.at(-1).firstExecutedActionMs = actions[0].at - began;
    report.latency.at(-1).completionMs = op.transitions.at(-1).at - began;
    await page.waitForFunction(() => document.querySelectorAll(".agent").length > 0);
    return op;
  };
  assert.equal((await service.store.query("SELECT * FROM fleet_agent")).length, 0);
  await send("What can you do?");
  assert.equal((await service.store.query("SELECT * FROM fleet_agent")).length, 0);
  await send("What is the current swarm status?");
  assert.equal((await service.store.query("SELECT * FROM fleet_agent")).length, 0);
  assert.equal((await service.store.query("SELECT * FROM fleet_discovery")).length, 0);
  await page.screenshot({ path: output + "/questions-zero-agents.png" });
  report.checks.push("ordinary and state questions do not deploy; no discovered targets initially");
  await page.getByRole("button", { name: "1. Prepare challenge", exact: true }).click();
  role = "attacker";
  assert.equal(await page.locator("nav [data-role=attacker]").getAttribute("aria-pressed"), "true");
  assert.match(await page.locator("#say").inputValue(), /Discover the simulated fleet/);
  assert.ok(await page.locator("#say").isEditable());
  const attack = await send("Look for vulnerabilities and try taking over the swarm. Use two agents.");
  const attacked = await finish(attack.turn, attack.began, "unauthorized_command_accepted");
  assert.equal(attacked.tasks.length, 2);
  assert.equal(attacked.inferences.filter((i: any) => i.stage === "coordinator").length, 1);
  const epoch = attacked.epoch;
  await page.screenshot({ path: output + "/attacker-executed.png" });
  await page.locator("#judge-guide summary").click();
  const receipt = page.locator("#judge-findings button").filter({ hasText: "unauthorized command accepted" }).first();
  await receipt.waitFor();
  const drone = (await receipt.innerText()).match(/DR-\d+/)![0];
  await receipt.click();
  assert.equal(await receipt.getAttribute("aria-pressed"), "true");
  assert.match(await page.locator("#context-slot").innerText(), new RegExp(drone));
  assert.match(await page.locator("#judge-findings").innerText(), /Agent susceptibility and causal spread are not established/);
  for (const width of [1280, 1366, 1440]) {
    await page.setViewportSize({ width, height: 768 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    for (const selector of ["#compose", "#viewport", "#judge-guide"]) {
      const bounds = await page.locator(selector).boundingBox();
      assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 768, `${selector} must fit laptop height at ${width}`);
    }
  }
  await page.screenshot({ path: output + "/judge-findings-laptop.png" });
  await page.locator("#judge-guide summary").click();
  await page.getByRole("button", { name: "1. Prepare challenge", exact: true }).click();
  report.checks.push("Prepare challenge switches role and supplies editable objective; real database findings select their drone; uncertainty disclaimer; laptop layouts at 1280, 1366 and 1440 pixels");
  const count = (await service.store.query("SELECT * FROM fleet_agent")).length;
  await send("Why did that fail?");
  assert.equal((await service.store.query("SELECT * FROM fleet_agent")).length, count);
  const follow = await send("Focus on those drones. Use two agents.");
  if (follow.turn.intent === "deploy") {
    const focused = await finish(follow.turn, follow.began, "unauthorized_command_accepted");
    assert.deepEqual(focused.tasks.map((t: any) => t.target).sort(), attacked.tasks.map((t: any) => t.target).sort());
  } else assert.equal(follow.turn.intent, "clarify");
  await switchTo("defender");
  assert.ok(!(await page.locator("#transcript").textContent())?.includes("Look for vulnerabilities"));
  await page.getByRole("button", { name: "2. Prepare defense", exact: true }).click();
  role = "defender";
  assert.equal(await page.locator("nav [data-role=defender]").getAttribute("aria-pressed"), "true");
  assert.match(await page.locator("#say").inputValue(), /Investigate the current fleet incident/);
  assert.ok(await page.locator("#say").isEditable());
  const defense = await send("Protect the compromised drones: isolate then verify recovery without blocking legitimate commands. Use two agents.");
  const defended = await finish(defense.turn, defense.began, "recovery_verified");
  assert.equal(defended.epoch, epoch);
  for (const r of defended.results.filter((r: any) => r.outcome === "recovery_verified")) {
    const rows = await service.store.query("SELECT * FROM fleet_evidence");
    assert.deepEqual(r.verificationEvidenceIds.map((id: number) => rows.find((e: any) => e.id === id).status), [403, 200]);
  }
  report.checks.push("fresh recon and takeover; grounded explanation; contextual follow-up; independent same-fleet verified defense");
  await page.screenshot({ path: output + "/defender-recovery.png" });
  await switchTo("attacker");
  mode = "blocked";
  const before = (await service.store.query("SELECT * FROM fleet_chat_action")).length;
  const pending = await send("Inspect the swarm again with two agents", false);
  await send("Stop");
  assert.equal((await conversation()).turns.find((t: any) => t.id === pending.body.accepted.id).state, "cancelled");
  await delay(250);
  assert.equal((await service.store.query("SELECT * FROM fleet_chat_action")).length, before);
  mode = "normal";
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#transcript")?.textContent?.includes("Why did that fail?"));
  assert.ok((await conversation()).operations.some((o: any) => o.id === attacked.id));
  report.checks.push("Stop cancels pending coordinator work before deployment; refresh retains role-scoped history");
  if (!real) {
    mode = "blocked-specialists";
    const running = await send("Inspect the swarm again with two agents");
    await page.waitForSelector(`.agent[data-operation-id="${running.turn.operationId}"][data-state="working"]`);
    const actionCount = (await service.store.query("SELECT * FROM fleet_chat_action")).length;
    const replacement = await send("Focus on those drones. Use two agents.");
    assert.equal(replacement.turn.intent, "replace");
    assert.equal((await conversation()).operations.find((o: any) => o.id === running.turn.operationId).state, "cancelled");
    assert.notEqual(replacement.turn.operationId, running.turn.operationId);
    await page.waitForSelector(`.agent[data-operation-id="${replacement.turn.operationId}"][data-state="working"]`);
    await send("Pause");
    const stopped = (await conversation()).operations.find((o: any) => o.id === replacement.turn.operationId);
    assert.equal(stopped.state, "cancelled");
    await delay(200);
    assert.equal((await service.store.query("SELECT * FROM fleet_chat_action")).length, actionCount);
    mode = "normal";
    const continued = await send("Continue");
    await finish(continued.turn, continued.began, "unauthorized_command_blocked");
    report.checks.push("Active follow-up cancels and joins the prior operation before replacing it; Pause cancels running specialists; Continue validates a new bounded operation from context");
  }
  await service.store.call("start_fleet", [4, 0, 0, true]);
  const hardened = await send("Probe the catalog drones and try an unauthorized command. Use two agents.");
  await finish(hardened.turn, hardened.began, "unauthorized_command_blocked");
  assert.ok((await service.store.query("SELECT * FROM fleet_drone")).every((d: any) => d.controller === "defender"));
  report.checks.push("same catalog attack on hardened fleet yields measured 403, no takeover");
  await page.screenshot({ path: output + "/hardened-denial.png" });
  if (!real) {
    for (const item of inputs.filter((i) => i.system.task.startsWith("Route"))) {
      assert.ok(item.context.history.length <= 12);
      assert.equal(item.context.catalog.discoveryAvailableBeforeObservation, item.system.role === "attacker");
      assert.ok(item.context.catalog.targetIds.length > 0);
      assert.ok(item.context.evidence.length <= 16);
      if (item.system.role === "attacker") assert.ok(item.context.observations.every((d: any) => !("isolated" in d) && !("policyVersion" in d)));
    }
    mode = "failure";
    const failed = await send("How does this simulation work?", false);
    for (let i = 0; i < 40 && (await conversation()).turns.find((t: any) => t.id === failed.body.accepted.id)?.state !== "failed"; i++) await delay(100);
    assert.equal((await conversation()).turns.find((t: any) => t.id === failed.body.accepted.id).error, "provider_rate_limit");
    // Keep the other role open while resetting, including an old HTTP response held past reset.
    const other = await page.context().newPage();
    other.on("pageerror", (e) => errors.push(e.message));
    await other.goto(service.url);
    await other.locator('nav [data-role="defender"]').click();
    await other.waitForFunction(() => document.body.dataset.role === "defender" && (globalThis as any).sceneCheck().frame.drones.length === 4);
    mode = "normal";
    const oldEpoch = (await scene(other)).epoch;
    await other.request.post(service.url + "/api/chat/messages", { headers: { origin: service.url, "x-sudoko-role": "defender", "idempotency-key": "old-defense-question" }, data: { sandbox: db.env.SPACETIME_DATABASE, epoch: oldEpoch, conversation: 1, message: "Old defender session?" } });
    await other.waitForFunction(() => document.querySelector("#transcript")?.textContent?.includes("Old defender session?"));
    const oldDefense = await other.request.get(service.url + "/api/chat/conversation", { headers: { "x-sudoko-role": "defender" } }).then(r => r.json());
    let releaseOld!: () => void;
    let captured!: () => void;
    const held = new Promise<void>(r => { releaseOld = r; });
    const intercepted = new Promise<void>(r => { captured = r; });
    let holdFirst = true;
    await other.route("**/api/chat/conversation?*", async route => {
      if (!holdFirst) return route.continue();
      holdFirst = false;
      captured();
      await held;
      await route.fulfill({ json: oldDefense });
    });
    await intercepted;
    await page.locator('#log .row[role="button"]').first().click();
    assert.ok((await scene()).selected > 0);
    mode = "late";
    const pending = await send("Inspect the swarm with two agents", false);
    const beforeReset = await conversation();
    await page.waitForFunction(() => document.querySelector("#transcript")?.textContent?.includes("Inspect the swarm with two agents"));
    page.once("dialog", (dialog) => void dialog.dismiss());
    await page.getByRole("button", { name: "Reset Demo", exact: true }).click();
    assert.equal((await conversation()).fleet.epoch, beforeReset.fleet.epoch);
    page.once("dialog", (dialog) => void dialog.accept());
    await Promise.all([
      page.waitForResponse(r => r.url().endsWith("/api/chat/reset-demo") && r.request().method() === "POST"),
      page.getByRole("button", { name: "Reset Demo", exact: true }).click(),
    ]);
    await page.waitForFunction(() => document.querySelector("#reset-status")?.textContent?.includes("Demo reset verified"));
    await page.waitForFunction(() => document.querySelector("#live")?.textContent?.startsWith("Live"));
    const reset = await conversation();
    assert.equal(reset.fleet.epoch, beforeReset.fleet.epoch + 1);
    assert.equal(reset.fleet.active, true);
    assert.deepEqual(reset.turns, []);
    assert.deepEqual(reset.messages, []);
    assert.deepEqual(reset.operations, []);
    assert.equal((await service.store.query("SELECT * FROM backend_chat_turn")).find((t: any) => t.id === pending.body.accepted.id).state, "cancelled");
    assert.equal(await page.locator("#transcript .bubble:not(.hint):not(.typing)").count(), 0);
    assert.equal(await page.locator(".agent").count(), 0);
    assert.match(await page.locator("#rail-left").textContent() || "", /No agents deployed/);
    const staleReset = await page.request.post(service.url + "/api/chat/reset", { headers: { origin: service.url, "x-sudoko-role": role }, data: { epoch: beforeReset.fleet.epoch } });
    assert.equal(staleReset.status(), 409);
    const crossSiteReset = await page.request.post(service.url + "/api/chat/reset", { headers: { origin: "https://unrelated.example", "x-sudoko-role": role }, data: { epoch: reset.fleet.epoch } });
    assert.equal(crossSiteReset.status(), 403);
    await delay(300);
    assert.equal((await service.store.query("SELECT * FROM fleet_chat_action")).length, 0);
    assert.equal((await service.store.query("SELECT * FROM fleet_agent")).length, 0);
    assert.equal((await service.store.query("SELECT * FROM agent_schedule")).length, 0);
    assert.equal((await checkScene()).selected, 0);
    assert.equal((await scene()).frame.events.length, 0);
    assert.equal(await page.locator("#log .row").count(), 0);
    await page.screenshot({ path: output + "/sandbox-reset.png" });
    await other.waitForFunction(epoch => (globalThis as any).sceneCheck().epoch === epoch, reset.fleet.epoch);
    releaseOld();
    await delay(1000);
    assert.equal(await other.locator("#transcript .bubble:not(.hint):not(.typing)").count(), 0, "late conversation response must not restore old chat");
    assert.equal(await other.locator(".agent").count(), 0);
    assert.equal((await scene(other)).frame.events.length, 0);
    await checkScene(other);
    await other.screenshot({ path: output + "/reset-defender.png" });
    await other.close();
    const staleMessage = await page.request.post(service.url + "/api/chat/messages", { headers: { origin: service.url, "x-sudoko-role": role, "idempotency-key": "stale-browser" }, data: { epoch: beforeReset.fleet.epoch, conversation: beforeReset.conversation, sandbox: db.env.SPACETIME_DATABASE, message: "Old deployment" } });
    assert.equal(staleMessage.status(), 409);
    mode = "normal";
    const fresh = await send("What can you do in this fresh session?");
    const context = inputs.filter(i => i.system.task.startsWith("Route")).at(-1).context;
    assert.deepEqual(context.operations, []);
    assert.deepEqual(context.evidence, []);
    assert.deepEqual(context.observations, []);
    assert.deepEqual(context.history.map((m: any) => m.text), ["What can you do in this fresh session?"]);
    assert.equal(fresh.turn.state, "completed");
    await switchTo("defender");
    assert.equal(await page.locator("#transcript .bubble:not(.hint):not(.typing)").count(), 0);
    await checkScene();
    await switchTo("observer");
    await page.waitForFunction(() => (globalThis as any).sceneCheck().frame.drones.length === 4);
    await checkScene();
    await page.screenshot({ path: output + "/reset-observer.png" });
    await switchTo("attacker");
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#transcript")?.textContent?.includes("fresh session?"));
    assert.ok(!(await page.locator("#transcript").textContent())?.includes("Why did that fail?"));
    assert.equal((await conversation()).fleet.epoch, reset.fleet.epoch);
    mode = "blocked-specialists";
    const runningAtReset = await send("Deploy two recon specialists");
    await page.waitForSelector(`.agent[data-operation-id="${runningAtReset.turn.operationId}"][data-state="working"]`);
    page.once("dialog", d => void d.accept());
    await Promise.all([page.waitForResponse(r => r.url().endsWith("/api/chat/reset-demo") && r.request().method() === "POST"), page.getByRole("button", { name: "Reset Demo", exact: true }).click()]);
    await page.waitForFunction(() => document.querySelector("#live")?.textContent === "Live · Awaiting objective");
    assert.equal((await conversation()).fleet.epoch, reset.fleet.epoch + 1);
    assert.deepEqual((await conversation()).messages, []);
    assert.equal(await page.locator(".agent").count(), 0);
    await checkScene();
    await page.screenshot({ path: output + "/second-reset-attacker.png" });
    mode = "normal";
    // Zero, one and many visible drones use the same framing controls.
    await switchTo("defender");
    for (const count of [1, 256, 4]) {
      await service.store.call("start_fleet", [count, 0, 0, false]);
      await page.waitForFunction(n => (globalThis as any).sceneCheck().frame.drones.length === n, count);
      for (const size of [{ width: 1440, height: 900 }, { width: 1100, height: 720 }]) {
        await page.setViewportSize(size);
        await delay(150);
        await page.getByRole("button", { name: "Fit", exact: true }).click();
        await checkScene();
        await page.getByRole("button", { name: "Top-down", exact: true }).click();
        await checkScene();
        await page.getByRole("button", { name: "Top-down", exact: true }).click();
      }
    }
    const beforeMotion = await scene();
    await delay(2500);
    const afterMotion = await checkScene();
    assert.deepEqual(afterMotion.camera, beforeMotion.camera, "telemetry must not reset the camera");
    await page.setViewportSize({ width: 1440, height: 900 });
    await delay(150);
    await page.screenshot({ path: output + "/second-reset-defender.png" });
    report.checks.push("Late HTTP responses and cancelled provider replies cannot repopulate sessions; same-epoch role switching and refresh; second reset during specialist execution; zero/one/256-drone Fit and Top-down; renderer resize and stable camera during telemetry");
    report.checks.push("Reset Demo confirms both sides, cancels pending inference, hides historical chat/results, starts zero-agent persistent fleet, and rejects stale/cross-site requests");
    await page.route("**/fleet-config?role=*", async (route) => {
      const response = await route.fetch();
      const config = await response.json();
      await route.fulfill({ response, json: { ...config, uri: "http://127.0.0.1:1" } });
    });
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#live")?.textContent === "Live · Awaiting objective");
    await switchTo("defender");
    await page.waitForFunction(() => document.querySelector("#context")?.textContent?.includes("4 drones"));
    await page.context().setOffline(true);
    await page.waitForFunction(() => document.querySelector("#live")?.textContent === "Disconnected");
    assert.match(await page.locator("#judge-readiness").innerText(), /last known state.*reload to retry/);
    assert.ok(await page.getByRole("button", { name: "1. Prepare challenge", exact: true }).isDisabled());
    await page.context().setOffline(false);
    await page.waitForFunction(() => document.querySelector("#live")?.textContent === "Live · Awaiting objective");
    await page.unroute("**/fleet-config?role=*");
    report.checks.push("Failed WebSockets fall back to authenticated role-scoped HTTPS snapshots; offline freezes state, online recovers without changing fleet/history");
  }
  if (!real) {
    mode = "normal";
    await send("Status");
    const historyBeforeSwarm = await conversation();
    const swarmEpoch = historyBeforeSwarm.fleet.epoch;
    await page.getByRole("button", { name: "Reset Swarm", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#reset-status")?.textContent?.includes("Swarm reset verified"));
    assert.equal((await conversation()).fleet.epoch, swarmEpoch + 1);
    await page.waitForFunction(() => document.querySelector("#transcript")?.textContent?.includes("Status"));
    const roleBeforeNew = role;
    const otherRole = role === "attacker" ? "defender" : "attacker";
    const otherChat = await page.request.get(service.url + "/api/chat/conversation", { headers: { "x-sudoko-role": otherRole } }).then(r => r.json());
    mode = "blocked";
    await send("Pending work before New Chat", false);
    const beforeNew = await conversation();
    await page.getByRole("button", { name: "New Chat", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#reset-status")?.textContent?.includes("New chat started"));
    assert.equal((await conversation()).fleet.epoch, beforeNew.fleet.epoch);
    assert.deepEqual((await conversation()).messages, []);
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#live")?.textContent?.startsWith("Live"));
    assert.equal(await page.locator("#transcript .interaction").count(), 0);
    const otherAfterNew = await page.request.get(service.url + "/api/chat/conversation", { headers: { "x-sudoko-role": otherRole } }).then(r => r.json());
    assert.deepEqual(otherAfterNew.messages, otherChat.messages);
    mode = "normal";
    await send("Status");
    assert.ok(!(await page.locator("#transcript").textContent())?.includes("Pending work before New Chat"));
    assert.equal(role, roleBeforeNew);
    report.checks.push("Reset Swarm preserves chat without navigation; New Chat cancels pending work and survives reload while preserving the other role and fleet");
  }
  if (!real) {
    await page.route("**/api/chat/reset-demo", route => route.fulfill({ status: 503, json: { error: "Reset unavailable (test)" } }));
    page.once("dialog", d => void d.accept());
    await page.getByRole("button", { name: "Reset Demo", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#reset-status")?.textContent?.includes("Reset unavailable (test)"));
    await page.waitForFunction(() => document.querySelector("#live")?.textContent?.startsWith("Live"));
    assert.equal(await page.locator("#reset-sandbox").isEnabled(), true);
    report.checks.push("Failed reset reports the server error and reconnects the interface without a reload");
  }
  assert.deepEqual(errors, []);
  report.inferencePool = service.pool.status();
  report.passed = true;
  console.log(JSON.stringify({ passed: true, engine: report.engine, latency: report.latency, checks: report.checks }, null, 2));
} catch (error) {
  report.error = String(error);
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) await page.screenshot({ path: output + "/failed.png" }).catch(() => {});
  throw error;
} finally {
  await writeFile(output + "/report.json", JSON.stringify(report, null, 2));
  await browser?.close();
  await service.close();
  globalThis.fetch = original;
  await db.close();
}
