import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { testDatabase } from "./spacetime-helper.ts";
import { startService } from "../src/service.ts";
import { RunStore } from "../src/run-store.ts";
import { SCENARIOS, resilienceContext } from "../src/resilience.ts";
import { fleetOutcome } from "../src/fleet-outcome.ts";

const waitFor = async (check: () => Promise<boolean>, timeout = 5000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(60); }
  assert.fail("Timed out waiting for measured resilience state");
};

test("a scheduled disruption alone cannot establish challenge success", () => {
  const op = { state: "completed", role: "attacker", tasks: [{ agentId: 1 }], results: [
    { agentId: 1, target: 1, status: "executed", evidenceId: 1, outcome: "challenge_telemetry_scheduled", responseStatus: 200 },
  ] };
  assert.equal(fleetOutcome(op).succeeded, 0);
  assert.equal(fleetOutcome({ ...op, results: [{ ...op.results[0], verifiedEffectEvidenceId: 2 }] }).succeeded, 1);
});

test("authoritative resilience: five scenarios, budgets, mission costs, private views and atomic reset", { skip: !process.env.SPACETIME_BINARY }, async () => {
  const db = await testDatabase();
  const service = await startService({ operatorToken: "resilience-operator-000000000000000000000", env: db.env });
  const store = service.store;
  const rows = (table: string) => store.query("SELECT * FROM " + table);
  const mission = async () => (await rows("resilience_mission"))[0];
  let agentId = 100;
  const plan = async (role: string, targets: number[]) => {
    const epoch = (await rows("fleet_session"))[0].epoch;
    const id = randomUUID(), generation = (await store.query(`SELECT * FROM backend_chat_session WHERE role='${role}'`))[0]?.generation ?? 1;
    await store.call("create_chat_operation", [store.session, id, id, role, epoch, JSON.stringify({ conversation: generation, message: "Synthetic test", target: null, tasks: [], maxDecisionsPerAgent: 8, maxModelCalls: 33, createdAt: Date.now(), deadline: Date.now() + 75000 })]);
    const tasks = targets.map((target) => ({ agentId: ++agentId, name: "Test " + agentId, specialty: "resilience", target, objective: "Measure bounded behavior" }));
    await store.call("plan_chat_operation", [store.session, id, JSON.stringify(tasks)]);
    const sequence = new Map<number, number>();
    return { id, tasks, action: async (index: number, kind: string, version?: number) => {
      const task = tasks[index], step = (sequence.get(index) ?? 0) + 1;
      const [d] = await store.query(`SELECT * FROM fleet_drone WHERE id=${task.target}`);
      const args = [store.session, id, step, task.agentId, task.target, kind, version ?? (role === "defender" ? d.policy_version : 0)];
      await store.call("execute_fleet_chat_action", args);sequence.set(index, step);
      return args;
    } };
  };
  try {
    await store.call("start_fleet", [6, 0, 0, false]);
    assert.equal((await rows("fleet_drone")).length, 6);
    assert.equal((await mission()).state, "ready");
    await delay(300);
    assert.equal((await mission()).delivered_ms, 0, "Mission waits for a team action");
    const attack = await plan("attacker", [1, 2]);
    await assert.rejects(attack.action(0, "shell"));
    await assert.rejects(attack.action(0, "command"), "Legacy control transfer is unavailable");
    await attack.action(0, "discover");await attack.action(1, "discover");
    const args = await attack.action(0, "telemetry");
    const budget = (await rows("resilience_budget")).find((b: any) => b.role === "attacker");
    assert.equal(budget.remaining, 40 - SCENARIOS.telemetry.cost);
    const eventCount = (await rows("fleet_evidence")).length;
    await store.call("execute_fleet_chat_action", args);
    assert.equal((await rows("fleet_evidence")).filter((e: any) => e.kind === "challenge_telemetry_scheduled").length, 1);
    assert.equal((await rows("resilience_budget")).find((b: any) => b.role === "attacker").remaining, budget.remaining);
    await assert.rejects(store.call("execute_fleet_chat_action", [...args.slice(0, 6), "malfunction", 0]));
    await assert.rejects(store.call("execute_fleet_chat_action", [store.session, attack.id, 8, attack.tasks[0].agentId, 1, "wait", 0]));
    await waitFor(async () => (await rows("fleet_evidence")).some((e: any) => e.kind === "challenge_effect"));
    assert.ok((await mission()).lost_ms > 0);
    const observed = await resilienceContext(store, "defender", 1);
    assert.ok(observed!.observations[0].sensors.primaryX !== observed!.observations[0].sensors.corroboratedX);
    const defense = await plan("defender", [1, 2]);
    await defense.action(0, "restore");
    assert.ok((await rows("fleet_evidence")).some((e: any) => e.kind === "restoration_failed"));
    const beforeCheck = (await rows("fleet_drone"))[0].policy_version;
    await defense.action(0, "cross_check");
    await assert.rejects(defense.action(0, "quarantine", beforeCheck));
    await defense.action(0, "restore");
    assert.ok((await rows("fleet_evidence")).some((e: any) => e.kind === "participation_restored"));
    assert.ok((await mission()).detections > 0 && (await mission()).recoveries > 0);
    const progress = (await rows("resilience_drone"))[0].delivered_ms;
    await waitFor(async () => (await rows("resilience_drone"))[0].delivered_ms > progress);
    // Cooldown failure is committed as a receipt, then another scenario can run.
    await attack.action(0, "telemetry");
    assert.ok((await rows("fleet_evidence")).some((e: any) => e.kind === "challenge_telemetry_blocked" && e.status === 429));
    await attack.action(0, "communications");
    await attack.action(1, "mission_conflict");await attack.action(1, "invalid_command");
    await attack.action(1, "malfunction"); // Third concurrent event is rejected with 409.
    assert.ok((await rows("fleet_evidence")).some((e: any) => e.kind === "challenge_malfunction_blocked" && e.status === 409));
    for (const role of ["attacker", "defender", "observer", "unassigned"]) {
      const viewer: any = await fetch(db.env.SPACETIME_URI + "/v1/identity", { method: "POST" }).then((r) => r.json());
      if (role !== "unassigned") await store.call("grant_fleet_view", [viewer.identity, role]);
      const reader = new RunStore({ uri: db.env.SPACETIME_URI, database: db.env.SPACETIME_DATABASE, token: viewer.token });
      await assert.rejects(reader.query("SELECT * FROM resilience_disruption"));
      await assert.rejects(reader.call("execute_fleet_chat_action", args));
      const events = await reader.query("SELECT * FROM visible_evidence");
      const budgets = await reader.query("SELECT * FROM visible_resilience_budget");
      if (role === "attacker") {
        assert.ok(events.every((e: any) => e.kind.startsWith("challenge_") || e.kind === "discovered"));
        assert.deepEqual(budgets.map((b: any) => b.role), ["attacker"]);
        assert.ok((await reader.query("SELECT * FROM visible_resilience_drones")).every((d: any) => d.protection === 0 && !d.untrusted_proposal));
      }
      if (role === "defender") assert.ok(events.every((e: any) => !e.kind.startsWith("challenge_")));
      if (role === "unassigned") {
        assert.deepEqual(events, []);assert.deepEqual(budgets, []);
        assert.deepEqual(await reader.query("SELECT * FROM visible_resilience_mission"), []);
      }
    }
    const epoch = (await rows("fleet_session"))[0].epoch;
    await store.call("reset_chat_fleet", [store.session, epoch, false]);
    assert.equal((await rows("fleet_session"))[0].epoch, epoch + 1);
    for (const table of ["fleet_agent", "fleet_agent_profile", "fleet_discovery", "fleet_evidence", "fleet_chat_action", "resilience_disruption"]) assert.deepEqual(await rows(table), [], table);
    assert.equal((await mission()).state, "ready");assert.equal((await mission()).delivered_ms, 0);
    assert.ok((await rows("resilience_budget")).every((b: any) => b.remaining === 40 && b.spent === 0));
    assert.ok((await rows("fleet_drone")).every((d: any) => !d.policy_version && !d.isolated));
    assert.ok((await rows("backend_chat_session")).every((s: any) => s.generation === 2));
    await assert.rejects(store.call("execute_fleet_chat_action", args));
    const fresh = await plan("attacker", [3, 4]);
    await fresh.action(0, "discover");await fresh.action(0, "malfunction");
    const disruption = (await rows("resilience_disruption"))[0];
    assert.equal(disruption.until - disruption.started, SCENARIOS.malfunction.durationMs * 1000);
    assert.equal(disruption.cooldown_until - disruption.started, SCENARIOS.malfunction.cooldownMs * 1000);
    await waitFor(async () => (await rows("resilience_drone")).find((d: any) => d.drone === 3).anomaly);
    // Reset and compare healthy mission work with complete fleet isolation.
    await store.call("reset_chat_fleet", [store.session, epoch + 1, true]);
    const blue = await plan("defender", [1, 2, 3, 4]);
    for (let i = 0; i < 4; i++) await blue.action(i, "quarantine");
    await store.call("update_chat_operation", [store.session, blue.id, "completed", "[]"]);
    const rest = await plan("defender", [5, 6]);await rest.action(0, "quarantine");await rest.action(1, "quarantine");
    await waitFor(async () => (await mission()).unnecessary_isolation_ms > 1000);
    const isolatedProgress = (await mission()).delivered_ms;
    await delay(500);
    assert.equal((await mission()).delivered_ms, isolatedProgress, "Disconnecting all drones stops the mission");
    const spend = await plan("attacker", [1, 2]);
    await spend.action(0, "discover");await spend.action(1, "discover");
    for (let i = 0; i < 10; i++) await spend.action(i % 2, "malfunction");
    assert.equal((await rows("resilience_budget")).find((b: any) => b.role === "attacker").remaining, 0);
    await assert.rejects(spend.action(0, "malfunction"));
    assert.equal((await rows("resilience_budget")).find((b: any) => b.role === "attacker").remaining, 0);
    const report = { label: "Synthetic resilience simulation / deterministic reducer checks", eventCount, challengeSuccess: true, defenseSuccess: true, adaptation: "429 telemetry cooldown -> communications", isolation: await mission() };
    await mkdir("output/resilience", { recursive: true });await writeFile("output/resilience/reducer-evidence.json", JSON.stringify(report, null, 2));
  } finally { await service.close();await db.close(); }
});
