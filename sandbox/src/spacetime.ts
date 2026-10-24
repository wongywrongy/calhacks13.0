import { projectRun } from './projection.ts';

export function spacetimeConfig(env = process.env) {
  if (!env.SPACETIME_URI && !env.SPACETIME_DATABASE && !env.SPACETIME_TOKEN) return null;
  if (!env.SPACETIME_URI || !env.SPACETIME_DATABASE || !env.SPACETIME_TOKEN) throw new Error('Set SPACETIME_URI, SPACETIME_DATABASE and SPACETIME_TOKEN together');
  const url = new URL(env.SPACETIME_URI);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('Spacetime requires HTTPS or local HTTP');
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(env.SPACETIME_DATABASE)) throw new Error('Invalid Spacetime database name');
  return { uri: url.origin, database: env.SPACETIME_DATABASE, token: env.SPACETIME_TOKEN };
}
export function makePublisher(config: NonNullable<ReturnType<typeof spacetimeConfig>>) {
  let pending: any, running: Promise<void> | undefined, failure: string | null = null;
  let sequence = 0;
  const publish = async () => {
    while (pending) {
      const run = pending; pending = undefined;
      const response = await fetch(`${config.uri}/v1/database/${config.database}/call/publish_snapshot`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
        body: JSON.stringify([run.id, ++sequence, JSON.stringify(run)]),
      });
      if (!response.ok) throw new Error(`Spacetime publication failed: HTTP ${response.status}`);
      failure = null;
    }
  };
  return {
    push(run: any) {
      pending = projectRun(run);
      if (!running) running = publish().catch(e => { failure = e.message; pending = undefined; }).finally(() => { running = undefined; });
    },
    async flush() { await running; if (failure) throw new Error(failure); },
    status: () => ({ configured: true, error: failure }),
  };
}
