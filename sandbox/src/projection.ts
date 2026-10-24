import { summarize } from './report.ts';

const fields: Record<string, string[]> = {
  request: ['phase', 'method', 'status', 'latencyMs', 'legitimate', 'probe', 'endpoint', 'secretReleased', 'policyVersion'],
  capture: ['round', 'verifiedBy', 'sourceRequestId'], reclaim: ['round', 'policyVersion', 'attackEventId', 'normalEventId', 'readEventId', 'updateEventId', 'tokenRevoked'],
  rule_change: ['rule', 'evidenceId'], policy_rejected: ['rule', 'evidenceId', 'reason'],
  task_published: ['taskId', 'scenario', 'evidenceId'], task_claimed: ['taskId', 'scenario', 'evidenceId', 'author'], task_completed: ['taskId', 'scenario', 'evidenceId', 'author'],
  untrusted_telemetry: ['provenance', 'scenario'], rotation: ['round'], match_started: ['actorCount'], match_stopped: ['reason'],
};
export const safeText = (value: unknown) => String(value ?? '').replace(/FLAG_[a-f0-9]+|\b[a-f0-9]{48}\b|Bearer\s+\S+/gi, '[redacted]').slice(0, 240);
const pick = (value: any, keys: string[]) => Object.fromEntries(keys.filter(k => ['string', 'number', 'boolean'].includes(typeof value?.[k])).map(k => [k, typeof value[k] === 'string' ? safeText(value[k]) : value[k]]));
const policy = (p: any) => pick(p, ['version', 'isolation', 'reserve', 'denyAll']);

// Explicitly allowlisted public data; never send arbitrary provider output or telemetry bodies.
export function projectRun(run: any) {
  if (!run || typeof run.id !== 'string' || !Array.isArray(run.events)) throw new Error('Invalid run snapshot');
  const events = run.events.filter((e: any) => fields[e.kind]).map((e: any) => ({
    ...pick(e, ['id', 'at', 'kind', 'actor', 'team', 'target']), matchId: safeText(run.id),
    detail: { ...pick(e.detail, fields[e.kind]), ...(e.kind === 'rule_change' ? { before: policy(e.detail.before), after: policy(e.detail.after) } : {}) },
  }));
  const traces = (run.agentTraces ?? []).map((t: any) => ({ ...pick(t, ['actor', 'at', 'status', 'eventId', 'inferenceMs']),
    ...(t.error ? { error: 'Decision failed; inspect private runner diagnostics' } : {}),
    ...(t.action ? { action: pick(t.action, ['kind', 'scenario', 'rule', 'version', 'evidenceId', 'taskId']) } : {}),
    ...(t.usage ? { usage: pick(t.usage, ['prompt_tokens', 'completion_tokens', 'total_tokens']) } : {}),
  }));
  const probes = (run.probes ?? []).map((p: any) => pick(p, ['at', 'target', 'isolation', 'normal', 'attackStatus', 'legitimateStatus', 'attackPolicyVersion', 'legitimatePolicyVersion']));
  return { schemaVersion: 1, projectionVersion: 1, id: safeText(run.id), engine: run.engine === 'bitdeer' ? 'bitdeer' : 'fixture',
    model: run.engine === 'bitdeer' ? safeText(run.model) : null,
    ...pick(run, ['round', 'decisionBudget']), live: Boolean(run.live), elapsedMs: Number(run.elapsedMs) || 0,
    config: pick(run.config, ['durationMs', 'attackers', 'defenders', 'clients', 'mode', 'loadProfile']),
    actors: (run.actors ?? []).map((a: any) => pick(a, ['id', 'team', 'role'])),
    assets: (run.assets ?? []).map((a: any) => pick(a, ['id', 'home', 'controlledBy', 'round'])),
    events, agentTraces: traces, probes, summary: summarize({ events }, probes, traces),
    infrastructureErrorCount: (run.infrastructureErrors ?? []).length || Number(run.infrastructureErrorCount) || 0,
  };
}

// Reconstruct a frame exclusively from recorded events. No fabricated intermediate outcomes.
export function replayFrame(run: any, at: number) {
  const frame = { ...run, elapsedMs: at, live: false, events: run.events.filter((e: any) => e.at <= at),
    agentTraces: (run.agentTraces ?? []).filter((t: any) => t.at <= at), probes: (run.probes ?? []).filter((p: any) => p.at <= at) };
  frame.assets = ['red', 'blue'].map(home => {
    const changes = frame.events.filter((e: any) => e.target === home && ['capture', 'reclaim'].includes(e.kind));
    const last = changes.at(-1);
    return { id: home, home, controlledBy: last?.kind === 'capture' ? last.team : home };
  });
  frame.summary = summarize(frame, frame.probes, frame.agentTraces);
  return frame;
}
