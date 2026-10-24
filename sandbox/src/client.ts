import { catalog, injection, other, validateAction } from './catalog.ts';
import type { Action, Actor } from './catalog.ts';

export function assertPracticeUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'practice'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('The runner only connects to its loopback or Compose practice service');
  }
  return url.origin;
}
export async function call(base: string, credential: string, path: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000),
    headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
export function actorTools(rawBase: string, actor: Actor, signal?: AbortSignal) {
  const base = assertPracticeUrl(rawBase);
  return {
    observe: () => call(base, actor.token, '/agent/observe', undefined, signal),
    async act(input: unknown) {
      const action: Action = validateAction(input, actor);
      if (action.kind === 'wait') return { status: 204, body: {} };
      if (action.kind === 'submit_flag') return call(base, actor.token, '/agent/submit', { value: action.value }, signal);
      if (action.kind === 'write_rule') return call(base, actor.token, '/agent/rules', { ...action, team: actor.team }, signal);
      // The model supplies a catalog ID, never a host, path, payload, header, or executable code.
      const target = other(actor.team);
      switch (action.scenario) {
        case 'WK-01': return call(base, actor.token, `/v1/${target}/artifact`, undefined, signal);
        case 'WK-02': return call(base, actor.token, `/v1/${target}/telemetry`, { note: injection }, signal);
        case 'WK-03': return call(base, actor.token, `/v1/${target}/report`, undefined, signal);
        default: throw new Error('Unknown scenario');
      }
    },
    catalog: catalog.filter(c => c.role === actor.role),
  };
}
