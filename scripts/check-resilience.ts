// Real reducers and viewport; inference is explicitly mocked unless --real is supplied.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { testDatabase } from "../sandbox/test/spacetime-helper.ts";
import { startService } from "../sandbox/src/service.ts";

const real = process.argv.includes("--real");
if (real && !process.env.BITDEER_API_KEY) throw Error("Actual model check requires BITDEER_API_KEY; no fixture fallback");
const original = globalThis.fetch;
const inputs: any[] = [];
if (!real) globalThis.fetch = async (input: any, init?: any) => {
  if (String(input) !== "https://api-inference.bitdeer.ai/v1/chat/completions") return original(input, init);
  const body = JSON.parse(init.body), system = JSON.parse(body.messages[0].content), context = JSON.parse(body.messages[1].content);
  inputs.push({ role: system.role, context });
  await delay(60, undefined, { signal: init.signal });
  const tasks = [1, 2].map((target) => ({ name: (system.role === "attacker" ? "Challenge " : "Defense ") + target, specialty: "resilience", target, objective: system.role === "attacker" ? "Disrupt survey work and adapt to rejection" : "Investigate and restore survey participation" }));
  const steps = system.role === "attacker" ? ["discover", "telemetry", "telemetry", "communications", "malfunction", "invalid_command", "mission_conflict", "wait"]
    : ["cross_check", "switch_route", "reject_invalid", "reassign", "cross_check", "restore", "wait", "wait"];
  const value = system.agents ? system.task.startsWith("Route") ? { intent: "deploy", answer: "Prepare bounded resilience specialists.", evidenceIds: [], tasks } : { tasks }
    : { kind: steps[8 - context.decisionsRemaining] };
  return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }] });
};
const output = "output/resilience/" + (real ? "bitdeer" : "mocked");
await mkdir(output, { recursive: true });
const db = await testDatabase();
const env: NodeJS.ProcessEnv = { ...process.env, ...db.env, SUDOKO_DEMO_MODE: "1", SUDOKO_TEST_INFERENCE: real ? "" : "mocked", BITDEER_API_KEY: real ? process.env.BITDEER_API_KEY : "mock-resilience" };
const service = await startService({ operatorToken: randomUUID(), env });
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox"] });
const report: any = { label: "Synthetic resilience simulation", engine: real ? "Bitdeer model decisions" : "Explicitly mocked model decisions / real reducers", passed: false };
const errors: string[] = [];
const pages: any = {};
try {
  for (const role of ["attacker", "defender"]) {
    const viewer: any = await original(db.env.SPACETIME_URI + "/v1/identity", { method: "POST" }).then((r) => r.json());
    await service.store.call("grant_fleet_view", [viewer.identity, role]);env[`SUDOKO_DEMO_${role.toUpperCase()}_VIEWER_TOKEN`] = viewer.token;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();pages[role] = page;page.on("pageerror", (e: any) => errors.push(e.message));
    await page.goto(service.url);await page.locator(`nav button[data-role="${role}"]`).click();
    await page.waitForFunction(() => document.querySelector("#live")?.textContent?.startsWith("Live"));
    assert.match((await page.locator("#context").textContent()) ?? "", /Synthetic resilience simulation/);
  }
  assert.equal((await service.store.query("SELECT * FROM fleet_drone")).length, 6);
  assert.equal((await service.store.query("SELECT * FROM agent_schedule")).length, 0);
  const send = async (role: string, message: string) => {
    const page = pages[role];await page.locator("#say").fill(message);
    const response = page.waitForResponse((r: any) => r.url().endsWith("/api/chat/messages") && r.request().method() === "POST");
    await page.locator("#say").press("Enter");const accepted = await response;assert.equal(accepted.status(), 202);
  };
  await send("attacker", "Challenge the synthetic survey mission on drones 1 and 2. Discover first, try inconsistent telemetry, and adapt to failed actions using a different bounded scenario. Never target an external system.");
  const wait = async (check: () => Promise<boolean>, timeout = 80000) => {
    const end = Date.now() + timeout;while (Date.now() < end) { if (await check()) return;await delay(150); }throw Error("Resilience check timed out");
  };
  await wait(async () => (await service.store.query("SELECT * FROM fleet_evidence")).some((e: any) => e.kind === "challenge_effect"));
  if (!real) await wait(async () => (await service.store.query("SELECT * FROM fleet_evidence")).some((e: any) => e.status === 429));
  await send("defender", "Preserve survey work on drones 1 and 2. Investigate sensor and provenance uncertainty, route around communication failure, reassign malfunctioning tasks, and restore verified participation. Avoid whole-fleet quarantine.");
  await wait(async () => {
    const ops = await service.store.query("SELECT * FROM backend_chat");
    const turns = await service.store.query("SELECT * FROM backend_chat_turn");
    return turns.length >= 2 && turns.every((t: any) => !["queued", "running"].includes(t.state)) && ops.every((o: any) => !["planning", "running"].includes(o.state));
  });
  const conversations: any[] = [];
  for (const role of ["attacker", "defender"]) {
    const page = pages[role];
    const c = await page.request.get(service.url + "/api/chat/conversation", { headers: { "x-sudoko-role": role } }).then((r: any) => r.json());
    conversations.push({ role, operations: c.operations, turns: c.turns });
    await page.screenshot({ path: output + "/" + role + ".png" });
    assert.ok(c.operations.length, `No ${role} operation admitted: ${JSON.stringify(c.turns)}`);
    await page.waitForSelector(".action-card");
    assert.match(await page.locator("#transcript").textContent(), /Intent:.*Observation:.*Action:.*Verified outcome:/s);
    assert.match(await page.locator("#rail-left").textContent(), /Survey mission/);
  }
  report.conversations = conversations;
  await wait(async () => (await service.store.query("SELECT * FROM resilience_mission"))[0].state !== "running", 65000);
  report.mission = (await service.store.query("SELECT * FROM resilience_mission"))[0];
  report.evidence = await service.store.query("SELECT * FROM fleet_evidence");
  report.challengeSuccess = conversations[0].operations.some((o: any) => o.results.some((r: any) => r.verifiedEffectEvidenceId));
  report.defenseSuccess = report.evidence.some((e: any) => e.kind === "participation_restored");
  report.adaptations = conversations[0].operations.flatMap((o: any) => o.workers.flatMap((w: any) => {
    const actions = o.results.filter((r: any) => r.agentId === w.agentId && r.status === "executed");
    return actions.flatMap((r: any, i: number) => r.responseStatus >= 400 && actions[i + 1] && actions[i + 1].kind !== r.kind
      ? [{ agentId: w.agentId, failedAction: r.kind, status: r.responseStatus, nextAction: actions[i + 1].kind, nextStatus: actions[i + 1].responseStatus }] : []);
  }));
  report.adaptation = report.adaptations.length > 0;
  report.errors = errors;
  assert.ok(report.challengeSuccess, "No measured challenge effect; inspect evidence");
  assert.ok(report.defenseSuccess, "No verified restoration; inspect evidence");
  if (!real) assert.ok(report.adaptation, "No failed-action adaptation");
  assert.ok(report.mission.delivered_ms > 0 && report.mission.lost_ms > 0);
  if (!real) assert.equal(report.mission.state, "completed");
  assert.ok(report.mission.detections > 0 && report.mission.recoveries > 0);
  assert.deepEqual(errors, []);
  if (!real) {
    const defenseInputs = inputs.filter((i) => i.role === "defender");
    assert.ok(defenseInputs.every((i) => !(i.context.resilience?.evidence ?? []).some((e: any) => e.kind.startsWith("challenge_"))));
    const challengeInputs = inputs.filter((i) => i.role === "attacker");
    assert.ok(challengeInputs.every((i) => !JSON.stringify(i.context).includes(db.env.SPACETIME_TOKEN)));
    assert.ok(challengeInputs.every((i) => !i.context.resilience?.observations.some((o: any) => "protection" in o)));
  }
  // Reconnect, small-screen layout, full atomic reset and cross-client epoch adoption.
  await pages.defender.reload();await pages.defender.waitForSelector(".action-card");
  await pages.defender.setViewportSize({ width: 390, height: 844 });
  await pages.defender.screenshot({ path: output + "/mobile.png" });
  assert.ok(await pages.defender.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const oldEpoch = report.mission.epoch;
  await pages.attacker.locator("#reset-swarm").click();
  await wait(async () => (await service.store.query("SELECT * FROM fleet_session"))[0].epoch === oldEpoch + 1);
  await pages.attacker.waitForFunction(() => document.querySelector("#reset-status")?.textContent?.includes("reset verified"));
  await pages.defender.waitForFunction(() => !document.querySelector(".action-card"));
  assert.deepEqual(await service.store.query("SELECT * FROM resilience_disruption"), []);
  assert.equal((await service.store.query("SELECT * FROM resilience_mission"))[0].delivered_ms, 0);
  report.passed = true;
  console.log(JSON.stringify({ passed: true, engine: report.engine, challengeSuccess: report.challengeSuccess, defenseSuccess: report.defenseSuccess, adaptation: report.adaptation, mission: report.mission, artifact: output + "/evidence.json" }, null, 2));
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  report.operationRows = await service.store.query("SELECT * FROM backend_chat");
  report.turnRows = await service.store.query("SELECT * FROM backend_chat_turn");
  report.resetState = { mission: (await service.store.query("SELECT * FROM resilience_mission"))[0], evidence: await service.store.query("SELECT * FROM fleet_evidence") };
  report.mission ??= report.resetState.mission;
  report.evidence ??= report.resetState.evidence;
  await writeFile(output + "/evidence.json", JSON.stringify(report, null, 2));
  await browser.close();await service.close();globalThis.fetch = original;await db.close();
}
