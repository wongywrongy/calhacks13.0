// Exercise the deployed app and its existing database; never start or reset a database here.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";

const origin = new URL(process.argv[2] ?? "https://sudo-ko.us").origin;
assert.ok(origin.startsWith("https://"), "The live smoke check requires the deployed HTTPS app");
const output = "output/resilience-live";
await mkdir(output, { recursive: true });
const report: any = { origin, at: new Date().toISOString(), engine: "Actual deployed Bitdeer decisions", passed: false, conversations: [], errors: [] };
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (error) => report.errors.push(error.message));
const api = async (path: string, role: string, data?: object) => {
  const response = await context.request.fetch(origin + path, { method: data ? "POST" : "GET", headers: { origin, "x-sudoko-role": role, "idempotency-key": randomUUID() }, ...(data ? { data } : {}) });
  assert.ok(response.ok(), `${path} rejected with HTTP ${response.status()}`);
  return response.json();
};
const wait = async (check: () => Promise<boolean>, timeout = 80000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await check()) return;await delay(350); }
  throw Error("Live resilience check timed out; inspect persisted turns and operations");
};
try {
  const config = await api("/fleet-config?role=defender", "defender");
  assert.equal(config.database, process.env.SPACETIME_DATABASE ?? "sudoko-chat-live-20261024");
  assert.equal(config.engine, "bitdeer");assert.ok(config.resilience);
  assert.notEqual(config.token, process.env.SPACETIME_TOKEN, "Owner credential must stay server-side");
  report.connection = { database: config.database, uri: config.uri, epoch: config.epoch, provider: config.engine, models: config.models };
  const initial = await api("/api/chat/state", "defender");
  assert.equal(initial.drones.length, 6);assert.equal(initial.mission.epoch, config.epoch);
  assert.ok(["ready", "running"].includes(initial.mission.state), "Start a fresh mission with the app's Reset Arena control before exercising a completed mission");
  report.initialMission = initial.mission;
  await page.addInitScript(() => sessionStorage.setItem("sudoko.role", "defender"));
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector("#live")?.textContent?.startsWith("Live"));
  assert.match((await page.locator("#context").textContent()) ?? "", /Synthetic resilience simulation/);
  assert.ok(await page.getByRole("button", { name: "Reset Arena", exact: true }).isVisible());
  await page.screenshot({ path: output + "/connected.png" });
  const send = async (role: string, message: string) => {
    const conversation = await api("/api/chat/conversation", role);
    assert.ok(!conversation.operations.some((o: any) => o.epoch === config.epoch && ["planning", "running"].includes(o.state)), "A team already has active work");
    assert.ok(!conversation.turns.some((t: any) => ["queued", "running"].includes(t.state)), "A team has pending inference");
    const result = await api("/api/chat/messages", role, { message, sandbox: config.database, epoch: config.epoch, conversation: conversation.conversation });
    assert.ok(result.accepted?.id, "Missing durable conversation admission");
    return result.accepted.id;
  };
  const attackTurn = await send("attacker", "Deploy two challenge specialists to drones 1 and 2 in this synthetic resilience arena. Discover first, introduce inconsistent telemetry to reduce survey throughput, and adapt to any failed action using the bounded catalog or timing. No external targets.");
  await wait(async () => {
    const conversation = await api("/api/chat/conversation", "attacker"), turn = conversation.turns.find((t: any) => t.id === attackTurn);
    report.attack = conversation;
    assert.notEqual(turn?.state, "failed", JSON.stringify(turn));
    if (turn?.state === "completed") assert.ok(turn.operationId, "Coordinator did not deploy challenge specialists");
    return conversation.operations.some((o: any) => o.turnId === attackTurn && o.results.some((r: any) => r.verifiedEffectEvidenceId));
  });
  const defenseTurn = await send("defender", "Deploy two defense specialists to investigate the observed anomalies on drones 1 and 2. Cross-check sensors and command provenance, apply only the necessary bounded mitigations, and restore verified participation. Preserve survey throughput and avoid unnecessary quarantine.");
  await wait(async () => {
    for (const [role, id] of [["attacker", attackTurn], ["defender", defenseTurn]]) {
      const conversation = await api("/api/chat/conversation", role), turn = conversation.turns.find((t: any) => t.id === id);
      report[role] = conversation;
      assert.notEqual(turn?.state, "failed", JSON.stringify(turn));
      if (turn?.state === "completed") assert.ok(turn.operationId, "Coordinator did not deploy " + role);
      const op = conversation.operations.find((o: any) => o.turnId === id);
      if (!op || ["planning", "running"].includes(op.state)) return false;
    }
    return true;
  });
  const state = await api("/api/chat/state", "defender");
  assert.equal(state.epoch, config.epoch, "Smoke check must preserve the session epoch");
  assert.ok(state.events.some((e: any) => e.kind === "participation_restored"), "No measured defensive restoration");
  report.challengeSuccess = report.attacker.operations.some((o: any) => o.turnId === attackTurn && o.results.some((r: any) => r.verifiedEffectEvidenceId));
  report.defenseSuccess = true;
  await wait(async () => (await api("/api/chat/state", "defender")).mission.state !== "running", 65000);
  const final = await api("/api/chat/state", "defender");report.mission = final.mission;report.evidence = final.events;
  for (const role of ["attacker", "defender"]) {
    await page.locator(`nav [data-role="${role}"]`).click();
    await page.waitForFunction((r) => document.body.dataset.role === r && !!document.querySelector(".action-card"), role);
    await page.screenshot({ path: output + "/" + role + ".png" });
  }
  assert.deepEqual(report.errors, []);report.passed = true;
  console.log(JSON.stringify({ passed: true, origin, connection: report.connection, challengeSuccess: true, defenseSuccess: true, mission: report.mission, artifact: output + "/smoke.json" }, null, 2));
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  await page.screenshot({ path: output + "/failed.png" }).catch(() => {});
  throw error;
} finally {
  report.lastState = await api("/api/chat/state", "defender").catch(() => null);
  for (const role of ["attacker", "defender"]) report.conversations.push({ role, ...await api("/api/chat/conversation", role).catch(() => ({})) });
  await writeFile(output + "/smoke.json", JSON.stringify(report, null, 2));
  await browser.close();
}
