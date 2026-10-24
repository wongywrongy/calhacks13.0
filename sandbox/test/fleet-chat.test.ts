import test from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { testDatabase } from "./spacetime-helper.ts";
import { startService } from "../src/service.ts";
const operator = "operator-chat-test-000000000000000000000";
const attacker = "attacker-chat-test-000000000000000000000";
const defender = "defender-chat-test-000000000000000000000";

test(
  "mocked inference: authenticated chat, concurrent fleet actions, evidence, cancellation and durable reconnect",
  { skip: !process.env.SPACETIME_BINARY },
  async (t) => {
    const db = await testDatabase();
    const original = globalThis.fetch;
    let calls = 0;
    let mode = "normal";
    const inputs: any[] = [];
    globalThis.fetch = async (input: any, init?: any) => {
      if (
        String(input) !== "https://api-inference.bitdeer.ai/v1/chat/completions"
      )
        return original(input, init);
      calls++;
      const b = JSON.parse(init.body),
        system = JSON.parse(b.messages[0].content),
        context = JSON.parse(b.messages[1].content);
      inputs.push({ system, context, model: b.model });
      if (
        mode === "blocked" ||
        (mode === "blocked-specialists" && !system.agents) ||
        (mode === "pause-after-discovery" &&
          !system.agents &&
          context.memory.length)
      )
        await delay(30000, undefined, { signal: init.signal });
      else await delay(40, undefined, { signal: init.signal });
      if (mode === "rate-limit") return new Response("{}", { status: 429 });
      if (mode === "refuse")
        return Response.json({
          choices: [
            { finish_reason: "stop", message: { refusal: "test refusal" } },
          ],
        });
      if (mode === "truncated")
        return Response.json({
          choices: [{ finish_reason: "length", message: { content: "{}" } }],
        });
      if (mode === "malformed")
        return Response.json({
          choices: [
            { finish_reason: "stop", message: { content: "not json" } },
          ],
        });
      let value: any;
      if (system.agents)
        value = {
          tasks: system.agents
            .slice(0, 2)
            .map((agentId: number, i: number) => ({
              agentId,
              target: i + 1,
              objective: "Assess assigned drone",
            })),
        };
      else
        value = {
          kind:
            system.role === "attacker"
              ? context.observation.discovered === false
                ? "discover"
                : "command"
              : context.observation.isolated
                ? "verify"
                : "isolate",
        };
      if (mode === "out-of-scope" && !system.agents)
        value = { kind: "shell", url: "https://example.com" };
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(value) },
          },
        ],
        usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
      });
    };
    const env = {
      ...db.env,
      BITDEER_API_KEY: "test-only",
      BITDEER_COORDINATOR_MODEL: "test-coordinator",
      BITDEER_SPECIALIST_MODEL: "test-specialist",
      SUDOKO_ATTACKER_TOKEN: attacker,
      SUDOKO_DEFENDER_TOKEN: defender,
    };
    let service = await startService({
      operatorToken: operator,
      env,
      inferenceConcurrency: 2,
    });
    const request = async (
      path: string,
      token: string,
      body?: any,
      key = "test-key",
    ) => {
      const r = await original(service.url + path, {
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
    const poll = async (
      id: string,
      token: string,
      predicate: (o: any) => boolean,
    ) => {
      for (let i = 0; i < 140; i++) {
        const r = await request(`/v1/chat/operations/${id}`, token);
        if (predicate(r.body)) return r.body;
        await delay(50);
      }
      throw Error("Operation did not reach expected state");
    };
    const cookies: Record<string, string> = {};
    const browser = async (
      path: string,
      role: string,
      body?: any,
      key = "browser-test",
      origin = service.url,
    ) => {
      const r = await original(service.url + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          cookie: cookies[role] || "",
          origin,
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: (await r.json()) as any };
    };
    try {
      await service.store.call("start_fleet", [4, 2, 2, false]);
      await service.store.call("enable_fleet_chat", []);
      const [fleet] = await service.store.query("SELECT * FROM fleet_session");
      for (const role of ["attacker", "defender", "observer"]) {
        const identity: any = await original(
          db.env.SPACETIME_URI + "/v1/identity",
          { method: "POST" },
        ).then((r) => r.json());
        await service.store.call("grant_fleet_view", [identity.identity, role]);
        const r = await original(service.url + "/api/session", {
          method: "POST",
          headers: { origin: service.url, "content-type": "application/json" },
          body: JSON.stringify({ token: identity.token }),
        });
        assert.equal(r.status, 200);
        assert.equal(((await r.json()) as any).role, role);
        const cookie = r.headers.get("set-cookie")!;
        assert.match(cookie, /HttpOnly/);
        assert.match(cookie, /SameSite=Strict/);
        assert.ok(!cookie.includes(identity.token));
        cookies[role] = cookie.split(";")[0];
      }
      assert.equal(
        (
          await browser("/api/chat/operations", "none", {
            message: "x",
            sandbox: db.env.SPACETIME_DATABASE,
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await browser("/api/chat/operations", "observer", {
            message: "x",
            sandbox: db.env.SPACETIME_DATABASE,
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await browser("/api/chat/operations", "attacker", {
            message: "x",
            sandbox: "another-sandbox",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await browser("/api/chat/operations", "attacker", {
            message: "x",
            sandbox: db.env.SPACETIME_DATABASE,
            role: "defender",
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await browser(
            "/api/chat/operations",
            "attacker",
            { message: "x", sandbox: db.env.SPACETIME_DATABASE },
            "key",
            "https://untrusted.example",
          )
        ).status,
        403,
      );
      const ownerLogin = await original(service.url + "/api/session", {
        method: "POST",
        headers: { origin: service.url, "content-type": "application/json" },
        body: JSON.stringify({ token: db.env.SPACETIME_TOKEN }),
      });
      assert.equal(ownerLogin.status, 401);
      const cfg = await browser("/fleet-config?role=defender", "attacker");
      assert.equal(cfg.body.role, "attacker");
      assert.equal(cfg.body.sandbox, db.env.SPACETIME_DATABASE);
      for (const secret of [operator, attacker, defender, "test-only"])
        assert.ok(!JSON.stringify(cfg.body).includes(secret));
      assert.equal(
        (await request("/v1/chat/operations", operator, { message: "attack" }))
          .status,
        403,
      );
      const message =
        "Let's take over the drone swarm. Look for vulnerabilities.";
      const [op, duplicate] = await Promise.all([
        browser("/api/chat/operations", "attacker", {
          message,
          sandbox: db.env.SPACETIME_DATABASE,
        }),
        browser("/api/chat/operations", "attacker", {
          message,
          sandbox: db.env.SPACETIME_DATABASE,
        }),
      ]);
      assert.equal(op.status, 202);
      assert.equal(op.body.id, duplicate.body.id);
      assert.equal(
        (await browser(`/api/chat/operations/${op.body.id}`, "defender"))
          .status,
        404,
      );
      assert.equal(
        (
          await browser("/api/chat/operations", "attacker", {
            message: "different",
            sandbox: db.env.SPACETIME_DATABASE,
          })
        ).status,
        409,
      );
      const attacked = await poll(
        op.body.id,
        attacker,
        (o) => o.state === "completed",
      );
      assert.equal(attacked.tasks.length, 2);
      assert.equal(
        attacked.results.filter(
          (r: any) => r.outcome === "unauthorized_command_accepted",
        ).length,
        2,
      );
      assert.ok(attacked.results.every((r: any) => r.evidenceId > 0));
      assert.equal(
        attacked.inferences.filter((r: any) => r.stage === "coordinator")
          .length,
        1,
      );
      assert.deepEqual(
        attacked.transitions.map((t: any) => t.state),
        ["planning", "running", "completed"],
      );
      assert.equal(
        (await service.store.query("SELECT * FROM fleet_hold")).length,
        2,
      );
      assert.equal(
        (await service.store.query("SELECT * FROM agent_schedule")).length,
        0,
      );
      const afterAttack = await service.store.query(
        "SELECT * FROM fleet_drone",
      );
      assert.equal(
        afterAttack.filter((d: any) => d.controller === "attacker").length,
        2,
      );
      // Exercise the deadline clamped to the fleet's microsecond timestamp, not just now + 45s.
      await delay(
        Math.max(0, Number(fleet.deadline) / 1000 - Date.now() - 44000),
      );
      const defenseMessage =
        "Protect the swarm. Investigate suspicious commands and stop unauthorized control without disrupting the mission.";
      const [redAgain, blue] = await Promise.all([
        browser(
          "/api/chat/operations",
          "attacker",
          {
            message: "Check discovered targets",
            sandbox: db.env.SPACETIME_DATABASE,
          },
          "parallel-red",
        ),
        browser(
          "/api/chat/operations",
          "defender",
          { message: defenseMessage, sandbox: db.env.SPACETIME_DATABASE },
          "parallel-blue",
        ),
      ]);
      assert.equal(redAgain.status, 202);
      assert.equal(blue.status, 202);
      assert.ok(Number.isSafeInteger(blue.body.deadline));
      assert.ok(
        blue.body.deadline <= Math.floor(Number(fleet.deadline) / 1000),
      );
      const recovered = await poll(
        blue.body.id,
        defender,
        (o) => o.state === "completed",
      );
      await poll(redAgain.body.id, attacker, (o) => o.state === "completed");
      const verified = recovered.results.filter(
        (r: any) => r.outcome === "recovery_verified",
      );
      assert.equal(verified.length, 2);
      for (const receipt of verified) {
        assert.equal(receipt.verificationEvidenceIds.length, 2);
        const evidence = await service.store.query(
          `SELECT * FROM fleet_evidence WHERE id=${receipt.verificationEvidenceIds[0]}`,
        );
        assert.equal(evidence[0].status, 403);
        assert.equal(evidence[0].kind, "verification_unauthorized");
        const legitimate = await service.store.query(
          `SELECT * FROM fleet_evidence WHERE id=${receipt.verificationEvidenceIds[1]}`,
        );
        assert.equal(legitimate[0].status, 200);
      }
      assert.equal(
        (await service.store.query("SELECT * FROM fleet_session"))[0].epoch,
        fleet.epoch,
      );
      assert.ok(
        (await service.store.query("SELECT * FROM fleet_drone"))
          .filter((d: any) => d.id <= 2)
          .every((d: any) => d.controller === "defender" && d.isolated),
      );
      assert.equal(
        (await service.store.query("SELECT * FROM fleet_hold")).length,
        0,
      );
      assert.ok(service.pool.peak <= 2);
      assert.ok(
        inputs
          .filter((i) => i.system.role === "attacker")
          .every((i) => !JSON.stringify(i.context).includes("policy_version")),
      );
      assert.ok(
        inputs
          .filter((i) => i.system.role === "defender")
          .every((i) => !JSON.stringify(i.context).includes(message)),
      );
      assert.ok(
        inputs
          .filter((i) => i.system.agents)
          .every((i) => i.model === "test-coordinator"),
      );
      assert.ok(
        inputs
          .filter((i) => !i.system.agents)
          .every((i) => i.model === "test-specialist"),
      );
      // Reducers independently reject role/scope/version/epoch/sequence violations.
      const settings = {
        message: "Reducer validation",
        tasks: [],
        maxDecisionsPerAgent: 8,
        maxModelCalls: 33,
        deadline: Date.now() + 10000,
      };
      const manual = randomUUID();
      await assert.rejects(
        service.store.call("create_chat_operation", [
          service.store.session,
          randomUUID(),
          "stale",
          "defender",
          fleet.epoch + 1,
          JSON.stringify(settings),
        ]),
      );
      await service.store.call("create_chat_operation", [
        service.store.session,
        manual,
        "manual",
        "defender",
        fleet.epoch,
        JSON.stringify(settings),
      ]);
      const tasks = [
        { agentId: 3, target: 1, objective: "Verify scoped policy" },
        { agentId: 4, target: 2, objective: "Verify scoped policy" },
      ];
      await assert.rejects(
        service.store.call("plan_chat_operation", [
          service.store.session,
          manual,
          JSON.stringify([{ ...tasks[0], agentId: 1 }, tasks[1]]),
        ]),
      );
      await assert.rejects(
        service.store.call("plan_chat_operation", [
          service.store.session,
          manual,
          JSON.stringify([{ ...tasks[0], target: 99 }, tasks[1]]),
        ]),
      );
      await service.store.call("plan_chat_operation", [
        service.store.session,
        manual,
        JSON.stringify(tasks),
      ]);
      const version = (
        await service.store.query("SELECT * FROM fleet_drone WHERE id=1")
      )[0].policy_version;
      for (const args of [
        [0, 3, 1, "isolate", version],
        [9, 3, 1, "isolate", version],
        [1, 1, 1, "discover", 0],
        [1, 3, 3, "isolate", version],
        [1, 3, 1, "command", version],
        [1, 3, 1, "isolate", version - 1],
      ])
        await assert.rejects(
          service.store.call("execute_fleet_chat_action", [
            service.store.session,
            manual,
            ...args,
          ]),
        );
      const unauthorized = await original(
        db.env.SPACETIME_URI +
          "/v1/database/" +
          db.env.SPACETIME_DATABASE +
          "/call/execute_fleet_chat_action",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${cfg.body.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify([
            service.store.session,
            manual,
            1,
            3,
            1,
            "isolate",
            version,
          ]),
        },
      );
      assert.ok(!unauthorized.ok);
      const privateRows = await original(
        db.env.SPACETIME_URI +
          "/v1/database/" +
          db.env.SPACETIME_DATABASE +
          "/sql",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${cfg.body.token}`,
            "content-type": "text/plain",
          },
          body: "SELECT * FROM backend_chat",
        },
      );
      assert.ok(!privateRows.ok);
      await service.store.call("execute_fleet_chat_action", [
        service.store.session,
        manual,
        1,
        3,
        1,
        "isolate",
        version,
      ]);
      const count = (
        await service.store.query("SELECT * FROM fleet_chat_action")
      ).length;
      await service.store.call("execute_fleet_chat_action", [
        service.store.session,
        manual,
        1,
        3,
        1,
        "isolate",
        version,
      ]);
      assert.equal(
        (await service.store.query("SELECT * FROM fleet_chat_action")).length,
        count,
      );
      await assert.rejects(
        service.store.call("execute_fleet_chat_action", [
          service.store.session,
          manual,
          1,
          3,
          1,
          "verify",
          version,
        ]),
      );
      await assert.rejects(
        service.store.call("execute_fleet_chat_action", [
          service.store.session,
          manual,
          2,
          3,
          1,
          "verify",
          version,
        ]),
      );
      await service.store.call("execute_fleet_chat_action", [
        service.store.session,
        manual,
        2,
        3,
        1,
        "verify",
        version + 1,
      ]);
      await service.store.call("update_chat_operation", [
        service.store.session,
        manual,
        "cancelled",
        "[]",
      ]);
      const expired = randomUUID();
      await service.store.call("create_chat_operation", [
        service.store.session,
        expired,
        "expired",
        "defender",
        fleet.epoch,
        JSON.stringify({ ...settings, deadline: Date.now() + 100 }),
      ]);
      await delay(130);
      await assert.rejects(
        service.store.call("plan_chat_operation", [
          service.store.session,
          expired,
          JSON.stringify(tasks),
        ]),
      );
      await service.store.call("update_chat_operation", [
        service.store.session,
        expired,
        "cancelled",
        "[]",
      ]);
      // Cancellation includes planning and queued inference, then no later reducer effects.
      mode = "blocked";
      const pending = await browser(
        "/api/chat/operations",
        "attacker",
        { message: "Pending planning", sandbox: db.env.SPACETIME_DATABASE },
        "cancel-planning",
      );
      assert.equal(pending.status, 202);
      const stopped = await browser(
        `/api/chat/operations/${pending.body.id}/stop`,
        "attacker",
        {},
      );
      assert.equal(stopped.body.state, "cancelled");
      const before = (
        await service.store.query("SELECT * FROM fleet_chat_action")
      ).length;
      await delay(200);
      assert.equal(
        (await service.store.query("SELECT * FROM fleet_chat_action")).length,
        before,
      );
      await assert.rejects(
        service.store.call("execute_fleet_chat_action", [
          service.store.session,
          pending.body.id,
          1,
          1,
          1,
          "command",
          0,
        ]),
      );
      assert.equal(service.pool.status().queued, 0);
      mode = "blocked-specialists";
      const releaseSlot = await service.pool.acquire(
        new AbortController().signal,
      );
      // Fresh discoveries are scoped observations; wait until specialist inference is active.
      const running = await request(
        "/v1/chat/operations",
        defender,
        { message: "Investigate and verify" },
        "cancel-running",
      );
      await poll(
        running.body.id,
        defender,
        (o) =>
          o.state === "running" &&
          o.inferences.some(
            (i: any) => i.stage === "specialist" && i.status === "running",
          ),
      );
      const cancelled = await request(
        `/v1/chat/operations/${running.body.id}/stop`,
        defender,
        {},
      );
      assert.equal(cancelled.body.state, "cancelled");
      releaseSlot();
      assert.equal(service.pool.status().queued, 0);
      const afterStop = (
        await service.store.query("SELECT * FROM fleet_chat_action")
      ).length;
      await delay(150);
      assert.equal(
        (await service.store.query("SELECT * FROM fleet_chat_action")).length,
        afterStop,
      );

      await service.close();
      await db.restart();
      service = await startService({ operatorToken: operator, env });
      const saved = await browser(
        `/api/chat/operations/${op.body.id}`,
        "attacker",
      );
      assert.equal(saved.body.state, "completed");
      assert.equal(saved.body.results.length, attacked.results.length);
      for (const [failure, code] of [
        ["refuse", "provider_refused"],
        ["rate-limit", "provider_rate_limit"],
        ["malformed", "provider_malformed_output"],
        ["truncated", "provider_truncated_output"],
        ["out-of-scope", "provider_malformed_output"],
      ]) {
        mode = failure;
        const count = (
          await service.store.query("SELECT * FROM fleet_chat_action")
        ).length;
        const rejected = await request(
          "/v1/chat/operations",
          attacker,
          { message: "Assess assigned targets" },
          "failure-" + failure,
        );
        assert.equal(rejected.status, 202);
        const failed = await poll(
          rejected.body.id,
          attacker,
          (o) => o.state === "failed",
        );
        assert.ok(failed.results.some((r: any) => r.error === code));
        assert.equal(
          (await service.store.query("SELECT * FROM fleet_chat_action")).length,
          count,
        );
      }
      mode = "blocked";
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      const timer = t.mock.method(AbortSignal, "timeout", (ms: number) =>
        timeout(ms === 15000 ? 20 : ms),
      );
      const timed = await request(
        "/v1/chat/operations",
        attacker,
        { message: "Timeout check" },
        "timeout",
      );
      const timedResult = await poll(
        timed.body.id,
        attacker,
        (o) => o.state === "failed",
      );
      assert.ok(
        timedResult.results.some((r: any) => r.error === "provider_timeout"),
      );
      timer.mock.restore();
      assert.ok(calls >= 10);
    } finally {
      await service.close();
      globalThis.fetch = original;
      await db.close();
    }
  },
);
