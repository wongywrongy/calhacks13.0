import test from "node:test";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { testDatabase } from "./spacetime-helper.ts";
import { spacetimeConfig } from "../src/spacetime.ts";
const integration = { skip: !process.env.SPACETIME_BINARY };
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

test(
  "service runs simultaneous real HTTP matches and persists isolated redacted replay",
  integration,
  async () => {
    const db = await testDatabase();
    let service = await startService({
      operatorToken: operator,
      observerToken: observer,
      maxActive: 2,
      env: db.env,
    });
    try {
      assert.equal(
        (await request(service.url, "/v1/capabilities", undefined, "wrong"))
          .status,
        401,
      );
      assert.equal(
        (
          await request(
            service.url,
            "/v1/runs",
            { engine: "fixture" },
            observer,
          )
        ).status,
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
        (await request(service.url, "/v1/runs", settings, operator, "a")).body
          .id,
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
      await db.restart();
      service = await startService({
        operatorToken: operator,
        env: db.env,
      });
      assert.equal(
        (await request(service.url, `/v1/runs/${a.body.id}`)).body.state,
        "completed",
      );
      assert.equal(
        (await request(service.url, `/v1/runs/${a.body.id}/events?limit=7`))
          .body.events.length,
        7,
      );
    } finally {
      await service.close();
      await db.close();
    }
  },
);

test(
  "queue admission, cancellation and restart do not invent successful results",
  integration,
  async () => {
    const db = await testDatabase();
    const service = await startService({
      operatorToken: operator,
      maxActive: 1,
      maxQueued: 1,
      env: db.env,
    });
    try {
      const settings = { engine: "fixture", durationMs: 3000 };
      const a = await request(service.url, "/v1/runs", settings, operator, "a");
      const b = await request(service.url, "/v1/runs", settings, operator, "b");
      assert.equal(b.body.state, "queued");
      assert.equal(
        (await request(service.url, "/v1/runs", settings, operator, "c"))
          .status,
        429,
      );
      assert.equal(
        (await request(service.url, `/v1/runs/${b.body.id}/stop`, {})).body
          .state,
        "cancelled",
      );
      await request(service.url, `/v1/runs/${a.body.id}/stop`, {});
      assert.equal((await finished(service.url, a.body.id)).state, "cancelled");
    } finally {
      await service.close();
    }
    try {
      const config = spacetimeConfig(db.env)!;
      let store = new RunStore(config);
      await store.open(1, 1);
      const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      await store.insert(id, {}, "crash");
      await store.state(id, "running");
      await store.close();
      store = new RunStore(config);
      await store.open(1, 1);
      assert.equal((await store.get(id))?.state, "interrupted");
      await store.close();
    } finally {
      await db.close();
    }
  },
);

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

test(
  "model service runs obey one inference pool across jobs and never substitute fixtures",
  integration,
  async (t) => {
    const db = await testDatabase();
    t.after(() => db.close());
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
      operatorToken: operator,
      maxActive: 2,
      inferenceConcurrency: 2,
      env: {
        ...db.env,
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
        b = await request(
          service.url,
          "/v1/runs",
          settings,
          operator,
          "model-b",
        );
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
  },
);

test(
  "SpacetimeDB rejects competing schedulers and unauthorized writes, scopes evaluator views",
  integration,
  async () => {
    const db = await testDatabase();
    const store = new RunStore(spacetimeConfig(db.env)!);
    try {
      await store.open(1, 1);
      const second = new RunStore(spacetimeConfig(db.env)!);
      await assert.rejects(second.open(1, 1));
      const id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
      await store.insert(id, { engine: "fixture" }, "dedupe");
      assert.equal(
        (
          await store.insert(
            "cccccccc-cccc-cccc-cccc-cccccccccccc",
            { engine: "fixture" },
            "dedupe",
          )
        ).id,
        id,
      );
      await assert.rejects(
        store.insert(
          "cccccccc-cccc-cccc-cccc-cccccccccccc",
          { engine: "bitdeer" },
          "dedupe",
        ),
      );
      const url = db.env.SPACETIME_URI,
        name = db.env.SPACETIME_DATABASE;
      const viewer = (await fetch(url + "/v1/identity", {
        method: "POST",
      }).then((r) => r.json())) as any;
      const sql = async (q: string) =>
        fetch(`${url}/v1/database/${name}/sql`, {
          method: "POST",
          headers: { authorization: `Bearer ${viewer.token}` },
          body: q,
        });
      assert(!(await sql("SELECT * FROM backend_run")).ok);
      assert.equal(
        (
          (await (
            await sql("SELECT * FROM visible_backend_runs")
          ).json()) as any
        )[0].rows.length,
        0,
      );
      const denied = await fetch(
        `${url}/v1/database/${name}/call/transition_backend_run`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${viewer.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify([store.session, id, "running", ""]),
        },
      );
      assert(!denied.ok);
      await store.call("grant_backend_viewer", [viewer.identity]);
      assert.equal(
        (
          (await (
            await sql("SELECT * FROM visible_backend_runs")
          ).json()) as any
        )[0].rows.length,
        1,
      );
      await build({
        entryPoints: ["sandbox/module_bindings/index.ts"],
        bundle: true,
        platform: "node",
        format: "esm",
        packages: "external",
        outfile: "output/backend-sdk.mjs",
      });
      const { DbConnection } = await import(
        pathToFileURL(resolve("output/backend-sdk.mjs")).href
      );
      let conn: any;
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error("Subscription timeout")),
            8000,
          );
          conn = DbConnection.builder()
            .withUri(url)
            .withDatabaseName(name)
            .withToken(viewer.token)
            .onConnect((c: any) =>
              c
                .subscriptionBuilder()
                .onApplied(() => {
                  clearTimeout(timer);
                  resolve();
                })
                .subscribe([
                  "SELECT * FROM visible_backend_runs",
                  "SELECT * FROM visible_backend_events",
                ]),
            )
            .onConnectError((_c: any, e: any) => {
              clearTimeout(timer);
              reject(e);
            })
            .build();
        });
        assert.equal([...conn.db.visibleBackendRuns.iter()].length, 1);
        const changed = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(Error("Live transition timeout")),
            5000,
          );
          conn.db.visibleBackendRuns.onInsert(() => {
            if (
              [...conn.db.visibleBackendRuns.iter()].some(
                (r: any) => r.state === "running",
              )
            ) {
              clearTimeout(timer);
              resolve();
            }
          });
        });
        await store.state(id, "running");
        await changed;
      } finally {
        conn?.disconnect();
      }
      await store.state(id, "completed");
      await assert.rejects(store.state(id, "running"));
    } finally {
      await store.close();
      await db.close();
    }
  },
);
