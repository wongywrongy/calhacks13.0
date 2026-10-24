import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { testDatabase } from "../sandbox/test/spacetime-helper.ts";
import { startService } from "../sandbox/src/service.ts";
import { CHAT_LIMITS } from "../sandbox/src/fleet-chat.ts";
const mocked = process.argv.includes("--mock");
if (!mocked && !process.env.BITDEER_API_KEY)
  throw Error(
    "Set the server-side BITDEER_API_KEY; this check never substitutes fixture inference",
  );
await build({
  entryPoints: ["web/fleet.ts"],
  bundle: true,
  format: "esm",
  minify: true,
  outfile: "web/dist/fleet.js",
});
const original = globalThis.fetch;
const modelInputs: any[] = [];
if (mocked)
  globalThis.fetch = async (input: any, init?: any) => {
    if (
      String(input) !== "https://api-inference.bitdeer.ai/v1/chat/completions"
    )
      return original(input, init);
    const body = JSON.parse(init.body),
      system = JSON.parse(body.messages[0].content),
      context = JSON.parse(body.messages[1].content);
    modelInputs.push({ system, context });
    await delay(100, undefined, { signal: init.signal });
    const value = system.agents
      ? {
          tasks: system.agents
            .slice(0, 2)
            .map((agentId: number, i: number) => ({
              agentId,
              target: i + 1,
              objective: "Inspect assigned drone <img src=x onerror=alert(1)>",
            })),
        }
      : {
          kind:
            system.role === "attacker"
              ? context.observation.discovered === false
                ? "discover"
                : "command"
              : context.observation.isolated
                ? "verify"
                : "isolate",
        };
    return Response.json({
      choices: [
        { finish_reason: "stop", message: { content: JSON.stringify(value) } },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
    });
  };
const db = await testDatabase();
const operator = randomBytes(32).toString("hex");
const env = {
  ...process.env,
  ...db.env,
  BITDEER_API_KEY: mocked ? "mock-only" : process.env.BITDEER_API_KEY,
  BITDEER_COORDINATOR_MODEL:
    process.env.BITDEER_COORDINATOR_MODEL || "zai-org/GLM-5.3-Flash",
  BITDEER_SPECIALIST_MODEL:
    process.env.BITDEER_SPECIALIST_MODEL || "zai-org/GLM-5.3-Flash",
  SUDOKO_ATTACKER_TOKEN: randomBytes(32).toString("hex"),
  SUDOKO_DEFENDER_TOKEN: randomBytes(32).toString("hex"),
};
const service = await startService({ operatorToken: operator, env });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const report: any = {
  engine: mocked ? "mocked-inference" : "bitdeer",
  at: new Date().toISOString(),
  models: {
    coordinator: env.BITDEER_COORDINATOR_MODEL,
    specialist: env.BITDEER_SPECIALIST_MODEL,
  },
  limits: CHAT_LIMITS,
  operations: [],
};
const output = mocked ? "output/fleet-chat-mocked" : "output/fleet-chat-smoke";
await mkdir(output, { recursive: true });
try {
  const started = await original(service.url + "/v1/fleet/start", {
    method: "POST",
    headers: {
      authorization: `Bearer ${operator}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      drones: 4,
      attackers: 2,
      defenders: 2,
      hardened: false,
    }),
  });
  assert.equal(started.status, 200);
  const [fleet] = await service.store.query("SELECT * FROM fleet_session");
  report.epoch = fleet.epoch;
  assert.equal(
    (await service.store.query("SELECT * FROM agent_schedule")).length,
    0,
  );
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ["--no-sandbox"],
  });
  const pages: any = {};
  for (const role of ["attacker", "defender"]) {
    const viewer: any = await original(db.env.SPACETIME_URI + "/v1/identity", {
      method: "POST",
    }).then((r) => r.json());
    await service.store.call("grant_fleet_view", [viewer.identity, role]);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const auth = await context.request.post(service.url + "/api/session", {
      headers: { origin: service.url },
      data: { token: viewer.token },
    });
    assert.equal(auth.status(), 200);
    const page = await context.newPage();
    pages[role] = page;
    page.on("dialog", () => {
      throw Error("Model text executed as HTML");
    });
    await page.goto(service.url);
    await page.waitForFunction(
      () => document.querySelector("#status")?.textContent?.startsWith("Live"),
      {},
      { timeout: 15000 },
    );
    assert.equal(
      await page.locator("#role-name").textContent(),
      role === "attacker" ? "Attack" : "Defense",
    );
  }
  const objectives = {
    attacker: "Let's take over the drone swarm. Look for vulnerabilities.",
    defender:
      "Protect the swarm. Investigate suspicious commands and stop unauthorized control without disrupting the mission.",
  };
  for (const role of ["attacker", "defender"] as const) {
    const page = pages[role];
    await page.locator("#say").fill(objectives[role]);
    const response = page.waitForResponse(
      (r: any) =>
        r.url().endsWith("/api/chat/operations") &&
        r.request().method() === "POST",
    );
    await page.locator("#say").press("Enter");
    const start = await response;
    let op = await start.json();
    assert.equal(start.status(), 202, op.error);
    assert.equal(op.epoch, fleet.epoch);
    for (
      let i = 0;
      i < 110 && ["planning", "running"].includes(op.state);
      i++
    ) {
      await delay(500);
      const status = await page.request.get(
        `${service.url}/api/chat/operations/${op.id}`,
      );
      assert.equal(status.status(), 200);
      op = await status.json();
    }
    report.operations.push(op);
    await writeFile(output + "/evidence.json", JSON.stringify(report, null, 2));
    assert.ok(
      ["completed", "failed"].includes(op.state),
      `${role} operation ended as ${op.state}`,
    );
    assert.ok(op.tasks.length >= 2);
    const outcome =
      role === "attacker"
        ? "unauthorized_command_accepted"
        : "recovery_verified";
    assert.ok(
      op.results.some((r: any) => r.outcome === outcome && r.evidenceId > 0),
      `Expected measured ${outcome}`,
    );
    await page.waitForFunction(
      (id: string) =>
        document.querySelector("#transcript")?.textContent?.includes(id),
      op.id,
    );
    await page.waitForFunction(
      (expected: string) =>
        document.querySelector("#transcript")?.textContent?.includes(expected),
      outcome,
    );
    await page.waitForFunction(
      (state: string) =>
        document
          .querySelector("#transcript")
          ?.textContent?.includes("· " + state + " ·"),
      op.state,
    );
    assert.equal(await page.locator("#transcript img").count(), 0);
    await page.screenshot({ path: output + `/${role}.png` });
    const other = pages[role === "attacker" ? "defender" : "attacker"];
    assert.equal(
      (
        await other.request.get(`${service.url}/api/chat/operations/${op.id}`)
      ).status(),
      404,
    );
    const before = (
      await service.store.query("SELECT * FROM fleet_chat_action")
    ).length;
    await page.reload();
    await page.waitForFunction(
      (id: string) =>
        document.querySelector("#transcript")?.textContent?.includes(id),
      op.id,
    );
    assert.equal(
      (await service.store.query("SELECT * FROM fleet_chat_action")).length,
      before,
    );
  }
  const final = await service.store.query("SELECT * FROM fleet_drone");
  const evidence = await service.store.query("SELECT * FROM fleet_evidence");
  for (const recovered of report.operations[1].results.filter(
    (r: any) => r.outcome === "recovery_verified",
  )) {
    assert.equal(
      final.find((d: any) => d.id === recovered.target).controller,
      "defender",
    );
    assert.equal(
      evidence.find((e: any) => e.id === recovered.verificationEvidenceIds[0])
        .status,
      403,
    );
    assert.equal(
      evidence.find((e: any) => e.id === recovered.verificationEvidenceIds[1])
        .status,
      200,
    );
  }
  assert.equal(
    (await service.store.query("SELECT * FROM fleet_session"))[0].epoch,
    fleet.epoch,
  );
  report.providerErrors = report.operations.flatMap((o: any) =>
    o.inferences
      .filter((i: any) => i.error)
      .map((i: any) => ({
        operationId: o.id,
        agentId: i.agentId,
        error: i.error,
      })),
  );
  assert.ok(
    report.operations.every((o: any) => o.state === "completed"),
    "Effects were committed, but a model worker failed; inspect saved operation evidence",
  );
  report.evidence = evidence;
  report.finalDrones = final;
  report.inferencePool = service.pool.status();
  report.passed = true;
  report.totalCalls = report.operations.reduce(
    (n: number, o: any) => n + o.inferences.length,
    0,
  );
  report.usage = report.operations
    .flatMap((o: any) => o.inferences)
    .reduce(
      (sum: any, c: any) => ({
        prompt_tokens: sum.prompt_tokens + (c.usage?.prompt_tokens || 0),
        completion_tokens:
          sum.completion_tokens + (c.usage?.completion_tokens || 0),
        total_tokens: sum.total_tokens + (c.usage?.total_tokens || 0),
      }),
      { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    );
  console.log(
    JSON.stringify(
      {
        engine: report.engine,
        passed: true,
        models: report.models,
        operationIds: report.operations.map((o: any) => o.id),
        totalCalls: report.totalCalls,
        usage: report.usage,
        evidenceIds: evidence.map((e: any) => e.id),
        artifact: output + "/evidence.json",
      },
      null,
      2,
    ),
  );
} finally {
  await writeFile(output + "/evidence.json", JSON.stringify(report, null, 2));
  await browser?.close();
  await service.close();
  globalThis.fetch = original;
  await db.close();
}
