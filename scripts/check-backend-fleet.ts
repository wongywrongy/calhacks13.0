import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { startService } from "../sandbox/src/service.ts";
const binary = process.env.SPACETIME_BINARY;
if (!binary) throw Error("Set SPACETIME_BINARY to the local standalone binary");
const dir = await mkdtemp("/tmp/sudoko-backend-fleet-");
const keys = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
await writeFile(dir + "/private.pem", keys.privateKey, { mode: 0o600 });
await writeFile(dir + "/public.pem", keys.publicKey);
const uri = "http://127.0.0.1:3012";
const child = spawn(
  binary,
  [
    "start",
    "--listen-addr",
    "127.0.0.1:3012",
    "--data-dir",
    dir + "/data",
    "--in-memory",
    "--jwt-priv-key-path",
    dir + "/private.pem",
    "--jwt-pub-key-path",
    dir + "/public.pem",
    "--non-interactive",
  ],
  { stdio: "ignore" },
);
let service: Awaited<ReturnType<typeof startService>> | undefined;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(uri + "/v1/ping")).ok) break;
    } catch {}
    if (child.exitCode !== null) throw Error("SpacetimeDB failed to start");
    await delay(100);
  }
  const owner = (await fetch(uri + "/v1/identity", { method: "POST" }).then(
    (r) => r.json(),
  )) as any;
  const database = "backend-check-" + Date.now();
  const deployed = await fetch(
    `${uri}/v1/database/${database}?host_type=Wasm`,
    {
      method: "PUT",
      headers: { authorization: `Bearer ${owner.token}` },
      body: await readFile(
        "arena-live/target/wasm32-unknown-unknown/release/sudoko_live.wasm",
      ),
    },
  );
  assert(deployed.ok, await deployed.text());
  const operator = "backend-check-operator-00000000000000",
    observer = "backend-check-observer-00000000000000";
  service = await startService({
    operatorToken: operator,
    observerToken: observer,
    database: ":memory:",
    env: {
      SPACETIME_URI: uri,
      SPACETIME_DATABASE: database,
      SPACETIME_TOKEN: owner.token,
    },
  });
  const call = async (path: string, body: any, token = operator) => {
    const r = await fetch(service!.url + path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const viewer = (await fetch(uri + "/v1/identity", { method: "POST" }).then(
    (r) => r.json(),
  )) as any;
  assert.equal(
    (
      await call(
        "/v1/fleet/grants",
        { identity: viewer.identity, role: "observer" },
        observer,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/v1/fleet/grants", {
        identity: viewer.identity,
        role: "observer",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call("/v1/fleet/start", {
        drones: 128,
        attackers: 16,
        defenders: 16,
        hardened: true,
      })
    ).status,
    200,
  );
  await delay(1500);
  const read = async () => {
    const r = await fetch(`${uri}/v1/database/${database}/sql`, {
      method: "POST",
      headers: { authorization: `Bearer ${viewer.token}` },
      body: "SELECT * FROM visible_drones",
    });
    assert(r.ok);
    return (await r.json()) as any;
  };
  const initial = await read();
  assert.equal(initial[0].rows.length, 128);
  assert.equal((await call("/v1/fleet/stop", {})).status, 200);
  const stopped = await read();
  await delay(400);
  assert.deepEqual(
    (await read())[0].rows.sort((a: any, b: any) => a[0] - b[0]),
    stopped[0].rows.sort((a: any, b: any) => a[0] - b[0]),
  );
  console.log(
    JSON.stringify({
      passed: true,
      drones: 128,
      agents: 32,
      checks: [
        "authenticated service routes",
        "observer write denial",
        "scoped viewer grant",
        "SpacetimeDB start",
        "SpacetimeDB stop freezes state",
      ],
    }),
  );
} finally {
  await service?.close();
  child.kill();
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  await rm(dir, { recursive: true, force: true });
}
