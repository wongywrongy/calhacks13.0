import test from "node:test";
import assert from "node:assert/strict";
import {
  OperationChat,
  operationLines,
  type Operation,
} from "../../web/fleet-chat.ts";

const operation: Operation = {
  id: "test-operation",
  role: "attacker",
  epoch: 1,
  state: "interrupted",
  message: "Inspect the assigned drone",
  tasks: [],
  results: [],
  inferences: [
    { agentId: 1, stage: "specialist", model: "test-model", status: "running" },
  ],
};

test("terminal history never displays abandoned inference as currently running", () => {
  assert.ok(
    !operationLines(operation).some((line) => line === "Agent 1 · running"),
  );
  assert.ok(
    operationLines({ ...operation, state: "running" }).includes(
      "Agent 1 · running",
    ),
  );
});

test("browser reconnect after a lost start response reuses the persisted submission key", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  t.after(() => {
    if (descriptor)
      Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const keys: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: unknown, init?: RequestInit) => {
      keys.push((init!.headers as Record<string, string>)["idempotency-key"]);
      assert.deepEqual(JSON.parse(init!.body as string), {
        message: operation.message,
        sandbox: "owned-sandbox",
      });
      if (keys.length === 1)
        throw Error("Response lost after server admission");
      return Response.json({ ...operation, state: "completed" });
    },
  );
  const first = new OperationChat(
    "owned-sandbox",
    "attacker",
    () => {},
    () => {},
  );
  await assert.rejects(first.submit(operation.message), /Response lost/);
  first.close();
  const reconnected = new OperationChat(
    "owned-sandbox",
    "attacker",
    () => {},
    () => {},
  );
  await reconnected.resume();
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.ok(keys[0]);
  assert.equal(reconnected.operation?.id, operation.id);
  const otherRole = new OperationChat(
    "owned-sandbox",
    "defender",
    () => {},
    () => {},
  );
  await otherRole.resume();
  assert.equal(keys.length, 2);
  reconnected.close();
  otherRole.close();
});
