import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { readJson, send } from "./server.ts";
import { StoreError, RunStore } from "./run-store.ts";
import { FleetChat, chatModels, type ChatRole } from "./fleet-chat.ts";
import type { spacetimeConfig } from "./spacetime.ts";

// Browser sessions carry only an encrypted, already-granted viewer credential.
// Backend role/owner/provider credentials never leave this process.
export function fleetWeb(options: {
  fleet: NonNullable<ReturnType<typeof spacetimeConfig>>;
  chat: FleetChat;
  store: RunStore;
  secret: string;
  env: NodeJS.ProcessEnv;
}) {
  const { fleet, chat, store, env } = options;
  const encryptionKey = createHash("sha256")
    .update("sudoko-fleet-session:" + options.secret)
    .digest();
  const publicOrigin = env.SUDOKO_PUBLIC_ORIGIN;
  const allowedOrigins = new Set([publicOrigin, ...(env.SUDOKO_ALLOWED_ORIGINS || "").split(",")].filter((s): s is string => !!s));
  for (const origin of allowedOrigins) if (new URL(origin).origin !== origin) throw Error("SUDOKO_ALLOWED_ORIGINS must contain exact origins");
  const demo = env.SUDOKO_DEMO_MODE === "1";
  if (publicOrigin && new URL(publicOrigin).origin !== publicOrigin)
    throw Error("SUDOKO_PUBLIC_ORIGIN must be an origin");
  const encrypt = (value: object) => {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
    const body = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
  };
  const authenticate = async (token: string) => {
    if (!token || token.length > 6000 || token === fleet.token)
      throw new StoreError(401, "A granted fleet viewer identity is required");
    const r = await fetch(`${fleet.uri}/v1/database/${fleet.database}/sql`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "text/plain",
      },
      body: "SELECT * FROM visible_fleet_access",
    });
    if (!r.ok) {
      await r.body?.cancel();
      throw new StoreError(401, "Fleet identity authentication failed");
    }
    const data: any = await r.json(),
      table = data[0];
    const row = table?.rows?.[0];
    const roleIndex = table?.schema?.elements?.findIndex(
      (e: any) => e.name?.some === "role",
    );
    const role = row?.[roleIndex];
    if (!["attacker", "defender", "observer"].includes(role))
      throw new StoreError(403, "Identity has no fleet access grant");
    return role as ChatRole | "observer";
  };
  const session = async (req: IncomingMessage) => {
    try {
      const value = req.headers.cookie
        ?.split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith("sudoko_session="))
        ?.slice(15);
      if (!value || value.length > 12000) throw Error();
      const data = Buffer.from(value, "base64url");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        encryptionKey,
        data.subarray(0, 12),
      );
      decipher.setAuthTag(data.subarray(12, 28));
      const decoded = JSON.parse(
        Buffer.concat([
          decipher.update(data.subarray(28)),
          decipher.final(),
        ]).toString(),
      );
      if (
        decoded.expires <= Date.now() ||
        decoded.sandbox !== fleet.database ||
        typeof decoded.token !== "string"
      )
        throw Error();
      const role = await authenticate(decoded.token);
      if (decoded.role !== role) throw Error();
      return { ...decoded, role };
    } catch {
      throw new StoreError(
        401,
        "Sign in with a granted sandbox identity at /signin",
      );
    }
  };
  const body = async (req: IncomingMessage) => {
    try {
      return await readJson(req);
    } catch {
      throw new StoreError(400, "Invalid JSON body");
    }
  };
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    const assets: Record<string, [string, string]> = {
      "/": ["web/fleet.html", "text/html"],
      "/fleet.js": ["web/dist/fleet.js", "text/javascript"],
      "/assets/swarm-blockout.glb": [
        "web/assets/swarm-blockout.glb",
        "model/gltf-binary",
      ],
    };
    if (req.method === "GET" && assets[url.pathname]) {
      const [path, type] = assets[url.pathname];
      res.setHeader("content-type", type);
      res.setHeader("x-content-type-options", "nosniff");
      res.end(await readFile(path));
      return true;
    }
    if (demo && req.method === "GET" && url.pathname === "/signin") {
      res.writeHead(302, { location: "/" });
      res.end();
      return true;
    }
    if (req.method === "GET" && url.pathname === "/signin") {
      res.setHeader("content-type", "text/html");
      res.setHeader("cache-control", "no-store");
      res.setHeader("referrer-policy", "no-referrer");
      res.end(
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>SudoKO sandbox sign in</title><h1>Sandbox access</h1><p>Use your granted SpacetimeDB viewer token. Your role is verified by the sandbox.</p><form id="login"><label>Viewer token <input id="token" type="password" autocomplete="off" required></label><button>Sign in</button></form><p id="error" role="alert"></p><script>document.getElementById("login").onsubmit=async(e)=>{e.preventDefault();const t=document.getElementById("token");try{const r=await fetch("/api/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:t.value})});t.value="";if(r.ok)location.replace("/");else document.getElementById("error").textContent=(await r.json()).error;}catch{document.getElementById("error").textContent="Could not sign in. Try again.";}};</script></html>',
      );
      return true;
    }
    if (url.pathname !== "/fleet-config" && !url.pathname.startsWith("/api/"))
      return false;
    res.setHeader("cache-control", "no-store");
    // Only explicitly configured origins (or loopback development) may mutate state.
    const origin = req.headers.origin && allowedOrigins.has(req.headers.origin)
      ? req.headers.origin : publicOrigin || `http://${req.headers.host}`;
    if (
      !publicOrigin && !allowedOrigins.has(origin) &&
      !["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname)
    )
      throw new StoreError(
        403,
        "Configure SUDOKO_PUBLIC_ORIGIN for remote browser access",
      );
    if (req.headers.origin && req.headers.origin !== origin)
      throw new StoreError(403, "Cross-origin request denied");
    if (req.headers["sec-fetch-site"] === "cross-site")
      throw new StoreError(403, "Cross-site request denied");
    if (req.method !== "GET" && req.headers.origin !== origin)
      throw new StoreError(403, "Same-origin request required");
    if (url.pathname === "/api/session" && req.method === "POST") {
      const b: any = await body(req);
      if (!b || Object.keys(b).length !== 1 || typeof b.token !== "string")
        throw new StoreError(400, "Viewer token required");
      const role = await authenticate(b.token);
      const value = encrypt({
        token: b.token,
        role,
        sandbox: fleet.database,
        expires: Date.now() + 12 * 60 * 60 * 1000,
      });
      res.setHeader(
        "set-cookie",
        `sudoko_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${origin.startsWith("https:") ? "; Secure" : ""}`,
      );
      send(res, { status: 200, body: { role, sandbox: fleet.database } });
      return true;
    }
    // The hackathon server explicitly grants both demo roles; ordinary sessions remain role-bound.
    let viewer;
    if (demo) {
      const role =
        url.pathname === "/fleet-config"
          ? (url.searchParams.get("role") ?? "attacker")
          : (req.headers["x-sudoko-role"] ?? "attacker");
      if (role !== "attacker" && role !== "defender")
        throw new StoreError(403, "Unknown demo role");
      const token = env[`SUDOKO_DEMO_${role.toUpperCase()}_VIEWER_TOKEN`];
      if (!token || (await authenticate(token)) !== role)
        throw new StoreError(503, "Demo role is not configured");
      viewer = { role, token, sandbox: fleet.database };
    } else viewer = await session(req);
    if (url.pathname === "/fleet-config" && req.method === "GET") {
      const [fleetState] = await store.query(
        "SELECT * FROM fleet_session WHERE id=0",
      );
      const fixtures =
        (await store.query("SELECT * FROM agent_schedule")).length > 0;
      send(res, {
        status: 200,
        body: {
          uri: (url.searchParams.get("internet") === "1" ? env.FLEET_INTERNET_URI : undefined) || env.FLEET_PUBLIC_URI || fleet.uri,
          fallbackUri: url.searchParams.get("internet") === "1" && env.FLEET_INTERNET_URI !== env.FLEET_PUBLIC_URI ? env.FLEET_PUBLIC_URI : undefined,
          database: fleet.database,
          sandbox: fleet.database,
          role: viewer.role,
          token: viewer.token,
          authenticated: true,
          demo,
          switchableRoles: demo ? ["attacker", "defender"] : [viewer.role],
          chat: viewer.role !== "observer",
          epoch: fleetState?.epoch,
          engine: fixtures ? "fixture" : "bitdeer",
          models: chatModels(env),
        },
      });
      return true;
    }
    if (viewer.role === "observer")
      throw new StoreError(403, "Observer sessions cannot deploy agents");
    if (url.pathname === "/api/chat/reset" && req.method === "POST") {
      if (!demo) throw new StoreError(403, "Reset is available only in demo mode");
      const b: any = await body(req);
      if (!b || Object.keys(b).length !== 1 || !Number.isSafeInteger(b.epoch) || b.epoch < 1)
        throw new StoreError(400, "Current fleet epoch required");
      send(res, { status: 200, body: await chat.endFleet(b.epoch) });
      return true;
    }
    if (url.pathname === "/api/chat/conversation" && req.method === "GET") {
      send(res, {
        status: 200,
        body: await chat.conversation(
          viewer.role,
          Number(url.searchParams.get("after") ?? 0),
        ),
      });
      return true;
    }
    if (
      ["/api/chat/operations", "/api/chat/messages"].includes(url.pathname) &&
      req.method === "POST"
    ) {
      const b: any = await body(req);
      if (
        !b ||
        Object.keys(b).some(
          (k) => !["message", "sandbox", "target"].includes(k),
        ) ||
        typeof b.message !== "string" ||
        b.sandbox !== viewer.sandbox
      )
        throw new StoreError(
          400,
          "Message and authenticated sandbox required; role is server-derived",
        );
      const key = String(req.headers["idempotency-key"] ?? "");
      const operation = await (url.pathname.endsWith("/messages")
        ? chat.message(viewer.role, b.message, key, b.target)
        : chat.start(viewer.role, b.message, key, b.target));
      send(res, { status: 202, body: operation });
      return true;
    }
    const route =
      /^\/api\/chat\/operations\/([a-f0-9-]{36})(?:\/(stop))?$/.exec(
        url.pathname,
      );
    if (route && req.method === "GET" && !route[2]) {
      send(res, { status: 200, body: await chat.get(route[1], viewer.role) });
      return true;
    }
    if (route && req.method === "POST" && route[2] === "stop") {
      send(res, { status: 200, body: await chat.stop(route[1], viewer.role) });
      return true;
    }
    throw new StoreError(404, "Browser route not found");
  };
}
