import test from "node:test";
import assert from "node:assert/strict";
import { OperationChat } from "../../web/fleet-chat.ts";

test("conversation reconnect reuses a lost submission key and target; messages append once, role history stays separate", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "localStorage",
  );
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => values.set(k, v),
      removeItem: (k: string) => values.delete(k),
    },
  });
  t.after(() => {
    if (descriptor)
      Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const keys: string[] = [];
  let role = "attacker";
  const message = {
    id: 1,
    operation: "op-1",
    speaker: "operator",
    text: "Inspect selected drone",
    target: 2,
    at: 123,
  };
  t.mock.method(
    globalThis,
    "fetch",
    async (_input: unknown, init?: RequestInit) => {
      if (init?.method === "POST") {
        keys.push((init.headers as Record<string, string>)["idempotency-key"]);
        assert.deepEqual(JSON.parse(init.body as string), {
          message: message.text,
          target: 2,
          sandbox: "owned",
        });
        if (keys.length === 1) throw Error("Response lost after admission");
      }
      return Response.json({
        messages: role === "attacker" ? [message] : [],
        operations: [],
        after: 1,
        more: false,
      });
    },
  );
  const first = new OperationChat(
    "owned",
    "attacker",
    () => {},
    () => {},
  );
  await assert.rejects(first.submit(message.text, 2), /Response lost/);
  first.close();
  const next = new OperationChat(
    "owned",
    "attacker",
    () => {},
    () => {},
  );
  await next.resume();
  next.close();
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.ok(keys[0]);
  assert.deepEqual(next.messages, [message]);
  role = "defender";
  const other = new OperationChat(
    "owned",
    "defender",
    () => {},
    () => {},
  );
  await other.resume();
  other.close();
  assert.deepEqual(other.messages, []);
  assert.equal(keys.length, 2);
});
