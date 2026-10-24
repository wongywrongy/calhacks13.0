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
const demo = process.argv.includes("--demo");
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
let providerMode = "normal";
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
    if (providerMode === "blocked" || (providerMode === "blocked-specialists" && !system.agents))
      await delay(30000, undefined, { signal: init.signal });
    else await delay(100, undefined, { signal: init.signal });
    if (providerMode === "rate-limit")
      return new Response("{}", { status: 429 });
    let value: any = system.agents
      ? {
          tasks: [0, 1].map((i: number) => ({
              name: "Kestrel",
              specialty: system.role === "attacker" ? "reconnaissance" : "containment",
              target: context.selectedTarget ?? i + 1,
              objective: "Assess assigned drone <img src=x onerror=alert(1)>",
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
    if (system.task?.startsWith("Route") && value.tasks) value = { intent: "deploy", answer: "Prepare specialists", evidenceIds: [], tasks: value.tasks };
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
  SUDOKO_DEMO_MODE: demo ? "1" : "0",
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
const browserErrors: string[] = [];
report.layout = [];
const output = demo
  ? mocked ? "output/fleet-demo-mocked" : "output/fleet-demo-smoke"
  : mocked
    ? "output/fleet-ui-mocked"
    : "output/fleet-ui-smoke";
await mkdir(output, { recursive: true });
try {
  let fleet: any;
  assert.equal(
    (await service.store.query("SELECT * FROM fleet_session")).length,
    1,
  );
  assert.equal((await service.store.query("SELECT * FROM fleet_agent")).length, 0);
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
    (env as NodeJS.ProcessEnv)[
      `SUDOKO_DEMO_${role.toUpperCase()}_VIEWER_TOKEN`
    ] = viewer.token;
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    if (!demo) {
      const auth = await context.request.post(service.url + "/api/session", {
        headers: { origin: service.url },
        data: { token: viewer.token },
      });
      assert.equal(auth.status(), 200);
    }
    const page = await context.newPage();
    pages[role] = page;
    page.on("pageerror", (error: any) => browserErrors.push(error.message));
    page.on("dialog", () => {
      throw Error("Model text executed as HTML");
    });
    await page.goto(service.url);
    await page.waitForFunction(
      () => document.querySelector("#live")?.textContent?.startsWith("Live"),
      {},
      { timeout: 15000 },
    );
    if (demo) {
      await page.locator(`nav button[data-role="${role}"]`).click();
      await page.waitForFunction(
        (r: string) =>
          document.body.dataset.role === r &&
          document.querySelector("#chat-name")?.textContent ===
            (r === "attacker" ? "Crimson" : "Sentinel"),
        role,
      );
      assert.equal(await page.locator('#error a[href="/signin"]').count(), 0);
    }
    assert.equal(
      await page.locator("#chat-name").textContent(),
      role === "attacker" ? "Crimson" : "Sentinel",
    );
  }
  if (demo) {
    assert.equal(
      (await original(service.url + "/fleet-config?role=operator")).status,
      403,
    );
    assert.equal(
      (
        await original(service.url + "/api/chat/conversation", {
          headers: { "x-sudoko-role": "operator" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await original(service.url + "/fleet-config?role=attacker", {
          headers: { origin: "https://untrusted.example" },
        })
      ).status,
      403,
    );
  }
  assert.equal(await pages.defender.locator(".agent").count(), 0);
  assert.match(await pages.defender.locator("#rail-left").textContent(), /No agents deployed/);
  await pages.defender.screenshot({ path: output + "/fresh-session.png" });
  const dimensions = async (page: any, label: string) => {
    const result = await page.evaluate(() => {
      const rect = (selector: string) => {
        const e = document.querySelector(selector)! as HTMLElement;
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, scrollHeight: e.scrollHeight, clientHeight: e.clientHeight };
      };
      const canvas = document.querySelector("#viewport canvas")! as HTMLCanvasElement;
      return { size: [innerWidth, innerHeight], pageHeight: document.documentElement.scrollHeight,
        bodyRows: getComputedStyle(document.body).gridTemplateRows,
        main: rect("main"), viewport: rect("#viewport"), log: rect(".log"), rail: rect("#rail-left"), chat: rect("#chat"),
        controls: rect(".ov.bl"), legend: rect("#legend"), canvas: { width: canvas.width, height: canvas.height } };
    });
    assert.equal(result.pageHeight, result.size[1]);
    assert.ok(result.main.y + result.main.height >= result.size[1] - 1);
    assert.ok(result.viewport.height > result.log.height * 1.5);
    assert.ok(result.log.height <= 240);
    for (const box of [result.controls, result.legend]) {
      assert.ok(box.y >= result.viewport.y);
      assert.ok(box.y + box.height <= result.viewport.y + result.viewport.height);
    }
    assert.ok(Math.abs(result.canvas.width / result.canvas.height - result.viewport.width / result.viewport.height) < 0.01);
    report.layout.push({ label, ...result });
    await page.screenshot({ path: output + `/${label}.png` });
  };
  for (const [width, height] of [[1440, 900], [1920, 1080], [1200, 800]]) {
    await pages.defender.setViewportSize({ width, height });
    await delay(300);
    await dimensions(pages.defender, `fresh-${width}x${height}`);
  }
  await pages.defender.setViewportSize({ width: 1440, height: 900 });
  await delay(5500);
  assert.match(await pages.attacker.locator("#live").textContent(), /Awaiting objective/);

  assert.ok(
    !(await pages.attacker.locator("#clock").textContent()).includes("1:00"),
  );
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
        r.url().endsWith("/api/chat/messages") &&
        r.request().method() === "POST",
    );
    await page.locator("#say").press("Enter");
    const start = await response;
    const conversation = await start.json();
    let op = conversation.operations?.at(-1);
    if (conversation.accepted) for (let i = 0; i < 150; i++) {
      const c = await page.request.get(service.url + "/api/chat/conversation", { headers: { "x-sudoko-role": role } }).then((r: any) => r.json());
      const turn = c.turns.find((t: any) => t.id === conversation.accepted.id);
      if (turn?.error) throw Error(JSON.stringify(turn));
      if (turn?.operationId) { op = c.operations.find((o: any) => o.id === turn.operationId); break; }
      await delay(200);
    }
    assert.equal(start.status(), 202, conversation.error);
    fleet ??= (await service.store.query("SELECT * FROM fleet_session"))[0];
    report.epoch = fleet.epoch;
    assert.equal(fleet.deadline, 0);
    assert.equal(op.epoch, fleet.epoch);
    for (
      let i = 0;
      i < 170 && ["planning", "running"].includes(op.state);
      i++
    ) {
      await delay(500);
      const status = await page.request.get(
        `${service.url}/api/chat/operations/${op.id}`,
        { headers: { "x-sudoko-role": role } },
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
    assert.ok(op.tasks.every((t: any) => t.name && t.name.length <= 32));
    assert.equal(new Set(op.tasks.map((t: any) => t.name.toLowerCase())).size, op.tasks.length);
    const outcome =
      role === "attacker"
        ? "unauthorized_command_accepted"
        : "recovery_verified";
    assert.ok(
      op.results.some((r: any) => r.outcome === outcome && r.evidenceId > 0),
      `Expected measured ${outcome}`,
    );
    await page.waitForFunction(
      (state: string) =>
        document.querySelector("#chat-sub")?.textContent === state,
      op.state,
    );
    assert.match(
      await page.locator("#transcript").textContent(),
      /Validated assignments/,
    );
    assert.match(
      await page.locator("#transcript").textContent(),
      /Operation completed/,
    );
    assert.ok(
      !(await page.locator("#transcript").textContent()).includes("evidence #"),
    );
    for (const r of op.results.filter((r: any) => r.evidenceId)) {
      assert.ok(
        await page
          .locator(
            `#log [data-evidence-ids="${[r.evidenceId, ...r.verificationEvidenceIds].join(",")}"]`,
          )
          .count(),
      );
    }
    for (const w of op.workers) {
      const card = page.locator(`.agent[data-agent-id="${w.agentId}"]`);
      assert.equal(await card.getAttribute("data-state"), w.state);
      assert.equal(await card.locator(".name").textContent(), w.name);
      await card.click();
      assert.equal(await page.locator("#modal-state").textContent(), w.state);
      assert.ok(
        (await page.locator("#modal-text").textContent()).includes(w.objective),
      );
      assert.equal(
        await page
          .locator(
            `#modal-log [data-agent-id]:not([data-agent-id="${w.agentId}"])`,
          )
          .count(),
        0,
      );
      await page.locator("#modal-close").click();
    }
    const bubbles = await page.locator("#transcript [data-message-id]").count();
    await page.evaluate(() => {
      (window as any).__firstBubble = document.querySelector(
        "#transcript [data-message-id]",
      );
    });
    const contextReceipt = op.results.find((r: any) => r.evidenceId);
    await page
      .locator(
        `#log [data-evidence-ids="${[contextReceipt.evidenceId, ...contextReceipt.verificationEvidenceIds].join(",")}"]`,
      )
      .click();
    assert.ok(
      (await page.locator("#context-slot").textContent()).includes(
        `DR-${String(contextReceipt.target).padStart(3, "0")}`,
      ),
    );
    await page.locator("#say").fill("What is the status of our fleet?");
    const statusReply = page.waitForResponse((r: any) =>
      r.url().endsWith("/api/chat/messages"),
    );
    await page.locator("#say").press("Enter");
    const statusResponse = await statusReply;
    assert.equal(
      statusResponse.request().postDataJSON().target,
      contextReceipt.target,
    );
    const duplicate = await page.request.post(
      service.url + "/api/chat/messages",
      {
        headers: {
          origin: service.url,
          "x-sudoko-role": role,
          "idempotency-key": statusResponse.request().headers()[
            "idempotency-key"
          ],
        },
        data: statusResponse.request().postDataJSON(),
      },
    );
    assert.equal(duplicate.status(), 202);
    assert.equal(
      (await duplicate.json()).messages.filter((m: any) => m.text === "What is the status of our fleet?")
        .length,
      1,
    );
    await page.waitForFunction(
      (n: number) =>
        document.querySelectorAll("#transcript [data-message-id]").length > n,
      bubbles,
    );
    assert.ok(
      await page.evaluate(
        () =>
          (window as any).__firstBubble ===
          document.querySelector("#transcript [data-message-id]"),
      ),
    );
    assert.equal(await page.locator("#transcript img").count(), 0);
    await page.screenshot({ path: output + `/${role}.png` });
    const other = pages[role === "attacker" ? "defender" : "attacker"];
    assert.equal(
      (
        await other.request.get(`${service.url}/api/chat/operations/${op.id}`, {
          headers: {
            "x-sudoko-role": role === "attacker" ? "defender" : "attacker",
          },
        })
      ).status(),
      404,
    );
    const before = (
      await service.store.query("SELECT * FROM fleet_chat_action")
    ).length;
    await page.reload();
    await page.waitForFunction(
      (objective: string) =>
        document.querySelector("#transcript")?.textContent?.includes(objective),
      objectives[role],
    );
    assert.match(await page.locator("#transcript").textContent(), /status of our fleet/);
    assert.equal(
      (await service.store.query("SELECT * FROM fleet_chat_action")).length,
      before,
    );
  }
  if (demo) {
    const page = pages.attacker;
    for (const role of ["defender", "attacker"]) {
      await page.locator(`nav button[data-role="${role}"]`).click();
      await page.waitForFunction(
        (text: string) =>
          document.querySelector("#transcript")?.textContent?.includes(text),
        objectives[role as "attacker" | "defender"],
      );
      assert.ok(
        !(await page.locator("#transcript").textContent()).includes(
          objectives[role === "attacker" ? "defender" : "attacker"],
        ),
      );
      assert.equal(
        (await service.store.query("SELECT * FROM fleet_session"))[0].epoch,
        fleet.epoch,
      );
    }
    report.loginFreeSwitching = true;
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
  if (mocked) {
    const page = pages.attacker;
    const send = async (message: string) => {
      await page.locator("#say").fill(message);
      const response = page.waitForResponse((r: any) =>
        r.url().endsWith("/api/chat/messages"),
      );
      await page.locator("#say").press("Enter");
      const r = await response;
      assert.equal(r.status(), 202);
      let c = await r.json();
      if (c.accepted) for (let i = 0; i < 60; i++) {
        const status = await page.request.get(service.url + "/api/chat/conversation", { headers: { "x-sudoko-role": "attacker" } });
        c = await status.json();
        if (!c.turns.some((t: any) => ["queued", "running"].includes(t.state))) break;
        await delay(100);
      }
      return c;
    };
    for (let i = 0; i < 5; i++) await send("Status");
    await page
      .locator("#transcript")
      .evaluate((node: HTMLElement) => (node.scrollTop = 0));
    const oldCount = await page
      .locator("#transcript [data-message-id]")
      .count();
    await send("Status");
    await page.waitForFunction(
      (n: number) =>
        document.querySelectorAll("#transcript [data-message-id]").length > n,
      oldCount,
    );
    assert.equal(
      await page
        .locator("#transcript")
        .evaluate((node: HTMLElement) => node.scrollTop),
      0,
    );
    const before = (
      await service.store.query("SELECT * FROM fleet_chat_action")
    ).length;
    providerMode = "blocked-specialists";
    const running = await send("Inspect again");
    const pending = running.operations.at(-1);
    assert.ok(["planning", "running"].includes(pending.state));
    await page.waitForSelector(`.agent[data-operation-id="${pending.id}"][data-state="working"]`);
    const changed = await send("Change the objective");
    assert.ok(
      changed.messages.some((m: any) =>
        m.text.startsWith("No change applied"),
      ),
    );
    const stopped = await send("Stop");
    assert.equal(
      stopped.operations.find((o: any) => o.id === pending.id).state,
      "cancelled",
    );
    await page.waitForFunction(
      () => document.querySelector("#chat-sub")?.textContent === "cancelled",
    );
    await delay(500);
    assert.equal((await service.store.query("SELECT * FROM fleet_chat_action")).length, before);
    providerMode = "rate-limit";
    await send("Inspect with provider failure");
    await page.waitForFunction(
      () => document.querySelector("#chat-sub")?.textContent === "failed",
    );
    assert.match(
      await page.locator("#transcript").textContent(),
      /provider_rate_limit/,
    );
    assert.ok(await page.locator('#log [data-status="failed"]').count());
    assert.equal(
      (await service.store.query("SELECT * FROM fleet_chat_action")).length,
      before,
    );
    assert.equal(
      (await service.store.query("SELECT * FROM agent_schedule")).length,
      0,
    );
    await page.screenshot({ path: output + "/provider-failure.png" });
    report.mockedFailureAndStopVerified = true;
  }

  if (mocked) {
    const page = pages.defender;
    await page.context().setOffline(true);
    await delay(6500);
    assert.match(await page.locator("#live").textContent(), /Disconnected|Stale/);
    await dimensions(page, "disconnected");
    await page.context().setOffline(false);
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#live")?.textContent?.startsWith("Live"));
    await page.route("**/fleet-config*", async (route: any) => { await delay(1500); await route.continue(); });
    await page.reload({ waitUntil: "domcontentloaded" });
    await dimensions(page, "loading");
    await page.waitForFunction(() => document.querySelector("#live")?.textContent?.startsWith("Live"));
    await page.unroute("**/fleet-config*");
    await service.store.call("stop_fleet", []);
    await page.waitForFunction(() => document.querySelector("#live")?.textContent === "Fleet ended");
    await dimensions(page, "fleet-ended");
  }
  report.browserErrors = browserErrors;
  assert.deepEqual(browserErrors, []);
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
} catch (error) {
  for (const context of browser?.contexts() ?? [])
    for (const page of context.pages()) {
      await page
        .screenshot({
          path:
            output +
            `/failed-${await page.locator("#chat-name").textContent()}.png`,
        })
        .catch(() => {});
    }
  throw error;
} finally {
  await writeFile(output + "/evidence.json", JSON.stringify(report, null, 2));
  await browser?.close();
  await service.close();
  globalThis.fetch = original;
  await db.close();
}
