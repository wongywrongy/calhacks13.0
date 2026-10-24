import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { startServer } from './server.ts';
import { assertPracticeUrl, call } from './client.ts';
import { config, other } from './catalog.ts';
import type { Actor, Config } from './catalog.ts';
import { bitdeerEngine, fixtureEngine, runAgent } from './agents.ts';
import type { AgentTrace } from './agents.ts';
import { summarize } from './report.ts';
import { DecisionPool } from './decision-pool.ts';

export async function runMatch(options: Partial<Config> & { engine?: 'fixture' | 'bitdeer'; remote?: boolean; signal?: AbortSignal; decisions?: number; inferencePool?: DecisionPool; maxModelCalls?: number; bitdeer?: { apiKey?: string; model: string }; onSnapshot?: (snapshot: any) => void } = {}) {
  const settings = config({ durationMs: options.durationMs ?? 12000, attackers: options.attackers ?? 3, defenders: options.defenders ?? 2,
    clients: options.clients ?? 4, mode: options.mode ?? 'hardened', loadProfile: options.loadProfile ?? 'steady' });
  const engine = options.engine ?? 'fixture';
  const decisionBudget = options.decisions ?? (engine === 'bitdeer' ? 20 : 120);
  if (!Number.isInteger(decisionBudget) || decisionBudget < 1 || decisionBudget > 120) throw new Error('Decision budget must be 1..120');
  const maxModelCalls = options.maxModelCalls ?? 120;
  if (!Number.isInteger(maxModelCalls) || maxModelCalls < 1 || maxModelCalls > 1000) throw Error('Model call budget must be 1..1000');
  const owned = options.remote ? null : await startServer();
  const base = assertPracticeUrl(owned?.url ?? 'http://practice:8080');
  const refereeKey = owned?.refereeKey ?? process.env.SUDOKO_REFEREE_KEY;
  if (!refereeKey) throw new Error('Missing referee credential');
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal?.addEventListener('abort', stop, { once: true });
  const traces: AgentTrace[] = [], probes: any[] = [], infrastructureErrors: string[] = [];
  const workers: Promise<void>[] = [];
  let matchStarted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Fail before starting a run if model configuration is missing. Never fall back to fixtures.
    const rawDecide = engine === 'bitdeer' ? bitdeerEngine({ apiKey: options.bitdeer?.apiKey ?? process.env.BITDEER_API_KEY, model: options.bitdeer?.model ?? process.env.BITDEER_MODEL ?? '',
      proxyKey: options.remote ? process.env.INFERENCE_PROXY_KEY : undefined, signal: controller.signal }) : fixtureEngine(settings.mode);
    const admission = (options.inferencePool ?? new DecisionPool()).wrap(rawDecide, controller.signal, maxModelCalls);
    const decide = engine === 'bitdeer' ? admission.decide : rawDecide;
    if (options.signal?.aborted) throw new Error('Run cancelled');
    const opened = await call(base, refereeKey, '/control/start', settings);
    if (opened.status !== 201) throw new Error(`Cannot start match: HTTP ${opened.status}`);
    matchStarted = true;
    const actors: Actor[] = opened.body.actors;
    const started = Date.now();
    timer = setTimeout(stop, settings.durationMs);
    const normal = async (actor: Actor, index: number) => {
      await delay(index * 29, undefined, { signal: controller.signal });
      let iteration = 0;
      while (!controller.signal.aborted) {
        const endpoint = ['status', 'artifact', 'update'][iteration++ % 3];
        await call(base, actor.token, `/v1/${actor.team}/${endpoint}`, endpoint === 'update' ? { operation: 'heartbeat' } : undefined, controller.signal);
        const fraction = (Date.now() - started) / settings.durationMs;
        const burst = settings.loadProfile === 'burst' && fraction >= .25 && fraction < .65;
        await delay(burst ? 110 : 180, undefined, { signal: controller.signal });
      }
    };
    const referee = async () => {
      let rotated = false;
      while (!controller.signal.aborted) {
        if (!rotated && Date.now() - started > settings.durationMs / 2) {
          await call(base, refereeKey, '/control/rotate', {}); rotated = true;
        }
        for (const actor of actors.filter(a => a.role === 'probe')) {
          const target = other(actor.team);
          const attack = await call(base, actor.token, `/v1/${target}/artifact`, undefined, controller.signal);
          const client = actors.find(a => a.role === 'client' && a.team === target)!;
          const good = await call(base, client.token, `/v1/${target}/status`, undefined, controller.signal);
          if (attack.status === 403 && good.status === 200) {
            const clients = actors.filter(a => a.role === 'client' && a.team === target);
            const read = await call(base, (clients[1] ?? clients[0]).token, `/v1/${target}/artifact`, undefined, controller.signal);
            const update = await call(base, (clients[2] ?? clients[0]).token, `/v1/${target}/update`, { operation: 'heartbeat' }, controller.signal);
            await call(base, refereeKey, '/control/reclaim', { target, attackEventId: attack.body.eventId, normalEventId: good.body.eventId, readEventId: read.body.eventId, updateEventId: update.body.eventId }, controller.signal);
          }
          probes.push({ at: Date.now() - started, target, isolation: attack.status === 403 ? 'blocked' : attack.status === 200 ? 'exposed' : 'inconclusive',
            normal: good.status === 200 ? 'available' : 'unavailable', attackStatus: attack.status, legitimateStatus: good.status,
            attackPolicyVersion: attack.body.policyVersion, legitimatePolicyVersion: good.body.policyVersion });
        }
        await delay(350, undefined, { signal: controller.signal });
      }
    };
    const supervise = (name: string, work: Promise<void>) => work.catch(error => {
      if (!controller.signal.aborted) { infrastructureErrors.push(`${name}: ${error.message}`); stop(); }
    });
    actors.forEach((actor, i) => {
      if (actor.role === 'probe') return;
      workers.push(supervise(actor.id, actor.role === 'client' ? normal(actor, i) : runAgent(base, actor, decide, controller.signal, traces, i, decisionBudget, started)));
    });
    workers.push(supervise('referee', referee()));
    if (options.onSnapshot) workers.push(supervise('observer', (async () => {
      while (!controller.signal.aborted) {
        const state = await call(base, refereeKey, '/control/snapshot', undefined, controller.signal);
        if (state.status !== 200) throw new Error('Cannot observe match');
        options.onSnapshot!({ ...state.body, engine, model: engine === 'bitdeer' ? (options.bitdeer?.model ?? process.env.BITDEER_MODEL) : null,
          decisionBudget, inference: { ...admission.metrics }, agentTraces: traces, probes, summary: summarize(state.body, probes, traces) });
        await delay(500, undefined, { signal: controller.signal });
      }
    })()));
    await Promise.all(workers);
    await call(base, refereeKey, '/control/stop', {});
    // Drain bounded in-flight requests before taking the final trace.
    await delay(220);
    const state = await call(base, refereeKey, '/control/snapshot');
    if (state.status !== 200) throw new Error('Cannot read final snapshot');
    const completed = { schemaVersion: 1, engine, decisionBudget, model: engine === 'bitdeer' ? (options.bitdeer?.model ?? process.env.BITDEER_MODEL) : null,
      inference: { ...admission.metrics }, scenarioVersion: 'catalog-v2', endedEarly: Date.now() - started < settings.durationMs, infrastructureErrors,
      ...state.body, probes, agentTraces: traces, summary: summarize(state.body, probes, traces) };
    options.onSnapshot?.(completed);
    return completed;
  } finally {
    stop(); if (timer) clearTimeout(timer);
    await Promise.allSettled(workers);
    if (matchStarted && !owned) {
      try { await call(base, refereeKey, '/control/stop', {}); } catch { /* Server deadlines still stop an unreachable match. */ }
    }
    options.signal?.removeEventListener('abort', stop);
    if (owned) await owned.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = (name: string, fallback: string) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
  const engine = value('--engine', process.env.SUDOKO_ENGINE ?? 'fixture');
  if (!['fixture', 'bitdeer'].includes(engine)) throw new Error('Engine must be fixture or bitdeer');
  const durationMs = Number(value('--seconds', engine === 'bitdeer' ? '45' : '12')) * 1000;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const output = value('--output', 'output/sandbox'); await mkdir(output, { recursive: true });
  const modes = args.includes('--compare') ? ['baseline', 'hardened'] as const : [value('--mode', 'hardened')];
  try {
    for (const mode of modes) {
      if (controller.signal.aborted) break;
      if (mode !== 'baseline' && mode !== 'hardened') throw new Error('Mode must be baseline or hardened');
      console.log(`Starting ${mode}: ${engine} decisions; real HTTP service; ${durationMs / 1000}s`);
      const run = await runMatch({ mode, engine: engine as 'fixture' | 'bitdeer', durationMs,
        attackers: Number(value('--attackers', '3')), defenders: Number(value('--defenders', '2')), clients: Number(value('--clients', '4')),
        decisions: Number(value('--decisions', engine === 'bitdeer' ? '20' : '120')), loadProfile: value('--load-profile', 'steady') as Config['loadProfile'], remote: args.includes('--remote'), signal: controller.signal });
      const file = join(output, `${mode}-${run.id}.json`);
      await writeFile(file, JSON.stringify(run, null, 2));
      console.log(JSON.stringify({ file, engine, actors: run.actors.length, ...run.summary }, null, 2));
      if (run.infrastructureErrors.length || run.summary.agentErrors) process.exitCode = 1;
    }
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
