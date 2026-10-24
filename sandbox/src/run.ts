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

export async function runMatch(options: Partial<Config> & { engine?: 'fixture' | 'bitdeer'; remote?: boolean; signal?: AbortSignal } = {}) {
  const settings = config({ durationMs: options.durationMs ?? 12000, attackers: options.attackers ?? 3, defenders: options.defenders ?? 2,
    clients: options.clients ?? 4, mode: options.mode ?? 'hardened' });
  const engine = options.engine ?? 'fixture';
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
    const decide = engine === 'bitdeer' ? bitdeerEngine({ apiKey: process.env.BITDEER_API_KEY, model: process.env.BITDEER_MODEL ?? '',
      proxyKey: options.remote ? process.env.INFERENCE_PROXY_KEY : undefined, signal: controller.signal }) : fixtureEngine(settings.mode);
    if (options.signal?.aborted) throw new Error('Run cancelled');
    const opened = await call(base, refereeKey, '/control/start', settings);
    if (opened.status !== 201) throw new Error(`Cannot start match: HTTP ${opened.status}`);
    matchStarted = true;
    const actors: Actor[] = opened.body.actors;
    const started = Date.now();
    timer = setTimeout(stop, settings.durationMs);
    const normal = async (actor: Actor, index: number) => {
      await delay(index * 29, undefined, { signal: controller.signal });
      while (!controller.signal.aborted) {
        await call(base, actor.token, `/v1/${actor.team}/status`, undefined, controller.signal);
        await delay(140, undefined, { signal: controller.signal });
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
      workers.push(supervise(actor.id, actor.role === 'client' ? normal(actor, i) : runAgent(base, actor, decide, controller.signal, traces, i)));
    });
    workers.push(supervise('referee', referee()));
    await Promise.all(workers);
    await call(base, refereeKey, '/control/stop', {});
    // Drain bounded in-flight requests before taking the final trace.
    await delay(220);
    const state = await call(base, refereeKey, '/control/snapshot');
    if (state.status !== 200) throw new Error('Cannot read final snapshot');
    return { schemaVersion: 1, engine, model: engine === 'bitdeer' ? process.env.BITDEER_MODEL : null,
      scenarioVersion: 'catalog-v1', endedEarly: Date.now() - started < settings.durationMs, infrastructureErrors,
      ...state.body, probes, agentTraces: traces, summary: summarize(state.body, probes, traces) };
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
        remote: args.includes('--remote'), signal: controller.signal });
      const file = join(output, `${mode}-${run.id}.json`);
      await writeFile(file, JSON.stringify(run, null, 2));
      console.log(JSON.stringify({ file, engine, actors: run.actors.length, ...run.summary }, null, 2));
      if (run.infrastructureErrors.length || run.summary.agentErrors) process.exitCode = 1;
    }
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
