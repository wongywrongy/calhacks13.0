import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { startService } from "../src/service.ts";
import { RunStore } from "../src/run-store.ts";
import { DecisionPool } from "../src/decision-pool.ts";
import type { Actor } from "../src/catalog.ts";
const operator = "test-operator-credential-0000000000000000";
const observer = "test-observer-credential-0000000000000000";
const request = async (
  base: string,
  path: string,
  body?: any,
  token = operator,
  key = "request-1",
) => {
  const r = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
};
async function finished(url: string, id: string) {
  for (let i = 0; i < 100; i++) {
    const r = await request(url, `/v1/runs/${id}`);
    if (!["queued", "running", "stopping"].includes(r.body.state))
      return r.body;
    await delay(100);
  }
  throw Error("Run did not finish");
}

test("service runs simultaneous real HTTP matches and persists isolated redacted replay", async () => {
  const dir = await mkdtemp("/tmp/sudoko-service-");
  let service = await startService({
    database: dir + "/runs.sqlite",
    operatorToken: operator,
    observerToken: observer,
    maxActive: 2,
    env: {},
  });
  try {
    assert.equal(
      (await request(service.url, "/v1/capabilities", undefined, "wrong"))
        .status,
      401,
    );
    assert.equal(
      (await request(service.url, "/v1/runs", { engine: "fixture" }, observer))
        .status,
      403,
    );
    assert.equal(
      (await request(service.url, "/v1/runs", { engine: "bitdeer" })).status,
      503,
    );
    assert.equal(
      (
        await request(service.url, "/v1/runs", {
          engine: "fixture",
          target: "https://example.com",
        })
      ).status,
      400,
    );
    const settings = {
      engine: "fixture",
      mode: "baseline",
      durationMs: 3200,
      attackers: 8,
      defenders: 4,
      clients: 6,
      loadProfile: "burst",
      decisions: 20,
    };
    const [a, b] = await Promise.all([
      request(service.url, "/v1/runs", settings, operator, "a"),
      request(service.url, "/v1/runs", settings, operator, "b"),
    ]);
    assert.equal(a.status, 202);
    assert.equal(b.status, 202);
    assert.notEqual(a.body.id, b.body.id);
    assert.equal(
      (await request(service.url, "/v1/capabilities")).body.runs.active,
      2,
    );
    assert.equal(
      (await request(service.url, "/v1/runs", settings, operator, "a")).body.id,
      a.body.id,
    );
    assert.equal(
      (
        await request(
          service.url,
          "/v1/runs",
          { ...settings, mode: "hardened" },
          operator,
          "a",
        )
      ).status,
      409,
    );
    const runs = await Promise.all([
      finished(service.url, a.body.id),
      finished(service.url, b.body.id),
    ]);
    for (const run of runs) {
      assert.equal(run.state, "completed");
      assert.equal(
        run.snapshot.actors.filter(
          (a: any) => !["client", "probe"].includes(a.role),
        ).length,
        24,
      );
      assert(run.snapshot.events.some((e: any) => e.kind === "request"));
      assert(run.snapshot.events.some((e: any) => e.kind === "rule_change"));
      assert(run.snapshot.events.some((e: any) => e.kind === "capture"));
      assert(!JSON.stringify(run).includes("FLAG_"));
      assert(!JSON.stringify(run).includes(operator));
    }
    assert.notEqual(runs[0].snapshot.id, runs[1].snapshot.id);
    const first = await request(
      service.url,
      `/v1/runs/${a.body.id}/events?limit=7`,
      undefined,
      observer,
    );
    const next = await request(
      service.url,
      `/v1/runs/${a.body.id}/events?limit=7&after=${first.body.nextAfter}`,
      undefined,
      observer,
    );
    assert.equal(first.body.events.length, 7);
    assert(next.body.events.every((e: any) => e.id > first.body.nextAfter));
    assert(
      first.body.events.every((e: any) => e.matchId === runs[0].snapshot.id),
    );
    await service.close();
    service = await startService({
      database: dir + "/runs.sqlite",
      operatorToken: operator,
    });
    assert.equal(
      (await request(service.url, `/v1/runs/${a.body.id}`)).body.state,
      "completed",
    );
    assert.equal(
      (await request(service.url, `/v1/runs/${a.body.id}/events?limit=7`)).body
        .events.length,
      7,
    );
  } finally {
    await service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("queue admission, cancellation and restart do not invent successful results", async () => {
  const service = await startService({
    database: ":memory:",
    operatorToken: operator,
    maxActive: 1,
    maxQueued: 1,
    env: {},
  });
  try {
    const settings = { engine: "fixture", durationMs: 3000 };
    const a = await request(service.url, "/v1/runs", settings, operator, "a");
    const b = await request(service.url, "/v1/runs", settings, operator, "b");
    assert.equal(b.body.state, "queued");
    assert.equal(
      (await request(service.url, "/v1/runs", settings, operator, "c")).status,
      429,
    );
    assert.equal(
      (await request(service.url, `/v1/runs/${b.body.id}/stop`, {})).body.state,
      "cancelled",
    );
    await request(service.url, `/v1/runs/${a.body.id}/stop`, {});
    assert.equal((await finished(service.url, a.body.id)).state, "cancelled");
  } finally {
    await service.close();
  }
  const dir = await mkdtemp("/tmp/sudoko-restart-");
  try {
    let db = new RunStore(dir + "/runs.sqlite");
    db.insert("crashed", {}, null);
    db.state("crashed", "running");
    db.close();
    db = new RunStore(dir + "/runs.sqlite");
    assert.equal(db.get("crashed")?.state, "interrupted");
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shared inference admission bounds concurrent calls, total spend and cancels queued work", async () => {
  const pool = new DecisionPool(2);
  const abort = new AbortController();
  let calls = 0,
    active = 0,
    peak = 0;
  const engine = async () => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    await delay(25);
    active--;
    return { action: { kind: "wait" as const } };
  };
  const a = pool.wrap(engine, abort.signal, 3),
    b = pool.wrap(engine, abort.signal, 3);
  const actor = {
    id: "a",
    role: "scout",
    team: "red",
    token: "private",
  } as Actor;
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).decide(actor, {}, {})),
  );
  assert.equal(calls, 6);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 6);
  assert.equal(peak, 2);
  assert.equal(pool.status().active, 0);
  const release1 = await pool.acquire(abort.signal),
    release2 = await pool.acquire(abort.signal);
  const waiting = pool.acquire(abort.signal);
  abort.abort();
  await assert.rejects(waiting, /cancelled/);
  release1();
  release2();
  assert.equal(pool.status().queued, 0);
  assert.equal(pool.status().active, 0);
});

test("model service runs obey one inference pool across jobs and never substitute fixtures", async (t) => {
  const original = globalThis.fetch;
  let providerCalls = 0,
    inFlight = 0,
    peak = 0;
  globalThis.fetch = (async (input: any, init: any) => {
    if (
      String(input) === "https://api-inference.bitdeer.ai/v1/chat/completions"
    ) {
      providerCalls++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      await delay(50);
      inFlight--;
      return new Response(
        JSON.stringify({
          choices: [{ message: { refusal: "declined", content: null } }],
        }),
      );
    }
    return original(input, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const service = await startService({
    database: ":memory:",
    operatorToken: operator,
    maxActive: 2,
    inferenceConcurrency: 2,
    env: {
      BITDEER_API_KEY: "synthetic-provider-key",
      BITDEER_MODEL: "test-model",
    },
  });
  try {
    const settings = {
      engine: "bitdeer",
      durationMs: 2000,
      attackers: 2,
      defenders: 1,
      decisions: 3,
      maxModelCalls: 3,
    };
    const a = await request(
        service.url,
        "/v1/runs",
        settings,
        operator,
        "model-a",
      ),
      b = await request(service.url, "/v1/runs", settings, operator, "model-b");
    const results = await Promise.all([
      finished(service.url, a.body.id),
      finished(service.url, b.body.id),
    ]);
    assert.equal(providerCalls, 6);
    assert(peak <= 2);
    for (const run of results) {
      assert.equal(run.state, "failed");
      assert.equal(run.snapshot.engine, "bitdeer");
      assert.equal(run.snapshot.inference.attempted, 3);
      assert.equal(run.snapshot.inference.completed, 0);
      assert(
        run.snapshot.agentTraces.some(
          (t: any) => t.errorCode === "provider_refused",
        ),
      );
      assert(!run.snapshot.agentTraces.some((t: any) => t.action));
      assert(!JSON.stringify(run).includes("synthetic-provider-key"));
    }
  } finally {
    await service.close();
  }
});
