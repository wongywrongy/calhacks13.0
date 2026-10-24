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
          tasks: [0, 1].map((i: number) => ({
              name: "Kestrel",
              specialty: system.role === "attacker" ? "reconnaissance" : "containment",
              target: context.selectedTarget ?? i + 1,
              objective: "Assess assigned drone <img src=x onerror=alert(1)>",
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
      if (mode === "declined-plan" && system.agents)
        value.tasks.forEach((task: any) => (task.objective = "declined"));
      if (mode === "repeat-discovery" && !system.agents)
        value = { kind: "discover" };
      if (mode === "out-of-scope" && !system.agents)
        value = { kind: "shell", url: "https://example.com" };
      if (system.task?.startsWith("Route") && value.tasks) value = { intent: "deploy", answer: "Prepare specialists", evidenceIds: [], tasks: value.tasks };
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
      SUDOKO_ALLOWED_ORIGINS: "https://sudo-ko.us,https://www.sudo-ko.us,https://calhacks130-mjcc.vercel.app",
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
      await service.store.call("start_fleet", [4, 0, 0, false]);
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
      for (const target of [0, 257, "1", null]) {
        assert.equal(
          (
            await browser(
              "/api/chat/messages",
              "attacker",
              {
                message: "Inspect",
                sandbox: db.env.SPACETIME_DATABASE,
                target,
              },
              "invalid-target",
            )
          ).status,
          400,
        );
      }
      assert.equal(
        (
          await browser(
            "/api/chat/messages",
            "attacker",
            {
              message: "Inspect hidden target",
              sandbox: db.env.SPACETIME_DATABASE,
              target: 4,
            },
            "hidden-target",
          )
        ).status,
        403,
      );
      assert.equal((await service.store.query("SELECT * FROM fleet_agent")).length, 0);
      const statusBefore = await browser("/api/chat/messages", "defender", { message: "Status", sandbox: db.env.SPACETIME_DATABASE }, "before-attack");
      assert.equal(statusBefore.status, 202);
      assert.equal(calls, 0);
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
      assert.deepEqual(attacked.tasks.map((t: any) => t.name), ["Kestrel", "Kestrel 2"]);
      assert.equal((await service.store.query("SELECT * FROM fleet_agent")).length, 2);
      assert.equal(new Set(attacked.tasks.map((t: any) => t.agentId)).size, 2);
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
      // The shared sandbox must remain active after the former 60-second fleet deadline.
      const beforeIdle = (
        await service.store.query("SELECT * FROM fleet_drone WHERE id=1")
      )[0].tick;
      const idleCalls = calls;
      await delay(61000);
      assert.equal(calls, idleCalls);
      const openFleet = (
        await service.store.query("SELECT * FROM fleet_session")
      )[0];
      assert.equal(openFleet.active, true);
      assert.equal(openFleet.deadline, 0);
      assert.equal(openFleet.epoch, fleet.epoch);
      assert.ok(
        (await service.store.query("SELECT * FROM fleet_drone WHERE id=1"))[0]
          .tick > beforeIdle,
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
        blue.body.deadline <= Date.now() + 75000 &&
          blue.body.deadline > Date.now(),
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
      const beforeStatus = calls;
      const statusBody = {
        message: "Status",
        target: 1,
        sandbox: db.env.SPACETIME_DATABASE,
      };
      const [statusReply, statusDuplicate] = await Promise.all([
        browser("/api/chat/messages", "attacker", statusBody, "status-key"),
        browser("/api/chat/messages", "attacker", statusBody, "status-key"),
      ]);
      assert.equal(statusReply.status, 202);
      assert.equal(statusDuplicate.status, 202);
      assert.equal(calls, beforeStatus);
      for (const [i, origin] of env.SUDOKO_ALLOWED_ORIGINS.split(",").entries()) {
        assert.equal((await browser("/api/chat/messages", "attacker", statusBody, "allowed-origin-" + i, origin)).status, 202);
      }
      for (const origin of ["https://sudo-ko.us.evil.example", "https://other.vercel.app", "null"]) {
        assert.equal((await browser("/api/chat/messages", "attacker", statusBody, "bad-origin", origin)).status, 403);
      }
      assert.equal(calls, beforeStatus);

      assert.equal(
        statusReply.body.messages.filter((m: any) => m.text === "Status")
          .length,
        1,
      );
      assert.ok(
        statusReply.body.messages.some((m: any) =>
          m.text.startsWith("Your operation is completed"),
        ),
      );
      assert.equal(
        (
          await browser(
            "/api/chat/messages",
            "attacker",
            { ...statusBody, target: 2 },
            "status-key",
          )
        ).status,
        409,
      );
      const ownConversation = await browser(
        "/api/chat/conversation",
        "defender",
      );
      assert.ok(
        ownConversation.body.messages.every((m: any) => m.role === "defender"),
      );
      assert.ok(!JSON.stringify(ownConversation.body).includes(message));
      const cursor = (await browser("/api/chat/conversation", "attacker")).body.after;
      assert.equal(
        (await browser("/api/chat/conversation?after=" + cursor, "attacker"))
          .body.messages.length,
        0,
      );
      mode = "normal";
      const scoped = await browser(
        "/api/chat/messages",
        "attacker",
        {
          message: "Probe the selected drone",
          target: 1,
          sandbox: db.env.SPACETIME_DATABASE,
        },
        "scoped",
      );
      assert.equal(scoped.status, 202);
      let scopedOperation: any;
      for (let i = 0; i < 100; i++) {
        const c = (await browser("/api/chat/conversation", "attacker")).body;
        const turn = c.turns.find((t: any) => t.id === scoped.body.accepted.id);
        if (turn?.operationId) { scopedOperation = c.operations.find((o: any) => o.id === turn.operationId); break; }
        await delay(30);
      }
      assert.ok(scopedOperation);
      const scopedDone = await poll(
        scopedOperation.id,
        attacker,
        (o) => o.state === "completed",
      );
      assert.ok(scopedDone.tasks.every((task: any) => task.target === 1));
      assert.ok(scopedDone.results.every((r: any) => r.target === 1));
      assert.ok(scopedDone.workers.every((w: any) => w.state === "done"));
      // Reducers independently enforce the selected context even for trusted Node calls.
      const scopedId = randomUUID();
      await service.store.call("create_chat_operation", [
        service.store.session,
        scopedId,
        "db-scoped",
        "attacker",
        fleet.epoch,
        JSON.stringify({
          message: "Selected context",
          target: 1,
          tasks: [],
          maxDecisionsPerAgent: 8,
          maxModelCalls: 33,
          deadline: Date.now() + 10000,
        }),
      ]);
      await assert.rejects(
        service.store.call("plan_chat_operation", [
          service.store.session,
          scopedId,
          JSON.stringify([
            { agentId: 1, name: "Scope One", specialty: "recon", target: 1, objective: "Inspect" },
            { agentId: 2, name: "Scope Two", specialty: "recon", target: 2, objective: "Inspect" },
          ]),
        ]),
      );
      await service.store.call("update_chat_operation", [
        service.store.session,
        scopedId,
        "cancelled",
        "[]",
      ]);
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
        { agentId: 3, name: "Guard One", specialty: "containment", target: 1, objective: "Verify scoped policy" },
        { agentId: 4, name: "Guard Two", specialty: "verification", target: 2, objective: "Verify scoped policy" },
      ];
      await assert.rejects(
        service.store.call("plan_chat_operation", [
          service.store.session,
          manual,
          JSON.stringify([{ ...tasks[0], agentId: attacked.tasks[0].agentId }, tasks[1]]),
        ]),
      );
      await assert.rejects(
        service.store.call("plan_chat_operation", [
          service.store.session,
          manual,
          JSON.stringify([{ ...tasks[0], target: 99 }, tasks[1]]),
        ]),
      );
      const beforeInvalid = (await service.store.query("SELECT * FROM fleet_agent")).length;
      for (const invalid of ["", "<script>alert(1)</script>", "x".repeat(33)]) {
        await assert.rejects(service.store.call("plan_chat_operation", [service.store.session, manual, JSON.stringify([{ ...tasks[0], name: invalid }, tasks[1]])]));
      }
      await assert.rejects(service.store.call("plan_chat_operation", [service.store.session, manual, JSON.stringify([tasks[0], { ...tasks[1], name: tasks[0].name }])]));
      assert.equal((await service.store.query("SELECT * FROM fleet_agent")).length, beforeInvalid);
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
      for (const table of [
        "backend_chat",
        "backend_chat_message",
        "backend_chat_transition",
        "backend_chat_turn",
        "fleet_chat_action",
        "fleet_chat_clock",
      ]) {
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
            body: "SELECT * FROM " + table,
          },
        );
        assert.ok(!privateRows.ok);
      }
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
      const changed = await browser(
        "/api/chat/messages",
        "attacker",
        { message: "Change objective", sandbox: db.env.SPACETIME_DATABASE },
        "changed",
      );
      assert.equal(changed.status, 202);
      assert.ok(changed.body.accepted.id);
      assert.ok(changed.body.messages.some((m: any) => m.text.startsWith("Message accepted")));
      const stopped = await browser(
        "/api/chat/messages",
        "attacker",
        { message: "Stop", sandbox: db.env.SPACETIME_DATABASE },
        "stop-message",
      );
      assert.equal(stopped.status, 202);
      assert.equal(
        stopped.body.operations.find((o: any) => o.id === pending.body.id)
          .state,
        "cancelled",
      );
      assert.ok(
        stopped.body.messages.some((m: any) =>
          m.text.startsWith("Stopped your operation"),
        ),
      );
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

      const abandonedTurn = randomUUID();
      await service.store.call("create_chat_turn", [service.store.session, abandonedTurn, "attacker:abandoned-turn", "attacker", JSON.stringify({ message: "Question before restart?", target: null, deadline: Date.now() + 30000 })]);
      await service.close();
      await db.restart();
      service = await startService({ operatorToken: operator, env });
      const saved = await browser(
        `/api/chat/operations/${op.body.id}`,
        "attacker",
      );
      const restored = await browser("/api/chat/conversation", "attacker");
      assert.equal(restored.body.turns.find((t: any) => t.id === abandonedTurn).state, "failed");
      assert.ok(restored.body.messages.some((m: any) => m.text.startsWith("Conversation interrupted")));

      assert.ok(restored.body.messages.some((m: any) => m.text === "Status"));
      assert.ok(restored.body.messages.some((m: any) => m.text === "Stop"));
      assert.ok(
        restored.body.messages.some((m: any) => m.text === "Change objective"),
      );
      assert.ok(restored.body.messages.some((m: any) => m.text === message));
      assert.equal(saved.body.state, "completed");
      assert.equal(saved.body.results.length, attacked.results.length);
      for (const [failure, code] of [
        ["refuse", "provider_refused"],
        ["declined-plan", "provider_refused"],
        ["rate-limit", "provider_rate_limit"],
        ["malformed", "provider_malformed_output"],
        ["truncated", "provider_truncated_output"],
        ["out-of-scope", "provider_malformed_output"],
        ["repeat-discovery", "provider_malformed_output"],
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
        timeout([15000, 20000].includes(ms) ? 20 : ms),
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
      const evidenceBefore = await service.store.query(
        "SELECT * FROM fleet_evidence",
      );
      await service.store.call("start_fleet", [4, 0, 0, false]);
      await service.store.call("enable_fleet_chat", []);
      const retained = await service.store.query(
        "SELECT * FROM fleet_evidence",
      );
      assert.ok(
        evidenceBefore.every((e: any) =>
          retained.some((r: any) => r.id === e.id),
        ),
      );
      const visible = (await original(
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
          body: "SELECT * FROM visible_evidence",
        },
      ).then((r) => r.json())) as any;
      assert.equal(visible[0].rows.length, 0);
      const history = await browser("/api/chat/conversation", "attacker");
      assert.ok(history.body.messages.some((m: any) => m.text === message));
      mode = "normal";
      const defenderFirst = await browser("/api/chat/operations", "defender", { message: "Protect this fresh fleet", sandbox: db.env.SPACETIME_DATABASE }, "defender-first");
      assert.equal(defenderFirst.status, 202);
      const newDefense = await poll(defenderFirst.body.id, defender, (o) => o.state === "completed");
      const firstAgents = await service.store.query("SELECT * FROM fleet_agent");
      assert.equal(firstAgents.length, newDefense.tasks.length);
      assert.ok(firstAgents.every((a: any) => a.role === "defender"));
      mode = "blocked-specialists";
      const ending = await request("/v1/chat/operations", attacker, { message: "Check fleet stop" }, "fleet-stop");
      await poll(ending.body.id, attacker, (o) => o.state === "running");
      const stoppedFleet = await request("/v1/fleet/stop", operator, {});
      assert.equal(stoppedFleet.status, 200);
      assert.equal((await request(`/v1/chat/operations/${ending.body.id}`, attacker)).body.state, "cancelled");
      const stoppedCount = (await service.store.query("SELECT * FROM fleet_chat_action")).length;
      await delay(100);
      assert.equal((await service.store.query("SELECT * FROM fleet_chat_action")).length, stoppedCount);
      assert.equal((await service.store.query("SELECT * FROM fleet_session"))[0].active, false);


    } finally {
      await service.close();
      globalThis.fetch = original;
      await db.close();
    }
  },
);
