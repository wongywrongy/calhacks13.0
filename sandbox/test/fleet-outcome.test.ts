import test from "node:test";
import assert from "node:assert/strict";
import { fleetOutcome, explainFleetError } from "../src/fleet-outcome.ts";

test("terminal execution state cannot substitute for verified objective success", () => {
  const op = { state: "completed", role: "defender", tasks: [{ agentId: 1 }, { agentId: 2 }], results: [
    { agentId: 1, target: 1, status: "executed", outcome: "recovery_verified", evidenceId: 3, responseStatus: 200, verificationEvidenceIds: [1, 2] },
    { agentId: 2, target: 2, status: "failed", error: "reducer_rejected" },
  ] };
  assert.equal(fleetOutcome(op).status, "Partially completed");
  assert.equal(fleetOutcome({ ...op, state: "failed" }).status, "Partially completed");
  assert.equal(fleetOutcome({ ...op, results: [] }).status, "Failed");
  assert.equal(fleetOutcome({ ...op, state: "cancelled" }).status, "Stopped");
  assert.equal(fleetOutcome({ ...op, tasks: [{ agentId: 1 }] }).status, "Completed");
  assert.equal(fleetOutcome({ ...op, results: [{ ...op.results[0], verificationEvidenceIds: [] }] }).succeeded, 0);
  assert.deepEqual(fleetOutcome(op).evidenceIds, [3, 1, 2]);
  assert.match(fleetOutcome(op).summary, /^Recovered 1 drone\./);
});

test("blocked commands and repeated evidence cannot inflate success counts", () => {
  const receipt = { agentId: 1, target: 7, status: "executed", evidenceId: 1, outcome: "unauthorized_command_accepted", responseStatus: 200 };
  const op = { state: "completed", role: "attacker", tasks: [{ agentId: 1 }], results: [receipt, receipt] };
  assert.equal(fleetOutcome(op).succeeded, 1);
  assert.match(fleetOutcome(op).summary, /1 drone;/);
  const blocked = fleetOutcome({ ...op, results: [{ ...receipt, outcome: "unauthorized_command_blocked", responseStatus: 403 }] });
  assert.equal(blocked.status, "Failed");
  assert.deepEqual(blocked.evidenceIds, [1]);
  assert.match(blocked.summary, /No takeover was verified/);
  assert.equal(explainFleetError("reducer_rejected"), "The action was rejected; the backend did not provide a specific reason.");
  assert.match(explainFleetError("stale_policy"), /policy changed/);
});

test("simulation receipts distinguish pending attempts, partial access and completed control effects", () => {
  const receipt = { agentId: 1, kind: "spread", target: 18, status: "queued", evidenceId: 3,
    simulation: { simulated: true, summary: "Partial success: one drone compromised; two resisted.", succeeded: 1, partial: 0, total: 3 } };
  const op = { state: "completed", role: "attacker", tasks: [{ agentId: 1 }], results: [receipt] };
  assert.equal(fleetOutcome(op).succeeded, 0, "Selection is not an effect");
  const partial = fleetOutcome({ ...op, results: [{ ...receipt, status: "executed" }] });
  assert.equal(partial.status, "Partially completed");assert.equal(partial.succeeded, 1);
  assert.match(partial.summary, /^Simulated outcomes:/);
  const limited = fleetOutcome({ ...op, results: [{ ...receipt, status: "executed", simulation: { ...receipt.simulation, succeeded: 0, partial: 1 } }] });
  assert.equal(limited.succeeded, 0);assert.equal(limited.status, "Partially completed");
});

test("containment alone cannot be reported as completed recovery", () => {
  const result = { agentId: 1, kind: "isolate", status: "executed", evidenceId: 4,
    simulation: { simulated: true, summary: "Contained; mission participation suspended.", succeeded: 1, partial: 0, total: 1 } };
  const op = { state: "completed", role: "defender", tasks: [{ agentId: 1 }], results: [result] };
  assert.equal(fleetOutcome(op).succeeded, 0);
  assert.equal(fleetOutcome(op).status, "Partially completed");
  assert.equal(fleetOutcome({ ...op, results: [result, { ...result, kind: "verify", evidenceId: 7 }] }).status, "Completed");
});


test("compact outcomes identify drones and group repeated identical attempts", () => {
  const result = { agentId: 1, kind: "command", target: 1, status: "executed", evidenceId: 4,
    simulation: { simulated: true, summary: "Target resisted.", succeeded: 0, partial: 0, total: 1 } };
  const summary = fleetOutcome({ state: "completed", role: "attacker", tasks: [{ agentId: 1 }],
    results: [result, result, { ...result, evidenceId: 5 }, { ...result, agentId: 2, target: 2, evidenceId: 6 }] });
  assert.equal(summary.summary, "Simulated outcomes:\n- DR-001 · command: Target resisted. (2 attempts)\n- DR-002 · command: Target resisted.");
  assert.equal(summary.succeeded, 0);
  assert.deepEqual(summary.evidenceIds, [4, 5, 6]);
});
