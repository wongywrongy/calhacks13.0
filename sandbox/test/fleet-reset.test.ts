import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { testDatabase } from "./spacetime-helper.ts";
import { startService } from "../src/service.ts";

test("fleet and conversation resets fence stale work and survive reconnect", { skip: !process.env.SPACETIME_BINARY }, async (t) => {
  const db = await testDatabase();
  const original = globalThis.fetch;
  let blocked = "";
  t.mock.method(globalThis, "fetch", async (input: any, init?: any) => {
    if (String(input) !== "https://api-inference.bitdeer.ai/v1/chat/completions") return original(input, init);
    const body = JSON.parse(init.body), system = JSON.parse(body.messages[0].content), context = JSON.parse(body.messages[1].content);
    while (blocked === "all" || (blocked === "specialists" && !system.agents)) await delay(20, undefined, { signal: init.signal });
    const tasks = [1, 2].map((target) => ({ target, name: "Scout " + target, specialty: "testing", goal: system.role === "attacker" ? "capture" : "recover", objective: "Assess assigned drone" }));
    const value = system.agents ? system.task.startsWith("Route")
      ? { intent: "deploy", answer: "Prepare specialists", evidenceIds: [], tasks } : { tasks }
      : { kind: system.role === "attacker" ? context.observation.discovered === false ? "discover" : "command" : context.observation.isolated ? "verify" : "isolate" };
    if (!system.agents && system.allowed && !system.allowed.includes(value.kind)) value.kind=system.allowed.find((k:string)=>k!=="wait") ?? "wait";
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }] });
  });
  const env: NodeJS.ProcessEnv = { ...db.env, BITDEER_API_KEY: "mock-reset", SUDOKO_DEMO_MODE: "1", SUDOKO_ATTACKER_TOKEN: "reset-test-attacker-00000000000000000000" };
  const operatorToken = "reset-test-operator-00000000000000000000000";
  let service = await startService({ operatorToken, env });
  try {
    await service.store.call("start_fleet", [4, 0, 0, false]);
    await service.store.call("set_battle_seed", [233]);
    for (const role of ["attacker", "defender", "observer"]) {
      const identity: any = await original(db.env.SPACETIME_URI + "/v1/identity", { method: "POST" }).then((r) => r.json());
      await service.store.call("grant_fleet_view", [identity.identity, role]);
      env[`SUDOKO_DEMO_${role.toUpperCase()}_VIEWER_TOKEN`] = identity.token;
    }
    const api = async (path: string, role = "attacker", data?: any) => {
      const r = await original(service.url + path, { method: data ? "POST" : "GET",
        headers: { origin: service.url, "content-type": "application/json", "x-sudoko-role": role, "idempotency-key": randomUUID() },
        body: data ? JSON.stringify(data) : undefined });
      return { status: r.status, body: await r.json() as any };
    };
    const trustedMessage = async (data: any) => original(service.url + "/v1/chat/messages", {
      method: "POST", headers: { authorization: `Bearer ${env.SUDOKO_ATTACKER_TOKEN}`, "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify(data),
    });
    const config = async (role = "attacker") => (await api("/fleet-config?role=" + role, role)).body;
    const send = async (role: string, message: string, operation = false) => {
      const c = await config(role);
      const r = await api(operation ? "/api/chat/operations" : "/api/chat/messages", role, { message, sandbox: c.sandbox, epoch: c.epoch, conversation: c.conversation });
      assert.equal(r.status, 202, JSON.stringify(r.body)); return r.body;
    };
    const waitFor = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 800; i++) { if (await check()) return; await delay(30); }
      assert.fail("Timed out waiting for fleet lifecycle");
    };
    const completed = async (role: string, id: string) => waitFor(async () => {
      const op = (await api("/api/chat/operations/" + id, role)).body;
      assert.notEqual(op.state, "failed", JSON.stringify(op));
      return op.state === "completed";
    });
    const reset = async () => {
      const c = await config();
      const r = await api("/api/chat/reset", "attacker", { epoch: c.epoch });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.epoch, c.epoch + 1);
      const state = (await api("/api/chat/state", "defender")).body;
      assert.equal(state.drones.length, 4);
      assert.ok(state.drones.every((d: any) => d.epoch === r.body.epoch && d.controller === "defender" && !d.isolated && !d.policy_version));
      assert.deepEqual(state.agents, []); assert.deepEqual(state.events, []);
      assert.deepEqual(await service.store.query("SELECT * FROM fleet_hold"), []);
      assert.ok((await service.store.query("SELECT * FROM battle_attempt")).every((a:any)=>a.stage==="resolved"));
      for (const table of ["battle_schedule", "battle_drone", "battle_retry", "hosted_alarm"]) assert.deepEqual(await service.store.query("SELECT * FROM " + table), []);
      await waitFor(async () => (await service.store.query("SELECT * FROM fleet_drone")).every((d: any) => d.tick > 0));
      await service.store.call("set_battle_seed", [233]);
      return c;
    };
    // Reset starts a clean epoch, including discoveries and both role conversations.
    const attack = await send("attacker", "Take control of the drones", true);
    await completed("attacker", attack.id);
    assert.ok((await service.store.query("SELECT * FROM fleet_drone")).some((d: any) => d.controller === "attacker"));
    const beforeReset = await reset();
    assert.equal((await api("/api/chat/state")).body.drones.length, 0);
    assert.deepEqual((await api("/api/chat/conversation")).body.messages, []);
    assert.equal((await api("/api/chat/reset", "attacker", { epoch: beforeReset.epoch })).status, 409);
    assert.equal((await trustedMessage({ message: "Old retry", epoch: beforeReset.epoch })).status, 409);
    assert.equal((await trustedMessage({ message: "Missing epoch" })).status, 400);
    const oldOp = (await api("/api/chat/operations/" + attack.id)).body;
    const task = oldOp.tasks[0];
    await assert.rejects(service.store.call("execute_fleet_chat_action", [service.store.session, attack.id, 3, task.agentId, task.target, "command", 0]));
    // Recovery -> reset restores policy and controller; current history survives.
    const takeover = await send("attacker", "Take control again", true); await completed("attacker", takeover.id);
    const defense = await send("defender", "Recover the drones", true); await completed("defender", defense.id);
    assert.ok((await service.store.query("SELECT * FROM fleet_evidence")).some((e: any) => e.kind === "recovery_verified"));
    await reset();
    // Active inference -> reset: cancelled operation cannot deploy later.
    blocked = "specialists";
    const active = await send("attacker", "Keep testing", true);
    await waitFor(async () => (await api("/api/chat/operations/" + active.id)).body.state === "running");
    await reset();
    assert.equal((await api("/api/chat/operations/" + active.id)).body.state, "cancelled");
    assert.deepEqual(await service.store.query("SELECT * FROM fleet_agent"), []);
    // New Chat cancels a pending turn, changes only this role's generation, and resets a stale polling cursor.
    const running = await send("attacker", "Agents keep running", true);
    await waitFor(async () => (await api("/api/chat/operations/" + running.id)).body.state === "running");
    const runningConfig = await config();
    const agentsBeforeChat = await service.store.query("SELECT * FROM fleet_agent");
    assert.equal((await api("/api/chat/new", "attacker", { epoch: runningConfig.epoch, conversation: runningConfig.conversation })).status, 200);
    assert.deepEqual(await service.store.query("SELECT * FROM fleet_agent"), agentsBeforeChat);
    assert.equal((await api("/api/chat/operations/" + running.id)).body.state, "running");
    blocked = ""; await completed("attacker", running.id);
    assert.deepEqual((await api("/api/chat/conversation")).body.messages, [], "Old operation completion stays outside the fresh chat");
    blocked = "all";
    const pending = await send("attacker", "Pending deployment");
    const c = await config(), defenderBefore = (await api("/api/chat/conversation", "defender")).body;
    const newChat = await api("/api/chat/new", "attacker", { epoch: c.epoch, conversation: c.conversation });
    assert.equal(newChat.status, 200); assert.equal(newChat.body.conversation, c.conversation + 1);
    assert.deepEqual(newChat.body.messages, []); assert.deepEqual(newChat.body.turns, []);
    assert.equal((await config()).epoch, c.epoch);
    assert.deepEqual((await api("/api/chat/conversation", "defender")).body.messages, defenderBefore.messages);
    assert.equal((await api("/api/chat/messages", "attacker", { epoch: c.epoch, conversation: c.conversation, sandbox: c.sandbox, message: "Old retry" })).status, 409);
    await assert.rejects(service.store.call("update_chat_turn", [service.store.session, pending.accepted.id, "completed", "{}", "Old reply"]));
    assert.equal((await trustedMessage({ message: "Retry without conversation", epoch: c.epoch })).status, 409);
    blocked = "";
    await send("attacker", "Status");
    const fresh = (await api("/api/chat/conversation?after=999999&conversation=" + c.conversation)).body;
    assert.ok(fresh.messages.some((m: any) => m.text === "Status"));
    assert.ok(!fresh.messages.some((m: any) => m.text === "Pending deployment"));
    // Reconnect includes persisted generation; subsequent swarm reset preserves it.
    await service.close(); await db.restart(); service = await startService({ operatorToken, env });
    assert.equal((await config()).conversation, c.conversation + 1);
    assert.ok(!(await api("/api/chat/conversation")).body.messages.some((m: any) => m.text === "Pending deployment"));
    await reset();
    // Full demo reset is explicit, resets both chats and never accepts observer mutation.
    const current = await config();
    assert.equal((await api("/api/chat/reset-demo", "attacker", { epoch: current.epoch })).status, 400);
    assert.equal((await api("/api/chat/new", "observer", { epoch: current.epoch, conversation: 1 })).status, 403);
    assert.equal((await api("/api/chat/reset-demo", "attacker", { epoch: current.epoch, confirm: true })).status, 200);
    for (const role of ["attacker", "defender"]) {
      const result = (await api("/api/chat/conversation", role)).body;
      assert.deepEqual(result.messages, []); assert.deepEqual(result.operations, []); assert.deepEqual(result.turns, []);
    }
  } finally { await service.close(); await db.close(); }
});
