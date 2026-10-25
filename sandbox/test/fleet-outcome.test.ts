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
