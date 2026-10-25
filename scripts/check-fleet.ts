import { FLEET, slot } from "../shared/fleet.ts";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { readFile, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

let localProcess: ReturnType<typeof spawn> | undefined;
let temporary: string | undefined;
const uri = process.env.CHECK_SPACETIME_URI ?? "http://127.0.0.1:3011";
if (process.env.SPACETIME_BINARY) {
  temporary = await mkdtemp("/tmp/sudoko-stdb-test-");
  const keys = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await writeFile(`${temporary}/private.pem`, keys.privateKey, { mode: 0o600 });
  await writeFile(`${temporary}/public.pem`, keys.publicKey);
  localProcess = spawn(
    process.env.SPACETIME_BINARY,
    [
      "start",
      "--listen-addr",
      new URL(uri).host,
      "--data-dir",
      `${temporary}/data`,
      "--in-memory",
      "--jwt-priv-key-path",
      `${temporary}/private.pem`,
      "--jwt-pub-key-path",
      `${temporary}/public.pem`,
      "--non-interactive",
    ],
    { stdio: "ignore" },
  );
  process.on("exit", () => localProcess?.kill());
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${uri}/v1/ping`)).ok) break;
    } catch {}
    if (localProcess.exitCode !== null)
      throw new Error(`Spacetime exited: ${localProcess.exitCode}`);
    await delay(200);
  }
}
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(uri))
  throw new Error(
    "Integration check only creates databases on a local test server",
  );
/** Horizontal distance of each drone from the healthy drones' shared formation offset. */
function formationDeviation(drones: any[]): [any, number][] {
  const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1];
  const healthy = drones.filter((d) => d.controller !== "attacker");
  const ox = median(healthy.map((d) => d.x - slot(d.id)[0])),
    oy = median(healthy.map((d) => d.y - slot(d.id)[1]));
  return drones.map((d) => [d, Math.hypot(d.x - slot(d.id)[0] - ox, d.y - slot(d.id)[1] - oy)]);
}
const database = `sudoko-check-${Date.now()}`;
const identityResponse = await fetch(`${uri}/v1/identity`, { method: "POST" });
assert(identityResponse.ok, "local identity creation");
const identity = (await identityResponse.json()) as any;
assert.equal(typeof identity.token, "string");
const headers = { authorization: `Bearer ${identity.token}` };
const published = await fetch(`${uri}/v1/database/${database}?host_type=Wasm`, {
  method: "PUT",
  headers,
  body: await readFile(
    "arena-live/target/wasm32-unknown-unknown/release/sudoko_live.wasm",
  ),
});
assert(
  published.ok,
  `Module deployment: ${published.status} ${await published.text()}`,
);
console.log("Compiled module deployed to a new local test database.");

const call = async (name: string, args: any[], token = identity.token) =>
  fetch(`${uri}/v1/database/${database}/call/${name}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(args),
  });
const sql = async (query: string, token = identity.token) => {
  const r = await fetch(`${uri}/v1/database/${database}/sql`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
    body: query,
  });
  return {
    ok: r.ok,
    status: r.status,
    data: r.ok ? await r.json() : await r.text(),
  };
};
const rows = (result: any) => {
  assert(result.ok, JSON.stringify(result.data));
  const t = result.data[0];
  return t.rows.map((row: any[]) =>
    Object.fromEntries(row.map((v, i) => [t.schema.elements[i].name.some, v])),
  );
};
try {
  const viewers: any = {};
  for (const role of ["attacker", "defender", "observer", "outsider"]) {
    const v = (await fetch(`${uri}/v1/identity`, { method: "POST" }).then((r) =>
      r.json(),
    )) as any;
    viewers[role] = v;
    if (role !== "outsider") {
      const r = await call("grant_fleet_view", [v.identity, role]);
      assert(r.ok, await r.text());
    }
  }
  const frame = async (role: string) => ({
    drones: rows(
      await sql("SELECT * FROM visible_drones", viewers[role].token),
    ),
    agents: rows(
      await sql("SELECT * FROM visible_agents", viewers[role].token),
    ),
    events: rows(
      await sql("SELECT * FROM visible_evidence", viewers[role].token),
    ),
  });
  assert(
    !(await call("start_fleet", [FLEET.drones, 8, 8, false], viewers.attacker.token)).ok,
    "viewer cannot reset",
  );
  assert(
    !(
      await call(
        "grant_fleet_view",
        [viewers.attacker.identity, "observer"],
        viewers.attacker.token,
      )
    ).ok,
    "viewer cannot escalate",
  );
  assert(
    !(await sql("SELECT * FROM fleet_drone", viewers.attacker.token)).ok,
    "private drone table inaccessible",
  );
  assert((await call("start_fleet", [FLEET.drones, 8, 8, false])).ok);
  const recording: any = {
    engine: "fixture",
    transport: "Recorded SpacetimeDB entity views",
    durationMs: 0,
    frames: [],
  };
  const began = Date.now();
  for (let i = 0; i < 32; i++) {
    await delay(250);
    recording.frames.push({
      at: Date.now() - began,
      attacker: await frame("attacker"),
      defender: await frame("defender"),
      observer: await frame("observer"),
    });
  }
  recording.durationMs = Date.now() - began;
  const last = recording.frames.at(-1),
    early = recording.frames[1];
  assert.equal(last.observer.drones.length, FLEET.drones);
  assert.equal(last.attacker.agents.length, 8);
  assert.equal(last.defender.agents.length, 8);
  assert.equal(last.observer.agents.length, 16);
  assert(early.attacker.drones.length < FLEET.drones, "undiscovered drones hidden");
  assert(
    last.attacker.events.every(
      (e: any) => !["policy_applied", "recovery_verified"].includes(e.kind),
    ),
    "defense internals hidden",
  );
  assert(
    last.defender.events.every((e: any) => e.kind !== "discovered"),
    "attacker recon hidden",
  );
  assert(
    last.defender.events
      .filter((e: any) => e.kind.startsWith("unauthorized"))
      .every((e: any) => e.actor === 0),
    "attacker identity hidden",
  );
  assert.equal((await frame("outsider")).drones.length, 0);
  assert(
    last.observer.events.some(
      (e: any) => e.kind === "unauthorized_command_accepted",
    ),
  );
  assert(last.observer.events.some((e: any) => e.kind === "recovery_verified"));
  assert(
    new Set(last.observer.drones.map((d: any) => d.tick)).size > 1,
    "independent cadences",
  );
  assert(
    last.observer.drones.every((d: any) => d.tick > 0),
    "all drones operate",
  );
  // Healthy drones fly one shared formation; a held drone is pulled out of it.
  assert(
    recording.frames.some((f: any) =>
      formationDeviation(f.observer.drones).some(
        ([d, dev]: [any, number]) => d.controller === "attacker" && dev > 2,
      ),
    ),
    "a hijacked drone leaves the formation",
  );
  assert((await call("stop_fleet", [])).ok);
  const stopped = await frame("observer");
  await delay(500);
  assert.deepEqual(
    (await frame("observer")).drones,
    stopped.drones,
    "stop freezes drone updates",
  );
  await mkdir("output/fleet", { recursive: true });
  await writeFile("output/fleet/recording.json", JSON.stringify(recording));
  assert((await call("start_fleet", [FLEET.drones, 16, 16, true])).ok);
  await delay(2400);
  const scale = await frame("observer");
  assert.equal(scale.drones.length, FLEET.drones);
  assert.equal(scale.agents.length, 32);
  assert(scale.drones.every((d: any) => d.tick > 0));
  assert(
    !scale.events.some((e: any) => e.kind === "unauthorized_command_accepted"),
    "hardened authorization blocks command takeover",
  );
  assert(scale.events.some((e: any) => e.status === 403));
  assert(
    formationDeviation(scale.drones).every(([, dev]: [any, number]) => dev < 1.5),
    "untouched drones fly in lockstep formation",
  );
  // Verify real WebSocket subscriptions as well as SQL projections.
  await build({
    entryPoints: ["web/module_bindings/index.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: "output/fleet/client.mjs",
  });
  const { DbConnection } = await import(
    pathToFileURL(resolve("output/fleet/client.mjs")).href
  );
  for (const role of ["attacker", "defender", "observer", "outsider"]) {
    let connection: any;
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(Error("Subscription timeout: " + role)),
          8000,
        );
        connection = DbConnection.builder()
          .withUri(uri)
          .withDatabaseName(database)
          .withToken(viewers[role].token)
          .onConnect((c: any) => {
            c.subscriptionBuilder()
              .onApplied(() => {
                try {
                  assert.equal(
                    [...c.db.visibleAgents.iter()].length,
                    role === "outsider" ? 0 : role === "observer" ? 32 : 16,
                  );
                  assert(
                    [...c.db.visibleAgents.iter()].every(
                      (a: any) => role === "observer" || a.role === role,
                    ),
                  );
                  clearTimeout(timeout);
                  resolve();
                } catch (e) {
                  clearTimeout(timeout);
                  reject(e);
                }
              })
              .subscribe([
                "SELECT * FROM visible_drones",
                "SELECT * FROM visible_agents",
                "SELECT * FROM visible_evidence",
              ]);
          })
          .onConnectError((_c: any, e: any) => {
            clearTimeout(timeout);
            reject(e);
          })
          .build();
      });
    } finally {
      connection?.disconnect();
    }
  }
  // A clean measured reducer snapshot also drives the formation screenshots and replay check.
  assert((await call("start_fleet", [FLEET.drones, 0, 0, false])).ok);
  assert((await call("stop_fleet", [])).ok);
  const clean = { at: 0, attacker: await frame("attacker"), defender: await frame("defender"), observer: await frame("observer") };
  assert.equal(clean.defender.drones.length, FLEET.drones);
  assert.equal(clean.attacker.drones.length, 0);
  for (const drone of clean.defender.drones) {
    const [x, y] = slot(drone.id);
    assert.ok(Math.abs(drone.x - x) < 0.001 && Math.abs(drone.y - y) < 0.001, "Rust and client slots agree");
    assert.equal(drone.controller, "defender");
  }
  await writeFile("output/fleet/formation.json", JSON.stringify({ engine: "fixture", transport: "Recorded SpacetimeDB entity views", durationMs: 0, frames: [clean] }));
  console.log(
    JSON.stringify({
      passed: true,
      testedDrones: FLEET.drones,
      testedAgents: 32,
      recordedDrones: FLEET.drones,
      recordedAgents: 16,
      checks: [
        "scoped views",
        "private table denial",
        "role escalation denial",
        "independent schedules",
        "command breach",
        "verified recovery",
        "hardened blocking",
        "stop",
        "fresh epoch",
      ],
      recording: "output/fleet/recording.json",
    }),
  );
  if (process.argv.includes("--serve")) {
    await call("start_fleet", [FLEET.drones, 8, 8, false]);
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (req.method !== "GET") {
          res.writeHead(405);
          res.end();
          return;
        }
        if (url.pathname === "/fleet-config") {
          const role = url.searchParams.get("role") ?? "attacker";
          if (!["attacker", "defender", "observer"].includes(role)) {
            res.writeHead(400);
            res.end();
            return;
          }
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          // Browsers connect to SpacetimeDB directly; a reverse proxy can hand out its own address.
          res.end(
            JSON.stringify({
              uri: process.env.FLEET_PUBLIC_URI ?? uri,
              database,
              role,
              token: viewers[role].token,
            }),
          );
          return;
        }
        const path =
          url.pathname === "/"
            ? "web/fleet.html"
            : url.pathname === "/fleet.js"
              ? "web/dist/fleet.js"
              : url.pathname === "/theme.css"
                ? "web/theme.css"
              : url.pathname === "/assets/swarm-blockout.glb"
                ? "web/assets/swarm-blockout.glb"
                : url.pathname === "/assets/environments/sudoko-dusk-basin.webp"
                  ? "web/assets/environments/sudoko-dusk-basin.webp" : null;
        if (!path) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.setHeader(
          "content-type",
          path.endsWith(".html")
            ? "text/html"
            : path.endsWith(".css")
              ? "text/css"
            : path.endsWith(".glb")
              ? "model/gltf-binary"
              : path.endsWith(".webp") ? "image/webp" : "text/javascript",
        );
        res.end(await readFile(path));
      } catch {
        res.writeHead(500);
        res.end("Fleet server error");
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(process.env.FLEET_PORT ?? 4174), "127.0.0.1", resolve);
    });
    console.log(
      `Fleet demo: http://127.0.0.1:${(server.address() as any).port}. Enter restarts a 60-second baseline; Ctrl+C stops. Loopback operator access permits all three workspaces.`,
    );
    process.stdin.on("data", () => void call("start_fleet", [FLEET.drones, 8, 8, false]));
    process.stdin.resume();
    await new Promise<void>((resolve) =>
      process.once("SIGINT", () => resolve()),
    );
    server.close();
    process.stdin.pause();
  }
} finally {
  await fetch(`${uri}/v1/database/${database}`, { method: "DELETE", headers });
  localProcess?.kill();
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
