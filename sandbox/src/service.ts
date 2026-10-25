import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { runMatch } from "./run.ts";
import { config } from "./catalog.ts";
import { projectRun } from "./projection.ts";
import { readJson, send } from "./server.ts";
import { DecisionPool } from "./decision-pool.ts";
import { RunStore, StoreError } from "./run-store.ts";
import { FleetChat, type ChatRole } from "./fleet-chat.ts";
import { spacetimeConfig } from "./spacetime.ts";
import { fleetWeb } from "./fleet-web.ts";
import { CHAT_LIMITS, chatModels } from "./fleet-chat.ts";

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const fail = (status: number, message: string): never => {
  throw new HttpError(status, message);
};
const integer = (n: unknown, min: number, max: number, name: string) =>
  Number.isInteger(n) && Number(n) >= min && Number(n) <= max
    ? Number(n)
    : fail(400, `${name} must be ${min}..${max}`);
const object = (value: any, keys: string[]) => {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    fail(400, "Unknown or invalid fields");
};
const equal = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
function parseRun(input: any) {
  object(input, [
    "engine",
    "mode",
    "durationMs",
    "attackers",
    "defenders",
    "clients",
    "loadProfile",
    "decisions",
    "maxModelCalls",
  ]);
  if (!["fixture", "bitdeer"].includes(input.engine))
    fail(400, "Explicit engine fixture or bitdeer required");
  let settings;
  try {
    settings = config(
      Object.fromEntries(
        [
          "mode",
          "durationMs",
          "attackers",
          "defenders",
          "clients",
          "loadProfile",
        ]
          .filter((k) => input[k] !== undefined)
          .map((k) => [k, input[k]]),
      ),
    );
  } catch (e) {
    fail(400, (e as Error).message);
  }
  return {
    ...settings!,
    engine: input.engine as "fixture" | "bitdeer",
    decisions: integer(input.decisions ?? 20, 1, 120, "decisions"),
    maxModelCalls: integer(input.maxModelCalls ?? 60, 1, 1000, "maxModelCalls"),
  };
}

export async function startService(options: {
  operatorToken: string;
  observerToken?: string;
  port?: number;
  host?: string;
  maxActive?: number;
  maxQueued?: number;
  inferenceConcurrency?: number;
  env?: NodeJS.ProcessEnv;
}) {
  if (options.operatorToken.length < 32)
    throw Error("Operator token must be at least 32 characters");
  if (
    options.observerToken &&
    (options.observerToken.length < 32 ||
      options.observerToken === options.operatorToken)
  )
    throw Error("Observer token must be distinct and at least 32 characters");
  const env = options.env ?? process.env;
  const maxActive = integer(options.maxActive ?? 2, 1, 4, "maxActive"),
    maxQueued = integer(options.maxQueued ?? 8, 1, 32, "maxQueued");
  const pool = new DecisionPool(options.inferenceConcurrency ?? 4);
  const fleet = spacetimeConfig(env);
  if (!fleet)
    throw Error(
      "SpacetimeDB is required: set SPACETIME_URI, SPACETIME_DATABASE and SPACETIME_TOKEN",
    );
  const roleTokens = {
    attacker: env.SUDOKO_ATTACKER_TOKEN,
    defender: env.SUDOKO_DEFENDER_TOKEN,
  };
  const credentials = [
    options.operatorToken,
    options.observerToken,
    ...Object.values(roleTokens),
  ].filter(Boolean) as string[];
  if (
    credentials.some((t) => t.length < 32) ||
    new Set(credentials).size !== credentials.length
  )
    throw Error(
      "Service credentials must be distinct and at least 32 characters",
    );
  if (env.SUDOKO_SESSION_SECRET && env.SUDOKO_SESSION_SECRET.length < 32)
    throw Error("Session secret must be at least 32 characters");
  const store = new RunStore(fleet);
  const chat = new FleetChat(store, pool, env);
  const browser = fleetWeb({
    fleet,
    chat,
    store,
    secret: env.SUDOKO_SESSION_SECRET || options.operatorToken,
    env,
  });
  await store.open(maxActive, maxQueued);
  const [initialFleet] = await store.query("SELECT * FROM fleet_session");
  if (!initialFleet || (initialFleet.active && Number(initialFleet.deadline) !== 0))
    await store.call("activate_chat_fleet", [store.session, "attacker"]);
  if (env.BITDEER_API_KEY) await store.call("enable_fleet_chat", []);
  const active = new Map<
    string,
    { abort: AbortController; done: Promise<void> }
  >();
  const pending: string[] = [];
  let closing = false;
  let mutationTail = Promise.resolve();
  const lock = async () => {
    let release!: () => void;
    const previous = mutationTail;
    mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  };
  const configured = () => Boolean(env.BITDEER_API_KEY && env.BITDEER_MODEL);
  let pumping = false;
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (!closing && active.size < maxActive && pending.length) {
        const id = pending.shift()!,
          job = (await store.get(id))!;
        if (job.state !== "queued") continue;
        const abort = new AbortController();
        await store.state(id, "running");
        // Defer execution until the active lease is visible to stop/shutdown.
        const done = Promise.resolve().then(async () => {
          try {
            const result = await runMatch({
              ...job.config,
              signal: abort.signal,
              inferencePool: pool,
              bitdeer: {
                apiKey: env.BITDEER_API_KEY,
                model: env.BITDEER_MODEL ?? "",
              },
              onSnapshot: (snapshot: any) =>
                store.save(id, projectRun(snapshot)),
            });
            await store.save(id, projectRun(result));
            const errors =
              result.infrastructureErrors.length || result.summary.agentErrors;
            await store.state(
              id,
              abort.signal.aborted
                ? "cancelled"
                : errors
                  ? "failed"
                  : "completed",
              errors
                ? "Run recorded execution or inference failures; inspect evidence"
                : null,
            );
          } catch {
            await store
              .state(
                id,
                abort.signal.aborted ? "cancelled" : "failed",
                abort.signal.aborted
                  ? null
                  : "Run execution failed; no fixture substitution was used",
              )
              .catch(() => {
                closing = true;
              });
          } finally {
            active.delete(id);
            void lock()
              .then(async (release) => {
                try {
                  await pump();
                } finally {
                  release();
                }
              })
              .catch(() => {
                closing = true;
                for (const w of active.values()) w.abort.abort();
              });
          }
        });
        active.set(id, { abort, done });
      }
    } finally {
      pumping = false;
    }
  };
  const heartbeat = setInterval(
    () =>
      void store.heartbeat().catch(() => {
        closing = true;
        void chat.close();
        for (const w of active.values()) w.abort.abort();
      }),
    5000,
  );
  const fleetCall = async (name: string, args: unknown[]) => {
    if (!fleet) fail(503, "SpacetimeDB fleet is not configured");
    const r = await fetch(
      `${fleet!.uri}/v1/database/${fleet!.database}/call/${name}`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(8000),
        headers: {
          authorization: `Bearer ${fleet!.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(args),
      },
    );
    if (!r.ok) fail(502, `Fleet reducer rejected operation (HTTP ${r.status})`);
  };
  const server = createServer(async (req, res) => {
    let release: (() => void) | undefined;
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/healthz")
        return send(res, { status: 200, body: { status: "ok" } });
      if (
        closing &&
        (url.pathname.startsWith("/api/") || url.pathname === "/fleet-config")
      )
        fail(503, "Service shutting down");
      if (await browser(req, res, url)) return;
      const credential = req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : "";
      const operator = equal(credential, options.operatorToken);
      const observer =
        options.observerToken && equal(credential, options.observerToken);
      const chatRole = (Object.keys(roleTokens) as ChatRole[]).find(
        (r) => roleTokens[r] && equal(credential, roleTokens[r]!),
      );
      if (url.pathname.startsWith("/v1/chat/")) {
        if (!chatRole) fail(403, "Role-specific chat credential required");
        if (req.headers.origin) fail(403, "Use the same-origin server proxy");
        if (closing) fail(503, "Service shutting down");
        if (req.method === "GET" && url.pathname === "/v1/chat/conversation")
          return send(res, {
            status: 200,
            body: await chat.conversation(
              chatRole!,
              Number(url.searchParams.get("after") ?? 0),
            ),
          });
        if (
          req.method === "POST" &&
          ["/v1/chat/operations", "/v1/chat/messages"].includes(url.pathname)
        ) {
          let b: any;
          try {
            b = await readJson(req);
          } catch {
            fail(400, "Invalid JSON");
          }
          object(b, ["message", "target", "epoch", "conversation"]);
          if (typeof b.message !== "string") fail(400, "Message required");
          if (!Number.isSafeInteger(b.epoch) || b.epoch < 1) fail(400, "Current fleet epoch required");
          if (b.conversation !== undefined && (!Number.isSafeInteger(b.conversation) || b.conversation < 1)) fail(400, "Invalid conversation");
          const operation = await (url.pathname.endsWith("/messages")
            ? chat.message(
                chatRole!,
                b.message,
                String(req.headers["idempotency-key"] ?? ""),
                b.target,
                b.epoch,
                b.conversation,
              )
            : chat.start(
                chatRole!,
                b.message,
                String(req.headers["idempotency-key"] ?? ""),
                b.target,
                undefined,
                b.epoch,
                b.conversation,
              ));
          return send(res, { status: 202, body: operation });
        }
        const route =
          /^\/v1\/chat\/operations\/([a-f0-9-]{36})(?:\/(stop))?$/.exec(
            url.pathname,
          );
        if (route && req.method === "GET" && !route[2])
          return send(res, {
            status: 200,
            body: await chat.get(route[1], chatRole!),
          });
        if (route && req.method === "POST" && route[2] === "stop")
          return send(res, {
            status: 200,
            body: await chat.stop(route[1], chatRole!),
          });
        fail(404, "Chat route not found");
      }
      if (!operator && !observer) fail(401, "Bearer credential required");
      if (req.method !== "GET" && !operator) fail(403, "Operator required");
      // No credentialed cross-origin browser access and no ambient cookie authentication.
      if (req.headers.origin)
        fail(403, "Cross-origin browser requests are not enabled");
      if (req.method !== "GET") release = await lock();
      if (closing) fail(503, "Service shutting down");
      const body = async () => {
        try {
          return await readJson(req);
        } catch {
          return fail(400, "Invalid JSON or body exceeds 8192 bytes");
        }
      };
      if (req.method === "GET" && url.pathname === "/v1/capabilities")
        return send(res, {
          status: 200,
          body: {
            version: 1,
            engines: ["fixture", "bitdeer"],
            bitdeer: {
              configured: configured(),
              model: env.BITDEER_MODEL ?? null,
              verified: false,
            },
            fleet: { configured: Boolean(fleet) },
            limits: {
              maxActive,
              maxQueued,
              attackersPerTeam: 8,
              defendersPerTeam: 4,
              clientsPerTeam: 12,
              durationMs: 120000,
              maxModelCalls: 1000,
            },
            inference: pool.status(),
            chat: {
              models: chatModels(env),
              limits: CHAT_LIMITS,
              configured: Boolean(env.BITDEER_API_KEY),
            },
            runs: { active: active.size, queued: pending.length },
          },
        });
      if (
        req.method === "POST" &&
        url.pathname === "/v1/providers/bitdeer/preflight"
      ) {
        if (!configured())
          fail(503, "Set BITDEER_API_KEY and BITDEER_MODEL on the service");
        const r = await fetch("https://api-inference.bitdeer.ai/v1/models", {
          redirect: "error",
          signal: AbortSignal.timeout(8000),
          headers: { authorization: `Bearer ${env.BITDEER_API_KEY}` },
        });
        if (!r.ok)
          fail(502, `Bitdeer model discovery returned HTTP ${r.status}`);
        const data = (await r.json()) as any;
        const available =
          Array.isArray(data.data) &&
          data.data.some((m: any) => m.id === env.BITDEER_MODEL);
        return send(res, {
          status: available ? 200 : 422,
          body: {
            authenticated: true,
            model: env.BITDEER_MODEL,
            available,
            inferenceVerified: false,
          },
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/runs") {
        const settings = parseRun(await body());
        const key = req.headers["idempotency-key"];
        if (typeof key !== "string" || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(key))
          fail(
            400,
            "Idempotency-Key header required (1..100 simple characters)",
          );
        const existing = await store.byKey(key as string);
        if (existing) {
          if (JSON.stringify(existing.config) !== JSON.stringify(settings))
            fail(409, "Idempotency key was used with different settings");
          return send(res, { status: 200, body: existing });
        }
        if (settings.engine === "bitdeer" && !configured())
          fail(503, "Bitdeer configuration required; no fixture fallback");
        if (pending.length >= maxQueued && active.size >= maxActive)
          fail(429, "Run queue full");
        const job = await store.insert(randomUUID(), settings, key as string);
        if (
          job.state === "queued" &&
          !pending.includes(job.id) &&
          !active.has(job.id)
        )
          pending.push(job.id);
        await pump();
        return send(res, {
          status: 202,
          body: {
            ...(await store.get(job.id)),
            links: {
              self: `/v1/runs/${job.id}`,
              events: `/v1/runs/${job.id}/events`,
              stop: `/v1/runs/${job.id}/stop`,
            },
          },
        });
      }
      if (req.method === "GET" && url.pathname === "/v1/runs")
        return send(res, {
          status: 200,
          body: {
            runs: (
              await store.list(
                integer(
                  Number(url.searchParams.get("limit") ?? 20),
                  1,
                  100,
                  "limit",
                ),
                integer(
                  Number(
                    url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER,
                  ),
                  1,
                  Number.MAX_SAFE_INTEGER,
                  "before",
                ),
              )
            ).map(({ snapshot, ...job }) => ({
              ...job,
              hasSnapshot: Boolean(snapshot),
            })),
          },
        });
      const match = /^\/v1\/runs\/([a-f0-9-]{36})(?:\/(events|stop))?$/.exec(
        url.pathname,
      );
      if (match) {
        const job = await store.get(match[1]);
        if (!job) fail(404, "Run not found");
        if (req.method === "GET" && !match[2])
          return send(res, { status: 200, body: job });
        if (req.method === "GET" && match[2] === "events") {
          const after = integer(
            Number(url.searchParams.get("after") ?? 0),
            0,
            Number.MAX_SAFE_INTEGER,
            "after",
          );
          const events = await store.events(
            job!.id,
            after,
            integer(
              Number(url.searchParams.get("limit") ?? 100),
              1,
              200,
              "limit",
            ),
          );
          return send(res, {
            status: 200,
            body: {
              events,
              nextAfter: events.at(-1)?.id ?? after,
              state: job!.state,
            },
          });
        }
        if (req.method === "POST" && match[2] === "stop") {
          const running = active.get(job!.id);
          if (running) {
            await store.state(job!.id, "stopping");
            running.abort.abort();
          } else if (job!.state === "queued") {
            pending.splice(pending.indexOf(job!.id), 1);
            await store.state(job!.id, "cancelled");
          }
          return send(res, { status: 200, body: await store.get(job!.id) });
        }
        fail(405, "Method not allowed");
      }
      if (req.method === "POST" && url.pathname === "/v1/evaluators/grants") {
        const b = await body();
        object(b, ["identity"]);
        if (
          typeof b.identity !== "string" ||
          !/^[a-f0-9]{64}$/i.test(b.identity)
        )
          fail(400, "Valid existing Spacetime identity required");
        await fleetCall("grant_backend_viewer", [b.identity]);
        return send(res, {
          status: 200,
          body: { granted: true, scope: "all-http-run-evaluation" },
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/fleet/start") {
        if (chat.busy)
          fail(409, "Stop chat operations before resetting the fleet");
        const b = await body();
        object(b, ["drones", "attackers", "defenders", "hardened"]);
        if (typeof b.hardened !== "boolean")
          fail(400, "Explicit hardened boolean required");
        await fleetCall("start_fleet", [
          integer(b.drones, 1, 256, "drones"),
          integer(b.attackers, 0, 32, "attackers"),
          integer(b.defenders, 0, 32, "defenders"),
          b.hardened,
        ]);
        if (env.BITDEER_API_KEY) await fleetCall("enable_fleet_chat", []);
        return send(res, {
          status: 200,
          body: { started: true, engine: b.attackers + b.defenders ? "fixture" : "awaiting-objective", durationMs: b.attackers + b.defenders ? 60000 : null },
        });
      }
      if (req.method === "POST" && url.pathname === "/v1/fleet/stop") {
        await chat.endFleet();
        return send(res, { status: 200, body: { stopped: true } });
      }
      if (req.method === "POST" && url.pathname === "/v1/fleet/grants") {
        const b = await body();
        object(b, ["identity", "role"]);
        if (
          typeof b.identity !== "string" ||
          !/^[a-f0-9]{64}$/i.test(b.identity) ||
          !["attacker", "defender", "observer"].includes(b.role)
        )
          fail(400, "Valid existing Spacetime identity and role required");
        await fleetCall("grant_fleet_view", [b.identity, b.role]);
        return send(res, {
          status: 200,
          body: { granted: true, role: b.role },
        });
      }
      fail(404, "Route not found");
    } catch (e) {
      send(res, {
        status:
          e instanceof HttpError || e instanceof StoreError ? e.status : 502,
        body: {
          error:
            e instanceof HttpError || e instanceof StoreError
              ? e.message
              : "Service dependency failed",
        },
      });
    } finally {
      release?.();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxConnections = 128;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    store,
    pool,
    async close() {
      closing = true;
      clearInterval(heartbeat);
      await chat.close();
      const unlock = await lock();
      for (const id of pending.splice(0)) await store.state(id, "cancelled");
      const workers = [...active.values()];
      unlock();
      for (const worker of workers) worker.abort.abort();
      await Promise.all(workers.map((w) => w.done));
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await store.close();
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const service = await startService({
    operatorToken: process.env.SUDOKO_OPERATOR_TOKEN ?? "",
    observerToken: process.env.SUDOKO_OBSERVER_TOKEN,
    port: Number(process.env.PORT ?? 4180),
    host: process.env.SUDOKO_BIND ?? "127.0.0.1",
    maxActive: Number(process.env.SUDOKO_MAX_ACTIVE ?? 2),
    inferenceConcurrency: Number(process.env.BITDEER_CONCURRENCY ?? 4),
  });
  console.log(`SudoKO backend listening on ${service.url}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => void service.close());
}
