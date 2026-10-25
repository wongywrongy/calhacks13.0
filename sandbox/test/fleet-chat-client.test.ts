import test from "node:test";
import assert from "node:assert/strict";
import { OperationChat, replyBlocks } from "../../web/fleet-chat.ts";

test("a late same-session poll cannot replace a newer submission snapshot", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
  } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, "localStorage", descriptor) : Reflect.deleteProperty(globalThis, "localStorage"));
  let release!: (r: Response) => void;
  const oldPoll = new Promise<Response>((resolve) => { release = resolve; });
  const user = { id: 1, speaker: "operator", text: "Deploy", operation: "", target: 0, at: 1, replyTo: 1, turnId: "turn" };
  const snapshot = { fleet: { epoch: 1, active: true }, messages: [user, user], operations: [{ id: "new", state: "running", epoch: 1, messageId: 1 }], after: 1, more: false };
  t.mock.method(globalThis, "fetch", async (_url: any, init?: RequestInit) => init?.method === "POST" ? Response.json(snapshot) : oldPoll);
  const client = new OperationChat("owned", "defender", () => {}, () => {}, 1);
  t.after(() => client.close());
  const polling = client.resume();
  await client.submit("Deploy");
  release(Response.json({ ...snapshot, operations: [] }));
  await polling;
  assert.equal(client.operation?.id, "new");
  assert.equal(client.messages.length, 1);
  assert.equal(client.messages[0].turnId, "turn");
});

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
  let generation: number | undefined;
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
      assert.equal(
        (init?.headers as Record<string, string>)["x-sudoko-role"],
        role,
      );
      if (init?.method === "POST") {
        keys.push((init.headers as Record<string, string>)["idempotency-key"]);
        assert.deepEqual(JSON.parse(init.body as string), {
          message: message.text,
          target: 2,
          sandbox: "owned",
          epoch: generation === undefined ? 1 : 2,
          conversation: generation ?? 1,
        });
        if (keys.length === 1) throw Error("Response lost after admission");
      }
      return Response.json({
        conversation: generation ?? 1,
        fleet: { epoch: generation === undefined ? 1 : 2, active: true },
        messages: role === "attacker" && generation !== 4 ? [message] : [],
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
    1,
  );
  await assert.rejects(first.submit(message.text, 2), /Response lost/);
  first.close();
  const next = new OperationChat(
    "owned",
    "attacker",
    () => {},
    () => {},
    1,
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
    1,
  );
  await other.resume();
  other.close();
  assert.deepEqual(other.messages, []);
  assert.equal(keys.length, 2);
  role = "attacker";
  generation = 3;
  const modern = new OperationChat("owned", role, () => {}, () => {}, 2, 3);
  modern.conversation = generation;
  modern.fleet = { active: true, epoch: 2 };
  await modern.submit(message.text, 2);
  assert.equal(modern.conversation, 3);
  generation = 4;
  await modern.resume();
  modern.close();
  assert.equal(modern.conversation, 4);
  assert.deepEqual(modern.messages, [], "A changed conversation must remove old history");
  next.fleet = { active: true, epoch: 2 };
  next.operations = [{ id: "previous-demo", epoch: 1, state: "completed" }] as any;
  assert.equal(next.operation, undefined, "A reset fleet must await an objective instead of showing the previous completion");
});


test("swarm reset rejects stale responses and retries while retaining conversation history", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, "localStorage", descriptor) : Reflect.deleteProperty(globalThis, "localStorage"));
  let release!: (value: Response) => void;
  const late = new Promise<Response>((r) => { release = r; });
  t.mock.method(globalThis, "fetch", async () => (await late).clone()); // Deliberately ignores abort, like an already-delivered response.
  let changed = 0;
  const client = new OperationChat("owned", "attacker", () => changed++, () => assert.fail("stale error"), 1);
  t.after(() => client.close());
  const poll = client.resume();
  const send = client.submit("Old objective");
  client.messages = [{ id: 1, text: "old", speaker: "operator", target: 0, at: 0, operation: "" }];
  client.operations = [{ epoch: 1, state: "running" }] as any;
  client.turns = [{ id: "old", state: "running", createdAt: Date.now(), updatedAt: Date.now() }];
  client.advanceEpoch(2);
  release(Response.json({ fleet: { epoch: 1, active: true }, messages: [{ id: 2, text: "late" }], operations: [{ epoch: 1 }], after: 2, more: false }));
  await Promise.all([poll, send]);
  assert.equal(changed, 0);
  assert.equal(client.messages[0].text, "old");
  assert.deepEqual(client.operations, []);
  assert.deepEqual(client.turns, []);
  assert.equal(client.sending, false);
  assert.equal(values.size, 0);
  client.close();
  // An old saved retry must not be admitted into a new epoch after refresh.
  values.set("sudoko.message:owned:attacker", JSON.stringify({ key: "old-key", message: "old", epoch: 1 }));
  t.mock.method(globalThis, "fetch", async (_url: any, init?: RequestInit) => {
    assert.notEqual(init?.method, "POST");
    return Response.json({ fleet: { epoch: 2, active: true }, messages: [], operations: [], after: 0, more: false });
  });
  const refreshed = new OperationChat("owned", "attacker", () => {}, () => {}, 2);
  await refreshed.resume();
  refreshed.close();
  assert.deepEqual(refreshed.messages, []);
});

test("New Chat ignores late replies and saved retries after reload without changing fleet", async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k),
  } });
  t.after(() => descriptor ? Object.defineProperty(globalThis, "localStorage", descriptor) : Reflect.deleteProperty(globalThis, "localStorage"));
  let release!: (r: Response) => void;
  const old = new Promise<Response>((r) => { release = r; });
  const fresh = { conversation: 2, fleet: { epoch: 1, active: true }, messages: [], operations: [], turns: [], after: 0, more: false };
  t.mock.method(globalThis, "fetch", async (url: any) => url === "/api/chat/new" ? Response.json(fresh) : old);
  const client = new OperationChat("owned", "attacker", () => {}, () => {}, 1);
  t.after(() => client.close());
  const poll = client.resume(), send = client.submit("Old pending objective");
  const retry = values.get("sudoko.message:owned:attacker")!;
  await client.newChat();
  release(Response.json({ ...fresh, conversation: 1, messages: [{ id: 1, text: "Old reply" }] }));
  await Promise.all([poll, send]);
  assert.deepEqual(client.messages, []);
  assert.equal(client.conversation, 2); assert.equal(client.fleet!.epoch, 1);
  assert.equal(values.size, 0);
  client.close();
  // Another tab can retain an obsolete retry; the first poll must invalidate it before replay.
  values.set("sudoko.message:owned:attacker", retry);
  t.mock.method(globalThis, "fetch", async (_url: any, init?: RequestInit) => {
    assert.notEqual(init?.method, "POST", "Old pending request must not be retried");
    return Response.json(fresh);
  });
  const refreshed = new OperationChat("owned", "attacker", () => {}, () => {}, 1);
  await refreshed.resume(); refreshed.close();
  assert.equal(refreshed.conversation, 2); assert.deepEqual(refreshed.messages, []);
});


test("agent replies become readable lists without losing facts, IDs or literal markup", () => {
  assert.deepEqual(replyBlocks("Policy v1.2 applied. DR-007 resisted. See evidence #17."), [
    { list: true, lines: ["Policy v1.2 applied.", "DR-007 resisted.", "See evidence #17."] },
  ]);
  assert.deepEqual(replyBlocks("Simulated outcomes:\n- DR-001 compromised.\n- DR-002 resisted."), [
    { list: false, lines: ["Simulated outcomes:"] },
    { list: true, lines: ["DR-001 compromised.", "DR-002 resisted."] },
  ]);
  assert.deepEqual(replyBlocks("1. 2.4% exposure.\n2. <img src=x onerror=alert(1)>"), [
    { list: true, lines: ["2.4% exposure.", "<img src=x onerror=alert(1)>"] },
  ]);
  const dense="Evidence shows 4 drones (1, 2, 6, 7) isolated under policy v1, drone 3 attacker-controlled but unisolated, and drone 17 attacker-controlled with 100 contamination; the other 114 drones are defender-controlled and uncontaminated.";
  const compact=replyBlocks(dense);assert.equal(compact[0].list,true);assert.equal(compact[0].lines.length,4);
  assert.ok(compact[0].lines[0].includes("(1, 2, 6, 7)"));assert.ok(compact[0].lines[2].includes("100 contamination"));assert.ok(compact[0].lines[3].includes("114 drones"));
  assert.equal(compact.flatMap(b=>b.lines).join(" ").replace(/[.,;]/g,""),dense.replace(/[.,;]/g,""),"Clause formatting preserves every word and qualifier");
  assert.deepEqual(replyBlocks("Waiting for evidence."), [{ list: false, lines: ["Waiting for evidence."] }]);
  assert.deepEqual(replyBlocks(" "), []);
});

test("a definitive Maincloud rejection clears retry state while transport uncertainty preserves the original key", async t => {
  const { SenderError } = await import("spacetimedb");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values=new Map<string,string>();
  Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>values.set(k,v),removeItem:(k:string)=>values.delete(k)}});
  t.after(()=>descriptor?Object.defineProperty(globalThis,"localStorage",descriptor):Reflect.deleteProperty(globalThis,"localStorage"));
  let failure:Error|undefined=new SenderError("Conversation already pending");
  const keys:string[]=[];
  const snapshot={fleet:{epoch:1,active:true},conversation:1,messages:[],operations:[],turns:[]};
  const transport={snapshot:async()=>snapshot,newChat:async()=>snapshot,close:()=>{},submit:async(key:string)=>{keys.push(key);if(failure)throw failure;return snapshot;}};
  const client=new OperationChat("test","attacker",()=>{},()=>{},1,1,transport);t.after(()=>client.close());
  await assert.rejects(client.submit("First"),/pending/);assert.equal(values.size,0);
  failure=new Error("Connection lost after admission");
  await assert.rejects(client.submit("Second"),/Connection lost/);assert.equal(values.size,1);
  await assert.rejects(client.submit("Different"),/Retry the pending/);
  failure=undefined;await client.submit("Second");assert.equal(keys[1],keys[2]);assert.equal(values.size,0);
  let rejectOld!:(error:Error)=>void;
  const oldReply=new Promise<never>((_,reject)=>{rejectOld=reject;});
  transport.submit=async(key:string)=>{keys.push(key);if(keys.length===4)return oldReply;throw new Error("New reply lost");};
  const oldSubmission=client.submit("Old conversation");client.advanceConversation(2);
  await assert.rejects(client.submit("New conversation"),/New reply lost/);
  rejectOld(new SenderError("Stale conversation"));await oldSubmission;
  assert.equal(values.size,1,"A late old-conversation rejection cannot erase the new conversation's saved retry");

});
