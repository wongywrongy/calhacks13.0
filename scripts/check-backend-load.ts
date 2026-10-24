import { testDatabase } from "../sandbox/test/spacetime-helper.ts";
const db = await testDatabase();
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { startService } from "../sandbox/src/service.ts";
const token = "bounded-load-check-0000000000000000000";
const service = await startService({
  operatorToken: token,
  maxActive: 4,
  env: db.env,
});
const call = async (path: string, body?: any, key = "load") => {
  const r = await fetch(service.url + path, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  assert(r.ok);
  return (await r.json()) as any;
};
try {
  const jobs = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      call(
        "/v1/runs",
        {
          engine: "fixture",
          mode: i % 2 ? "hardened" : "baseline",
          durationMs: 8000,
          attackers: 8,
          defenders: 4,
          clients: 12,
          loadProfile: "burst",
          decisions: 60,
        },
        "load-" + i,
      ),
    ),
  );
  assert.equal((await call("/v1/capabilities")).runs.active, 4);
  const results = await Promise.all(
    jobs.map(async (job) => {
      for (let i = 0; i < 150; i++) {
        const r = await call("/v1/runs/" + job.id);
        if (["completed", "failed", "cancelled"].includes(r.state)) return r;
        await delay(100);
      }
      throw Error("Load run timed out");
    }),
  );
  for (const r of results) {
    assert.equal(r.state, "completed");
    assert.equal(r.snapshot.actors.length, 50);
    assert.equal(r.snapshot.summary.agentErrors, 0);
    assert(r.snapshot.events.some((e: any) => e.kind === "rule_change"));
  }
  const summary = {
    measuredAt: new Date().toISOString(),
    engine: "fixture",
    concurrentRuns: 4,
    securityAgents: 96,
    normalClients: 96,
    referees: 8,
    totalActors: 200,
    scope: "Owned HTTP application capacity; no CPU/kernel stress claim",
    runs: results.map((r) => ({
      id: r.id,
      mode: r.config.mode,
      events: r.snapshot.events.length,
      decisions: r.snapshot.summary.agentDecisions,
      metrics: r.snapshot.summary.metrics,
    })),
  };
  await mkdir("output/backend-load", { recursive: true });
  await writeFile(
    "output/backend-load/summary.json",
    JSON.stringify(summary, null, 2),
  );
  console.log(
    JSON.stringify({
      passed: true,
      concurrentRuns: 4,
      securityAgents: 96,
      totalActors: 200,
      requests: results.reduce(
        (n, r) =>
          n + r.snapshot.events.filter((e: any) => e.kind === "request").length,
        0,
      ),
      report: "output/backend-load/summary.json",
    }),
  );
} finally {
  await service.close();
  await db.close();
}
