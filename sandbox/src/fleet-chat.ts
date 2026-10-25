import { FLEET } from "../../shared/fleet.ts";
import { goalActions, goalSatisfied, validGoal, type Goal } from "./fleet-goals.ts";
import prompts from "../../shared/fleet-prompts.json" with { type: "json" };
import { resilienceContext, resilienceActions, RESILIENCE_COORDINATOR, RESILIENCE_SPECIALIST } from "./resilience.ts";
import { randomUUID, randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fleetOutcome, explainFleetError } from "./fleet-outcome.ts";
import { RunStore, StoreError } from "./run-store.ts";
import { DecisionPool } from "./decision-pool.ts";
import { fleetInference, DecisionError, decisionError as errorCode } from "./fleet-inference.ts";
export type ChatRole = "attacker" | "defender";
type Task = { agentId: number; name: string; specialty: string; target: number; objective: string; goal: Goal };
export const CHAT_LIMITS = {
  maxAgents: 4,
  maxDecisionsPerAgent: 8,
  maxModelCalls: 33,
  durationMs: 75000,
  requestTimeoutMs: 20000,
  coordinatorTokens: 1536,
  coordinatorTimeoutMs: 20000,
  specialistTokens: 512,
};
export const chatModels = (env: NodeJS.ProcessEnv) => ({
  coordinator:
    env.BITDEER_COORDINATOR_MODEL ||
    env.BITDEER_MODEL ||
    "zai-org/GLM-5.3-Flash",
  specialist:
    env.BITDEER_SPECIALIST_MODEL ||
    env.BITDEER_MODEL ||
    "zai-org/GLM-5.3-Flash",
});
const messageKey = (key: string) => key.replace(/^epoch:\d+:(?:chat:\d+:)?/, "");
const messageGeneration = (key: string) => Number(/^epoch:\d+:chat:(\d+):/.exec(key)?.[1] ?? 1);
const activeState = (state: string) => ["planning", "running"].includes(state);
const sql = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const reject = (status: number, message: string): never => {
  throw new StoreError(status, message);
};
const object = (v: any, keys: string[]) =>
  v &&
  !Array.isArray(v) &&
  typeof v === "object" &&
  Object.keys(v).length === keys.length &&
  keys.every((k) => k in v);
export class FleetChat {
  private workers = new Map<
    string,
    { abort: AbortController; done: Promise<void> }
  >();
  private turns = new Map<string, { role: ChatRole; conversation: number; abort: AbortController; done: Promise<void> }>();
  private admissions = new Map<ChatRole, Promise<void>>();
  private shutdown = new AbortController();
  private stoppingFleet = false;
  private messages = new Map<
    string,
    { signature: string; done: Promise<any> }
  >();
  private store: RunStore;
  private pool: DecisionPool;
  private env: NodeJS.ProcessEnv;
  constructor(store: RunStore, pool: DecisionPool, env: NodeJS.ProcessEnv) {
    this.store = store;
    this.pool = pool;
    this.env = env;
  }
  get busy() {
    return this.stoppingFleet || this.turns.size > 0 || this.workers.size > 0 || this.admissions.size > 0;
  }
  private decode(r: any) {
    const records = JSON.parse(r.result),
      config = JSON.parse(r.config);
    const workers = (config.tasks as Task[]).map((task) => {
      const lifecycle = records
        .filter((v: any) => v.type === "worker" && v.agentId === task.agentId)
        .at(-1);
      let state = lifecycle?.state || "queued";
      state = ({working:"running",done:"completed",paused:"cancelled"} as Record<string,string>)[state] ?? state;
      if (["queued","running"].includes(state) && !activeState(r.state)) state = r.state === "cancelled" ? "cancelled" : "failed";
      return { ...task, state, operationId: r.id, deployedAt: records.find((v: any) => v.type === "worker" && v.agentId === task.agentId)?.at, error: lifecycle?.error, reason:lifecycle?.reason, stage:lifecycle?.stage };
    });
    const outcome = fleetOutcome({ state: r.state, role: r.role, tasks: config.tasks, results: records });
    return {
      outcome,
      deployment: { summary: `Deploying ${config.tasks.length} agents to ${r.role === "defender" ? "contain affected drones" : "challenge mission resilience"}.`,
        assignments: config.tasks.map((t: Task) => ({ agentId: t.agentId, name: t.name, target: t.target, summary: r.role === "defender" ? "Contain and verify" : "Discover and test bounded resilience" })) },
      id: r.id,
      role: r.role,
      epoch: r.epoch,
      state: r.state,
      ...config,
      workers,
      results: records.filter(
        (v: any) => !["inference", "worker", "timing"].includes(v.type),
      ),
      timings: records.filter((v: any) => v.type === "timing"),
      inferences: records.filter((v: any) => v.type === "inference"),
    };
  }
  async get(id: string, role: ChatRole) {
    const [r] = await this.store.query(
      `SELECT * FROM backend_chat WHERE id=${sql(id)}`,
    );
    if (!r || r.role !== role) return reject(404, "Operation not found");
    const transitions = await this.store.query(
      `SELECT * FROM backend_chat_transition WHERE operation=${sql(id)}`,
    );
    return {
      ...this.decode(r),
      transitions: transitions.sort((a: any, b: any) => a.id - b.id),
    };
  }
  private async currentFleet(epoch?: number) {
    if (this.stoppingFleet || this.shutdown.signal.aborted) return reject(503, "Service or fleet is resetting");
    const [fleet] = await this.store.query("SELECT * FROM fleet_session WHERE id=0");
    if (!fleet || (epoch !== undefined && fleet.epoch !== epoch)) return reject(409, "Fleet session changed; synchronizing current state");
    return fleet;
  }
  async generation(role: ChatRole, expected?: number) {
    const [row] = await this.store.query(`SELECT * FROM backend_chat_session WHERE role=${sql(role)}`);
    const generation = row?.generation ?? 1;
    if (expected !== undefined && generation !== expected) return reject(409, "Conversation changed; synchronizing current chat");
    return generation;
  }
  async newChat(role: ChatRole, epoch: number, generation: number) {
    await this.store.call("new_chat", [this.store.session, role, epoch, generation]);
    const cancelled = await this.store.query(`SELECT * FROM backend_chat WHERE role=${sql(role)} AND state='cancelled'`);
    const pending = [...this.turns.values()].filter((t) => t.role === role && t.conversation === generation);
    const work = [...pending, ...cancelled.flatMap((op: any) => this.workers.has(op.id) ? [this.workers.get(op.id)!] : [])];
    for (const item of work) item.abort.abort();
    await Promise.allSettled(work.map((item) => item.done));
    return this.conversation(role);
  }
  async conversation(role: ChatRole, after = 0, expected?: number) {
    if (!Number.isSafeInteger(after) || after < 0)
      return reject(400, "Invalid conversation cursor");
    const fleet = await this.currentFleet();
    const conversation = await this.generation(role);
    if (expected !== undefined && expected !== conversation) after = 0;
    const history = (await this.store.query(
      `SELECT * FROM backend_chat_message WHERE role=${sql(role)}`,
    )).filter((m: any) => messageGeneration(m.key) === conversation).sort((a: any, b: any) => a.id - b.id);
    const rows = (await this.store.query(`SELECT * FROM backend_chat WHERE role=${sql(role)}`))
      .filter((r: any) => (JSON.parse(r.config).conversation ?? 1) === conversation)
      .sort((a: any, b: any) => JSON.parse(a.config).createdAt - JSON.parse(b.config).createdAt);
    const turnRows = (await this.store.query(`SELECT * FROM backend_chat_turn WHERE role=${sql(role)}`))
      .filter((t: any) => (JSON.parse(t.config).conversation ?? 1) === conversation)
      .sort((a: any, b: any) => a.created - b.created || a.id.localeCompare(b.id));
    const origin = (key: string) => history.find((m: any) => messageKey(m.key) === `${key}:user`)?.id;
    const operations = rows.map((r: any) => {
      const op = this.decode(r);
      const turn = turnRows.find((t: any) => t.id === op.turnId);
      return { ...op, messageId: origin(turn?.request_key ?? r.request_key) };
    });
    const turns = turnRows.map((t: any) => ({ id: t.id, messageId: origin(t.request_key), state: t.state,
      createdAt: t.created, updatedAt: t.updated, ...JSON.parse(t.result) }));
    const all = history.filter((m: any) => m.id > after).map((m: any) => {
      const key = messageKey(m.key);
      const turn = turnRows.find((t: any) => key === `${t.request_key}:user` || key === `${t.id}:accepted` || key === `${t.id}:reply`);
      const op = operations.find((o: any) => o.id === m.operation);
      const kind = m.speaker === "simulation" ? key.endsWith(":resolved") ? "outcome" : "progress" : m.speaker === "operator" ? "user" : key.endsWith(":accepted") || key.endsWith(":planning") ? "progress"
        : key.endsWith(":plan") ? "deployment" : key.endsWith(":terminal") ? "outcome" : "answer";
      const replyTo = turn ? origin(turn.request_key) : op ? op.messageId : origin(key.replace(/:(user|reply)$/, ""));
      return { ...m, kind, replyTo, turnId: turn?.id ?? op?.turnId };
    });
    const messages = all.slice(0, 200);
    await this.currentFleet(fleet.epoch);
    await this.generation(role, conversation);
    return {
      conversation,
      turns,
      fleet: fleet ? { active: fleet.active, epoch: fleet.epoch } : null,
      messages,
      operations,
      after: messages.at(-1)?.id ?? after,
      more: all.length > messages.length,
    };
  }
  private async validateTarget(role: ChatRole, target?: number) {
    if (target === undefined) return;
    if (!Number.isInteger(target) || target < 1 || target > FLEET.maxDrones)
      return reject(400, "Invalid selected drone");
    const [drone] = await this.store.query(
      `SELECT * FROM fleet_drone WHERE id=${target}`,
    );
    const discovery =
      role === "attacker"
        ? await this.store.query(
            `SELECT * FROM fleet_discovery WHERE drone=${target}`,
          )
        : [];
    if (
      !drone ||
      (role === "attacker" &&
        !discovery.some((d: any) => d.epoch === drone.epoch))
    )
      return reject(403, "Selected drone is not visible to this role");
  }
  async message(
    role: ChatRole,
    message: string,
    key: string,
    target?: number,
    epoch?: number,
    conversation?: number,
  ): Promise<any> {
    if (typeof message !== "string" || !message.trim() || message.length > 2000)
      return Promise.reject(
        new StoreError(400, "Message must be 1..2000 characters"),
      );
    if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(key))
      return Promise.reject(new StoreError(400, "Idempotency-Key required"));
    if (/^(?:please )?(?:stop|cancel|pause)(?: (?:the |my )?(?:operation|agents))?[.!]?$/i.test(message.trim())) target = undefined;
    const fleet = await this.currentFleet(epoch);
    epoch = fleet.epoch;
    conversation = await this.generation(role, conversation ?? 1);
    const requestKey = epoch + ":" + role + ":" + conversation + ":" + key,
      signature = JSON.stringify([message, target ?? null]);
    const pending = this.messages.get(requestKey);
    if (pending)
      return pending.signature === signature
        ? pending.done
        : Promise.reject(new StoreError(409, "Idempotency conflict"));
    const done = Promise.resolve()
      .then(async () => {
        const [old] = await this.store.query(
          `SELECT * FROM backend_chat_message WHERE key=${sql(`epoch:${epoch}:chat:${conversation}:` + requestKey + ":user")}`,
        );
        if (old) {
          if (old.text !== message || old.target !== (target ?? 0))
            return reject(409, "Idempotency conflict");
          const [turn] = await this.store.query(`SELECT * FROM backend_chat_turn WHERE request_key=${sql(requestKey)}`);
          return { ...await this.conversation(role), ...(turn ? { accepted: { id: turn.id } } : {}) };
        }
        await this.validateTarget(role, target);
        const rows = await this.store.query(
          `SELECT * FROM backend_chat WHERE role=${sql(role)} AND epoch=${epoch}`,
        );
        const current = rows
          .filter((r: any) => ["planning", "running"].includes(r.state))
          .at(-1);
        const latest =
          current ??
          rows
            .sort(
              (a: any, b: any) =>
                JSON.parse(a.config).createdAt - JSON.parse(b.config).createdAt,
            )
            .at(-1);
        const stop =
          /^(?:please )?(?:stop|cancel|pause)(?: (?:the |my )?(?:operation|agents))?[.!]?$/i.test(
            message.trim(),
          );
        const status =
          /^(?:status|status update|(?:fleet|swarm) status|what(?:'s| is) (?:the )?status(?: of (?:my |our |the )?(?:fleet|swarm|operation|agents))?|how(?:'s| is) it going|what happened|what are (?:my |the )?agents doing)[?!.]?$/i.test(
            message.trim(),
          );
        let reply: string;
        if (stop) {
          const pending = [...this.turns.values()].filter((t) => t.role === role);
          for (const turn of pending) turn.abort.abort();
          await Promise.all(pending.map((t) => t.done));
          const active = (await this.store.query(`SELECT * FROM backend_chat WHERE role=${sql(role)}`)).find((r: any) => ["planning", "running"].includes(r.state));
          if (active) {
            const current = active;
            const op = await this.stop(current.id, role);
            reply =
              op.state === "cancelled"
                ? "Stopped your operation. Queued inference and workers have finished cancelling."
                : `Your operation is ${op.state}; no new instruction was applied.`;
          } else reply = pending.length ? "Stopped pending conversation work. No deployment will follow it." : "No active operation to stop.";
          if (/pause/i.test(message)) reply += " Pause cancels pending work; Continue requests a new bounded operation using the recent context.";
        } else if (current && /^(?:continue|keep going|continue (?:the )?operation)[.!]?$/i.test(message.trim())) {
          reply = "Your current operation is continuing within its existing attempt and time budgets. See Activity for progress.";
        } else if (status) {
          if (/fleet|swarm/i.test(message)) {
            const drones = await this.store.query("SELECT * FROM fleet_drone");
            const discoveries = role === "attacker" ? await this.store.query("SELECT * FROM fleet_discovery") : [];
            const visible = drones.filter((d: any) => d.epoch === epoch && (role === "defender" || discoveries.some((v: any) => v.epoch === epoch && v.drone === d.id)));
            reply = visible.length ? `${visible.length} ${role === "attacker" ? "discovered " : ""}drones; ${visible.filter((d: any) => d.controller === "attacker").length} currently compromised.` : "No drones have been discovered yet.";
          } else if (latest) {
            const op = await this.get(latest.id, role);
            const n = (kind: string) =>
              op.results.filter(
                (r: any) => r.status === "executed" && r.outcome === kind,
              ).length;
            reply = activeState(op.state) ? `${op.workers.filter((w: any) => ["queued","running"].includes(w.state)).length} agents are working. ${n("recovery_verified")} recoveries verified so far.` : `${op.outcome.status}. ${op.outcome.summary}`;
          } else reply = "No operation has been started for your role.";
        } else {
          return this.acceptTurn(role, message, requestKey, epoch!, conversation!, target);
        }
        await this.store.call("record_chat_exchange", [
          this.store.session,
          requestKey,
          role,
          message,
          target ?? 0,
          "",
          reply,
        ]);
        return this.conversation(role);
      })
      .finally(() => this.messages.delete(requestKey));
    this.messages.set(requestKey, { signature, done });
    return done;
  }
  private async acceptTurn(role: ChatRole, message: string, requestKey: string, epoch: number, conversation: number, target?: number) {
    if (this.shutdown.signal.aborted || this.stoppingFleet) return reject(503, "Service or fleet is stopping");
    await this.currentFleet(epoch);
    const [old] = await this.store.query(`SELECT * FROM backend_chat_turn WHERE request_key=${sql(requestKey)}`);
    if (old) {
      const input = JSON.parse(old.config);
      if (input.message !== message || input.target !== (target ?? null)) return reject(409, "Idempotency conflict");
      return { ...await this.conversation(role), accepted: { id: old.id } };
    }
    const began = Date.now(), id = randomUUID();
    const config = { epoch, conversation, message, target: target ?? null, createdAt: began, deadline: began + 30000 };
    await this.store.call("create_chat_turn", [this.store.session, id, requestKey, role, JSON.stringify(config)]);
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, this.shutdown.signal, AbortSignal.timeout(Math.max(1, config.deadline - Date.now()))]);
    const metric: any = { type: "inference", stage: "coordinator", agentId: 0, model: chatModels(this.env).coordinator, at: Date.now(), status: "queued", acceptanceMs: Date.now() - began };
    const done = Promise.resolve().then(() => this.routeTurn(id, role, config, metric, signal)).catch(() => { console.error("Conversation persistence failed:", id); }).finally(() => this.turns.delete(id));
    this.turns.set(id, { role, conversation, abort, done });
    return { ...await this.conversation(role), accepted: { id } };
  }
  private async routeTurn(id: string, role: ChatRole, config: any, metric: any, signal: AbortSignal) {
    let phase = "queued";
    const progress = () => {
      if (metric.status === "running") phase = "running";
      return this.store.call("update_chat_turn", [this.store.session, id, phase, JSON.stringify({ metric }), ""]);
    };
    try {
      if (!this.env.BITDEER_API_KEY) throw new DecisionError("provider_not_configured");
      const contextBegan = Date.now();
      const [history, operations, sessions, drones, discoveries, evidence, battle, options] = await Promise.all([
        this.store.query(`SELECT * FROM backend_chat_message WHERE role=${sql(role)}`),
        this.store.query(`SELECT * FROM backend_chat WHERE role=${sql(role)}`),
        this.store.query("SELECT * FROM fleet_session"),
        this.store.query("SELECT * FROM fleet_drone"),
        this.store.query("SELECT * FROM fleet_discovery"),
        this.store.query("SELECT * FROM fleet_evidence"),
        this.store.query("SELECT * FROM battle_drone"),
        this.store.query("SELECT * FROM battle_options"),
      ]);
      const fleet = sessions[0];
      const resilience = await resilienceContext(this.store, role);
      await this.currentFleet(config.epoch);
      await this.generation(role, config.conversation);
      metric.epoch = config.epoch;
      const known = new Set(discoveries.filter((d: any) => d.epoch === fleet?.epoch).map((d: any) => d.drone));
      const observations = drones.filter((d: any) => d.epoch === fleet?.epoch && (role === "defender" || known.has(d.id)))
        .map((d: any) => role === "attacker" ? { id: d.id, controller: d.controller } : { id: d.id, controller: d.controller, isolated: d.isolated, policyVersion: d.policy_version });
      const visibleEvidence = evidence.filter((e: any) => e.epoch === fleet?.epoch &&
        (role === "attacker" ? e.kind === "discovered" || e.kind.startsWith("unauthorized_command") : e.kind !== "discovered" && !e.kind.startsWith("challenge_")))
        .sort((a: any, b: any) => a.id - b.id).slice(-16)
        .map((e: any) => ({ id: e.id, target: e.drone, kind: e.kind, status: e.status }));
      const recentOps = operations.filter((r: any) => r.epoch === config.epoch && (JSON.parse(r.config).conversation ?? 1) === config.conversation).sort((a: any, b: any) => JSON.parse(a.config).createdAt - JSON.parse(b.config).createdAt).slice(-2).map((r: any) => {
        const op = this.decode(r);
        return { id: op.id, state: op.state, objective: op.message, tasks: op.tasks,
          results: op.results.slice(-8).map((r: any) => ({ target: r.target, kind: r.kind, status: r.status, outcome: r.outcome, error: r.error, evidenceId: r.evidenceId, simulation: r.simulation })),
          failures: op.inferences.filter((i: any) => i.error).map((i: any) => ({ stage: i.stage, error: i.error })) };
      });
      const evidenceIdsAllowed = new Set([...visibleEvidence.map((e: any) => e.id), ...recentOps.flatMap((o: any) => o.results.map((r: any) => r.evidenceId).filter(Boolean))]);
      const current = recentOps.find((o: any) => ["planning", "running"].includes(o.state));
      const recent = history.filter((m: any) => messageGeneration(m.key) === config.conversation && !m.key.endsWith(":accepted")).sort((a: any, b: any) => a.id - b.id).slice(-12)
        .map((m: any) => ({ speaker: m.speaker, text: m.text.slice(0, 700), target: m.target }));
      const taskSchema = {
        type: "object", additionalProperties: false, required: ["name", "specialty", "target", "objective", "goal"],
        properties: { name: { type: "string" }, specialty: { type: "string" }, target: { type: "integer", minimum: 1, maximum: fleet?.drones || FLEET.maxDrones }, objective: { type: "string" }, goal: { type: "string", enum: ["recon","capture","spread","contain","recover","restore","harden"] } },
      };
      const schema = { type: "object", additionalProperties: false, required: ["intent", "answer", "evidenceIds", "tasks"], properties: {
        intent: { type: "string", enum: ["answer", "clarify", "deploy", "replace"] }, answer: { type: "string" },
        evidenceIds: { type: "array", items: { type: "integer" } }, tasks: { type: "array", items: taskSchema, maxItems: 4 },
      } };
      metric.contextMs = Date.now() - contextBegan;
      const decision = await fleetInference({ pool: this.pool, env: this.env, signal, model: metric.model,
        stage: "coordinator", tokens: CHAT_LIMITS.coordinatorTokens, timeoutMs: CHAT_LIMITS.coordinatorTimeoutMs, metric, progress,
        schema, system: {
          task: resilience ? RESILIENCE_COORDINATOR : prompts.coordinator,
          role, agents: { min: 2, max: 4 }, targets: { min: 1, max: fleet?.drones || FLEET.maxDrones },
          allowed: resilience ? ["discover", ...resilienceActions(role)] : role === "attacker" ? ["discover", "prepare", "command", "spread", "wait"] : ["prepare", "isolate", "harden", "verify", "release", "wait"],
        }, input: { message: config.message, selectedTarget: config.target, history: recent,
          eligibleOptions: options.filter((o:any)=>o.role===role).map(({drone,actions,reachable,blocker}:any)=>({target:drone,actions,reachable,blocker})),
          session: { active: fleet?.active ?? false, epoch: fleet?.epoch ?? null },
          catalog: { targetIds: Array.from({ length: fleet?.drones || FLEET.maxDrones }, (_, i) => i + 1), communicationGraph: `${FLEET.columns}-column grid; links join horizontal neighbors in the same row and IDs ${FLEET.columns} apart; isolation breaks incident links`, discoveryAvailableBeforeObservation: role === "attacker" },
          observations, battle: battle.filter((h: any) => role === "defender" || known.has(h.drone)).map((h: any) => ({ drone: h.drone, contamination: h.contamination,
            prepared: role === "attacker" ? h.attack_prepared : h.defense_prepared, ...(role === "defender" ? { readiness: h.readiness } : {}) })),
          evidence: visibleEvidence, operations: recentOps, resilience },
        validate: (v) => {
          metric.validationFailure = !object(v, ["intent", "answer", "evidenceIds", "tasks"]) ? "fields"
            : !["answer", "clarify", "deploy", "replace"].includes(v.intent) ? "intent"
            : typeof v.answer !== "string" || !v.answer.trim() || v.answer.length > 2000 ? "answer"
            : !Array.isArray(v.evidenceIds) || v.evidenceIds.length > 16 || !v.evidenceIds.every((n: any) => Number.isSafeInteger(n) && evidenceIdsAllowed.has(n)) ? "evidence_references"
            : !Array.isArray(v.tasks) || (["deploy", "replace"].includes(v.intent) ? !this.validTasks(v.tasks, fleet?.drones || FLEET.maxDrones, config.target, role) : v.tasks.length !== 0) ? "assignments" : undefined;
          if (metric.validationFailure === "assignments") metric.assignmentValidation = { intent: v.intent, count: v.tasks?.length, tasks: Array.isArray(v.tasks) ? v.tasks.slice(0, 4).map((t: any) => ({ fields: object(t, ["name", "specialty", "target", "objective", "goal"]), nameFormat: validGoal(role,t.goal) && typeof t.name === "string" && /^[A-Za-z0-9][A-Za-z0-9 -]{0,27}$/.test(t.name) && t.name.trim() === t.name, specialtyFormat: typeof t.specialty === "string" && /^[A-Za-z0-9][A-Za-z0-9 -]{0,47}$/.test(t.specialty), objectiveLength: typeof t.objective === "string" ? t.objective.length : null, targetInRange: Number.isInteger(t.target) && t.target >= 1 && t.target <= (fleet?.drones || FLEET.maxDrones), targetMatches: config.target === null || config.target === t.target })) : [] };
          return !metric.validationFailure;
        },
      });
      signal.throwIfAborted();
      let reply: string, operationId: string | undefined;
      if (["deploy", "replace"].includes(decision.intent)) {
        if (current && decision.intent !== "replace") reply = "No change applied. An operation is running. Stop it first, then repeat the new objective or follow-up.";
        else {
          if (current) await this.stop(current.id, role);
          signal.throwIfAborted();
          const op = await this.start(role, config.message, "turn-" + id, config.target ?? undefined, { tasks: decision.tasks, metric, turnId: id }, config.epoch, config.conversation);
          operationId = op.id;
          reply = "Preparing the deployment.";
        }
      } else reply = decision.answer + (decision.evidenceIds.length ? ` Evidence: ${decision.evidenceIds.map((n: number) => "#" + n).join(", ")}.` : "");
      await this.store.call("update_chat_turn", [this.store.session, id, "completed", JSON.stringify({ intent: decision.intent, operationId, metric, responseMs: Date.now() - config.createdAt }), reply]);
    } catch (error) {
      const code = errorCode(error, signal);
      try {
        await this.store.call("update_chat_turn", [this.store.session, id, signal.aborted && signal.reason?.name !== "TimeoutError" ? "cancelled" : "failed",
          JSON.stringify({ error: code, metric, responseMs: Date.now() - config.createdAt }), code === "cancelled" ? "Pending request cancelled. No later deployment will follow this request." : explainFleetError(code)]);
      } catch (writeError) {
        const [turn] = await this.store.query(`SELECT * FROM backend_chat_turn WHERE id=${sql(id)}`);
        if (turn?.state !== "cancelled") throw writeError;
      }
    }
  }
  private validTasks(tasks: any[], max: number, target: number | null, role: ChatRole) {
    return tasks.length >= 2 && tasks.length <= 4 && tasks.every((t: any) => object(t, ["name", "specialty", "target", "objective", "goal"]) &&
      validGoal(role,t.goal) && typeof t.name === "string" && /^[A-Za-z0-9][A-Za-z0-9 -]{0,27}$/.test(t.name) && t.name.trim() === t.name &&
      typeof t.specialty === "string" && /^[A-Za-z0-9][A-Za-z0-9 -]{0,47}$/.test(t.specialty) &&
      typeof t.objective === "string" && t.objective.trim() && t.objective.length <= 300 &&
      Number.isInteger(t.target) && t.target >= 1 && t.target <= max && (target === null || t.target === target));
  }
  async start(role: ChatRole, message: string, key: string, target?: number, prepared?: { tasks: any[]; metric: any; turnId: string }, epoch?: number, conversation?: number) {
    if (typeof message !== "string" || !message.trim() || message.length > 2000)
      return reject(400, "Message must be 1..2000 characters");
    if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(key))
      return reject(400, "Idempotency-Key required");
    const sessionFleet = await this.currentFleet(epoch);
    epoch = sessionFleet.epoch;
    conversation = await this.generation(role, conversation ?? 1);
    let unlock!: () => void;
    const previous = this.admissions.get(role);
    const admission = new Promise<void>((r) => {
      unlock = r;
    });
    this.admissions.set(role, admission);
    await previous;
    try {
      if (this.shutdown.signal.aborted || this.stoppingFleet)
        return reject(503, "Service or fleet is stopping");
      const [existing] = await this.store.query(
        `SELECT * FROM backend_chat WHERE request_key=${sql(epoch + ":" + role + ":" + conversation + ":" + key)}`,
      );
      if (existing) {
        if (
          JSON.parse(existing.config).message !== message ||
          (JSON.parse(existing.config).target ?? null) !== (target ?? null)
        )
          return reject(409, "Idempotency conflict");
        return this.get(existing.id, role);
      }
      if (!this.env.BITDEER_API_KEY)
        return reject(
          503,
          "Bitdeer configuration required; no fixture fallback",
        );
      const rows = await this.store.query(`SELECT * FROM backend_chat WHERE epoch=${epoch}`);
      if (
        rows.some(
          (r: any) =>
            r.role === role && ["planning", "running"].includes(r.state),
        )
      )
        return reject(
          409,
          "Role operation already active; stop it before a new objective",
        );
      await this.validateTarget(role, target);
      let [fleet] = await this.store.query(
        "SELECT * FROM fleet_session WHERE id=0",
      );
      if (!fleet?.active || Number(fleet.deadline) !== 0) {
        await this.store.call("activate_chat_fleet", [
          this.store.session,
          role,
        ]);
        [fleet] = await this.store.query(
          "SELECT * FROM fleet_session WHERE id=0",
        );
      }
      await this.currentFleet(epoch);
      const id = randomUUID();
      const config = {
        conversation,
        message,
        target: target ?? null,
        tasks: [],
        model: chatModels(this.env).specialist,
        models: chatModels(this.env),
        execution: "fleet-reducers",
        ...(prepared ? { preparedPlan: prepared, turnId: prepared.turnId } : {}),
        ...CHAT_LIMITS,
        createdAt: Date.now(),
        deadline: Date.now() + CHAT_LIMITS.durationMs,
      };
      await this.store.call("create_chat_operation", [
        this.store.session,
        id,
        epoch + ":" + role + ":" + conversation + ":" + key,
        role,
        fleet.epoch,
        JSON.stringify(config),
      ]);
      const abort = new AbortController();
      const signal = AbortSignal.any([
        abort.signal,
        this.shutdown.signal,
        AbortSignal.timeout(Math.max(1, config.deadline - Date.now())),
      ]);
      const done = Promise.resolve()
        .then(() => this.execute(id, role, fleet, config, signal))
        .finally(() => this.workers.delete(id));
      this.workers.set(id, { abort, done });
      return this.get(id, role);
    } finally {
      unlock();
      if (this.admissions.get(role) === admission) this.admissions.delete(role);
    }
  }
  private async execute(
    id: string,
    role: ChatRole,
    fleet: any,
    config: any,
    signal: AbortSignal,
  ) {
    const records: any[] = [];
    let writes = Promise.resolve();
    let state = "planning";
    let calls = 0;
    const save = () => {
      const body = JSON.stringify(records),
        phase = state;
      writes = writes.then(() =>
        this.store.call("update_chat_operation", [
          this.store.session,
          id,
          phase,
          body,
        ]),
      );
      return writes;
    };
    const infer = async (stage: "coordinator" | "specialist", agentId: number, system: unknown, input: unknown, validate: (v: any) => boolean) => {
      if (++calls > CHAT_LIMITS.maxModelCalls) throw new DecisionError("model_budget_exhausted");
      const metric: any = { type: "inference", stage, agentId, model: config.models[stage], at: Date.now(), status: "queued" };
      records.push(metric);
      const schema =
          stage === "coordinator"
            ? {
                type: "object",
                additionalProperties: false,
                required: ["tasks"],
                properties: {
                  tasks: {
                    type: "array",
                    minItems: 2,
                    maxItems: 4,
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: ["name", "specialty", "target", "objective", "goal"],
                      properties: {
                        name: { type: "string", minLength: 1, maxLength: 28 },
                        specialty: { type: "string", minLength: 1, maxLength: 48 },
                        target: {
                          type: "integer",
                          minimum: config.target ?? 1,
                          maximum: config.target ?? (system as any).targets.max,
                        },
                        goal: { type: "string", enum: ["recon","capture","spread","contain","recover","restore","harden"] },
                        objective: {
                          type: "string",
                          minLength: 1,
                          maxLength: 300,
                        },
                      },
                    },
                  },
                },
              }
            : {
                type: "object",
                additionalProperties: false,
                required: ["kind"],
                properties: { kind: { type: "string", enum: (system as any).allowed } },
              };
      return fleetInference({ pool: this.pool, env: this.env, signal, model: metric.model, stage,
        tokens: stage === "coordinator" ? CHAT_LIMITS.coordinatorTokens : CHAT_LIMITS.specialistTokens,
        timeoutMs: stage === "coordinator" ? CHAT_LIMITS.coordinatorTimeoutMs : CHAT_LIMITS.requestTimeoutMs,
        system, input, schema, metric, validate, progress: save });
    };
    let failed = false;
    try {
      const drones = await this.store.query("SELECT * FROM fleet_drone");
      const discovery = new Set(
        (await this.store.query("SELECT * FROM fleet_discovery")).map(
          (d: any) => d.drone,
        ),
      );
      const battle = await this.store.query("SELECT * FROM battle_drone");
      const options=await this.store.query("SELECT * FROM battle_options");
      const observation =
        role === "defender"
          ? drones.map((d: any) => ({ id: d.id, controller: d.controller, isolated: d.isolated, policy_version: d.policy_version }))
          : drones
              .filter((d: any) => discovery.has(d.id))
              .map((d: any) => ({ id: d.id, controller: d.controller }));
      const resilience = await resilienceContext(this.store, role);
      const plan = config.preparedPlan ?? await infer(
        "coordinator",
        0,
        {
          task: resilience ? RESILIENCE_COORDINATOR + " Return only {tasks:[{name,specialty,target,objective,goal}]}." : "Plan assignments for an explicit deployment. " + prompts.coordinator + " In this stage return only {tasks:[{name,specialty,target,objective,goal}]}; routing was already requested by the operator.",
          role,
          agents: { min: 2, max: CHAT_LIMITS.maxAgents },
          targets: {
            min: config.target ?? 1,
            max: config.target ?? fleet.drones,
          },
          permitted: resilience ? ["discover", ...resilienceActions(role)] :
            role === "attacker"
              ? ["discover", "prepare", "command", "spread", "wait"]
              : ["prepare", "isolate", "harden", "verify", "release", "wait"],
        },
        { message: config.message, selectedTarget: config.target, observation, resilience,
          eligibleOptions:options.filter((o:any)=>o.role===role).map(({drone,actions,reachable,blocker}:any)=>({target:drone,actions,reachable,blocker})),
          battle: battle.filter((h: any) => role === "defender" || discovery.has(h.drone)).map((h: any) => ({ drone: h.drone, contamination: h.contamination,
            prepared: role === "attacker" ? h.attack_prepared : h.defense_prepared, ...(role === "defender" ? { readiness: h.readiness } : {}) })) },
        (v) =>
          object(v, ["tasks"]) &&
          Array.isArray(v.tasks) &&
          v.tasks.length >= 2 &&
          v.tasks.length <= 4 &&
          v.tasks.every(
            (t: any) =>
              object(t, ["name", "specialty", "target", "objective", "goal"]) &&
              validGoal(role,t.goal) && typeof t.name === "string" && /^[A-Za-z0-9][A-Za-z0-9 -]{0,27}$/.test(t.name) &&
              t.name.trim() === t.name &&
              typeof t.specialty === "string" && /^[A-Za-z0-9][A-Za-z0-9 -]{0,47}$/.test(t.specialty) &&
              Number.isInteger(t.target) &&
              t.target >= 1 &&
              t.target <= fleet.drones &&
              (config.target === null || t.target === config.target) &&
              typeof t.objective === "string" &&
              t.objective.trim() &&
              t.objective.length <= 300,
          ),
      );
      if (config.preparedPlan) records.push({ ...config.preparedPlan.metric, type: "inference", stage: "coordinator", agentId: 0 });
      signal.throwIfAborted();
      const validationBegan = Date.now();
      const names = new Set<string>();
      const ids = new Set<number>();
      for (const task of plan.tasks) {
        const base = task.name;
        let suffix = 1;
        while (names.has(task.name.toLowerCase())) task.name = `${base} ${++suffix}`;
        names.add(task.name.toLowerCase());
        do { task.agentId = randomInt(1, 0x100000000); } while (ids.has(task.agentId));
        ids.add(task.agentId);
      }
      await this.store.call("plan_chat_operation", [
        this.store.session,
        id,
        JSON.stringify(plan.tasks),
      ]);
      records.push({ type: "timing", stage: "deployment", validationMs: Date.now() - validationBegan, at: Date.now() });
      state = "running";
      await Promise.allSettled(
        (plan.tasks as Task[]).map(async (task) => {
          const worker: any = {
            type: "worker",
            agentId: task.agentId,
            target: task.target,
            state: "queued",
            stage: "queued",
            at: Date.now(),
          };
          records.push(worker);
          let attempt: any;
          try {
            await save();
            for (
              let step = 1;
              step <= CHAT_LIMITS.maxDecisionsPerAgent;
              step++
            ) {
              signal.throwIfAborted();
              const [drone] = await this.store.query(
                `SELECT * FROM fleet_drone WHERE id=${task.target}`,
              );
              const discovery = await this.store.query(
                `SELECT * FROM fleet_discovery WHERE drone=${task.target}`,
              );
              const observation =
                role === "defender"
                  ? drone
                  : discovery.length
                    ? {
                        id: drone.id,
                        controller: drone.controller,
                        x: drone.x,
                        y: drone.y,
                        z: drone.z,
                      }
                    : { id: task.target, discovered: false };
              const [battleHealth] = await this.store.query(`SELECT * FROM battle_drone WHERE drone=${task.target}`);
              if (battleHealth && (role === "defender" || discovery.length)) Object.assign(observation, { contamination: battleHealth.contamination,
                prepared: role === "attacker" ? battleHealth.attack_prepared : battleHealth.defense_prepared,
                ...(role === "defender" ? { readiness: battleHealth.readiness } : {}) });
              const resilience = await resilienceContext(this.store, role, task.target);
              const [options] = resilience ? [] : await this.store.query(`SELECT * FROM battle_options WHERE key=${sql(role+":"+task.target)}`);
              const eligible = goalActions(role,task.goal,options?.actions ?? (!discovery.length && role === "attacker" ? ["discover"] : []));
              if (!resilience && goalSatisfied(task.goal,drone,battleHealth,!!discovery.length,attempt)) {
                worker.state = "completed"; worker.reason = "Objective satisfied."; worker.at=Date.now(); break;
              }
              if (!resilience && !eligible.length) {
                const pending = await this.store.query(`SELECT * FROM battle_attempt WHERE operation=${sql(id)}`);
                if (pending.some((a:any)=>a.agent!==task.agentId && a.stage!=="resolved")) {
                  worker.state="queued"; worker.stage="waiting"; worker.reason="Waiting for an active operation."; await save();
                  await delay(500,undefined,{signal}); step--; continue;
                }
                worker.state="failed"; worker.reason=options?.blocker || "No valid useful action remains within this objective."; worker.at=Date.now(); failed=true; break;
              }
              const allowed = resilience ? role === "attacker" && !discovery.length ? ["discover", "wait"] : resilienceActions(role) :
                [...eligible,"wait"];
              const memory = records.filter(
                (r) =>
                  r.agentId === task.agentId &&
                  !["inference", "worker"].includes(r.type),
              );
              worker.state="running"; worker.stage=attempt?.simulation?.succeeded===0 ? "reassessing" : "assessing"; worker.reason=worker.stage==="reassessing" ? "Preparing a revised attempt." : "Assessing permitted actions."; worker.at=Date.now();
              const action = await infer(
                "specialist",
                task.agentId,
                {
                  task: resilience ? RESILIENCE_SPECIALIST : prompts.specialist,
                  role,
                  allowed,
                },
                {
                  assignment: task,
                  options,
                  observation,
                  resilience,
                  memory,
                  decisionsRemaining:
                    CHAT_LIMITS.maxDecisionsPerAgent + 1 - step,
                },
                (v) => object(v, ["kind"]) && allowed.includes(v.kind),
              );
              signal.throwIfAborted();
              attempt = {
                agentId: task.agentId,
                target: task.target,
                step,
                kind: action.kind,
                intent: task.objective,
                observation: resilience ? resilience.observations : observation,
                status: "queued",
                actionId: `${id}:${task.agentId}:${step}`,
                at: Date.now(),
              };
              records.push(attempt);
              await save();
              signal.throwIfAborted();
              const executionBegan = Date.now();
              await this.store.call("execute_fleet_chat_action", [
                this.store.session,
                id,
                step,
                task.agentId,
                task.target,
                action.kind,
                role === "defender" ? drone.policy_version : 0,
              ]);
              const executionMs = Date.now() - executionBegan;
              const [receipt] = await this.store.query(
                `SELECT * FROM fleet_chat_action WHERE key=${sql(id + ":" + task.agentId + ":" + step)}`,
              );
              if (!resilience && !["discover", "wait"].includes(action.kind)) {
                for (;;) {
                  signal.throwIfAborted();
                  const [pending] = await this.store.query(`SELECT * FROM battle_attempt WHERE key=${sql(attempt.actionId)}`);
                  if (!pending) throw new DecisionError("cancelled");
                  attempt.stage = pending.stage;
                  attempt.simulation = JSON.parse(pending.report);
                  await save();
                  if (pending.stage === "resolved") break;
                  await delay(250, undefined, { signal });
                }
                Object.assign(receipt, (await this.store.query(`SELECT * FROM fleet_chat_action WHERE key=${sql(attempt.actionId)}`))[0]);
              }
              const [evidence] = receipt.evidence_id
                ? await this.store.query(
                    `SELECT * FROM fleet_evidence WHERE id=${receipt.evidence_id}`,
                  )
                : [];
              if (receipt.evidence_id && !evidence)
                throw new DecisionError("evidence_missing");
              Object.assign(attempt, {
                agentId: task.agentId,
                target: task.target,
                step,
                kind: action.kind,
                status: "executed",
                executionMs,
                receiptReadMs: Date.now() - executionBegan - executionMs,
                evidenceId: receipt.evidence_id,
                outcome: attempt.simulation?.outcome ?? evidence?.kind ?? "wait",
                responseStatus: evidence?.status ?? null,
                policyVersion: evidence?.policy_version ?? null,
                verificationEvidenceIds: [
                  receipt.unauthorized_evidence_id,
                  receipt.authorized_evidence_id,
                ].filter(Boolean),
                at: Date.now(),
              });
              if (resilience && evidence?.kind.endsWith("_scheduled")) {
                await delay(350, undefined, { signal });
                const effects = await this.store.query(`SELECT * FROM fleet_evidence WHERE actor=${task.agentId} AND drone=${task.target}`);
                attempt.verifiedEffectEvidenceId = effects.find((e: any) => e.kind === "challenge_effect" && e.id > receipt.evidence_id)?.id;
              }
              if (!resilience && action.kind === "wait") {
                worker.state="failed"; worker.reason="Agent stopped without completing its objective."; failed=true; break;
              }
              worker.state="queued"; worker.stage="reassessing"; worker.reason="Evaluating the result before the next bounded decision."; worker.at=Date.now();
              await save();
              await delay(resilience ? action.kind === "wait" ? 1000 : 350 : 250, undefined, { signal });
            }
            if (["queued","running"].includes(worker.state)) {
              const [drone]=await this.store.query(`SELECT * FROM fleet_drone WHERE id=${task.target}`);
              const [health]=await this.store.query(`SELECT * FROM battle_drone WHERE drone=${task.target}`);
              const known=await this.store.query(`SELECT * FROM fleet_discovery WHERE drone=${task.target}`);
              worker.state=resilience || goalSatisfied(task.goal,drone,health,!!known.length,attempt) ? "completed" : "failed";
              worker.reason=worker.state==="completed" ? "Objective satisfied." : "Attempt budget exhausted.";
            }
            worker.at=Date.now(); if(worker.state==="failed") failed=true;
            await save();
          } catch (error) {
            failed = true;
            worker.state =
              signal.aborted && signal.reason?.name !== "TimeoutError"
                ? "cancelled"
                : "failed";
            worker.reason=explainFleetError(errorCode(error,signal)); worker.at=Date.now();
            worker.error = errorCode(error, signal);
            if (attempt?.status === "queued")
              Object.assign(attempt, { status: "failed", error: worker.error });
            if (attempt?.status !== "failed")
              records.push({
                agentId: task.agentId,
                target: task.target,
                status:
                  signal.aborted && signal.reason?.name !== "TimeoutError"
                    ? "cancelled"
                    : "failed",
                error: errorCode(error, signal),
                at: Date.now(),
              });
            await save();
          }
        }),
      );
    } catch (error) {
      failed = true;
      records.push({
        agentId: 0,
        status: "failed",
        error: errorCode(error, signal),
        at: Date.now(),
      });
    }
    await writes.catch(() => {});
    const terminal =
      signal.aborted && signal.reason?.name !== "TimeoutError"
        ? "cancelled"
        : failed || signal.aborted
          ? "failed"
          : "completed";
    await this.store
      .call("update_chat_operation", [
        this.store.session,
        id,
        terminal,
        JSON.stringify(records),
      ])
      .catch(() => {});
  }
  async stop(id: string, role: ChatRole) {
    await this.get(id, role);
    const worker = this.workers.get(id);
    if (worker) {
      worker.abort.abort();
      await worker.done;
    }
    return this.get(id, role);
  }
  async endFleet(resetEpoch?: number, demo = false) {
    if (this.stoppingFleet) return reject(409, "Fleet is already stopping or resetting");
    this.stoppingFleet = true;
    try {
      const [fleet] = await this.store.query("SELECT * FROM fleet_session WHERE id=0");
      if (resetEpoch !== undefined && fleet?.epoch !== resetEpoch)
        return reject(409, "Fleet changed; synchronizing current state");
      if (resetEpoch !== undefined) await this.store.call("reset_chat_fleet", [this.store.session, resetEpoch, demo || !!await resilienceContext(this.store, "defender")]);
      else await this.store.call("stop_fleet", []);
      const pending = [...this.turns.values(), ...this.workers.values()];
      for (const work of pending) work.abort.abort();
      await Promise.allSettled([...this.admissions.values(), ...[...this.messages.values()].map((m) => m.done), ...pending.map((w) => w.done)]);
      if (resetEpoch !== undefined) {
        const [current] = await this.store.query("SELECT * FROM fleet_session WHERE id=0");
        const drones = await this.store.query("SELECT * FROM fleet_drone");
        const agents = await this.store.query("SELECT * FROM fleet_agent");
        const evidence = await this.store.query("SELECT * FROM fleet_evidence");
        if (current?.epoch !== resetEpoch + 1 || !current.active || drones.length !== fleet.drones ||
            drones.some((d: any) => d.epoch !== current.epoch || d.controller !== "defender" || d.policy_version !== 0 || d.isolated !== fleet.hardened) || agents.length || evidence.length)
          return reject(502, "Fleet reset could not be verified; synchronizing current state");
        return { reset: true, epoch: current.epoch };
      }
    } finally {
      this.stoppingFleet = false;
    }
  }
  async close() {
    this.shutdown.abort();
    await Promise.all([...this.turns.values()].map((t) => t.done));
    await Promise.all(this.admissions.values());
    await Promise.allSettled([...this.messages.values()].map((m) => m.done));
    await Promise.all([...this.workers.values()].map((w) => w.done));
  }
}
