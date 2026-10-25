import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:net";
export async function testDatabase(modulePath = "arena-live/target/wasm32-unknown-unknown/release/sudoko_live.wasm", environment: Record<string,string> = {}) {
  const binary = process.env.SPACETIME_BINARY;
  if (!binary) throw Error("Set SPACETIME_BINARY for real database tests");
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const port = (reservation.address() as any).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const dir = await mkdtemp("/tmp/backend-spacetime-");
  const keys = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await writeFile(dir + "/private.pem", keys.privateKey, { mode: 0o600 });
  await writeFile(dir + "/public.pem", keys.publicKey);
  const uri = `http://127.0.0.1:${port}`;
  const launch = () =>
    spawn(
      binary,
      [
        "start",
        "--listen-addr",
        `127.0.0.1:${port}`,
        "--data-dir",
        dir + "/data",
        "--jwt-priv-key-path",
        dir + "/private.pem",
        "--jwt-pub-key-path",
        dir + "/public.pem",
        "--non-interactive",
      ],
      { stdio: "ignore" },
    );
  let child = launch();
  const wait = async () => {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(uri + "/v1/ping")).ok) return;
      } catch {}
      if (child.exitCode !== null) throw Error("SpacetimeDB exited");
      await delay(100);
    }
    throw Error("SpacetimeDB startup timeout");
  };
  const stop = async () => {
    child.kill();
    if (child.exitCode === null)
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  };
  const restart = async () => {
    await stop();
    child = launch();
    await wait();
  };
  const close = async () => {
    child.kill();
    if (child.exitCode === null)
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await rm(dir, { recursive: true, force: true });
  };
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(uri + "/v1/ping")).ok) break;
      } catch {}
      if (child.exitCode !== null) throw Error("SpacetimeDB exited");
      await delay(100);
    }
    const owner = (await fetch(uri + "/v1/identity", { method: "POST" }).then(
      (r) => r.json(),
    )) as any;
    const database = "backend-test-" + Date.now();
    const headers = new Headers({authorization: `Bearer ${owner.token}`});
    for (const [key,value] of Object.entries(environment)) headers.append("spacetime-environment", `${key}=${value}`);
    const r = await fetch(`${uri}/v1/database/${database}?host_type=Wasm`, {
      method: "PUT",
      headers,
      body: await readFile(
        modulePath,
      ),
    });
    if (!r.ok) throw Error("Module deployment failed: " + (await r.text()));
    return {
      env: {
        SPACETIME_URI: uri,
        SPACETIME_DATABASE: database,
        SPACETIME_TOKEN: owner.token,
      },
      close,
      restart,
      pid: () => child.pid!,
      upgrade: async (path: string) => {
        const body=await readFile(path),headers={authorization:`Bearer ${owner.token}`};
        const preview=await fetch(`${uri}/v1/database/${database}/pre_publish?host_type=Wasm&style=NoColor`,{method:"POST",headers,body});
        if(!preview.ok)throw Error("Migration preview failed: "+await preview.text());
        const plan:any=await preview.json();
        if(!plan.AutoMigrate)throw Error("Manual migration required: "+JSON.stringify(plan));
        const policy=new URLSearchParams({host_type:"Wasm",policy:"BreakClients",token:String(plan.AutoMigrate.token)});
        const response = await fetch(`${uri}/v1/database/${database}?${policy}`, {method:"PUT",headers,body});
        if (!response.ok) throw Error("Module upgrade failed: " + await response.text());
      },
    };
  } catch (e) {
    await close();
    throw e;
  }
}
