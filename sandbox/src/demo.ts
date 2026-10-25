import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { projectRun } from './projection.ts';
import { runMatch } from './run.ts';
import { makePublisher, spacetimeConfig } from './spacetime.ts';

export async function startBoard(options: { port?: number; spacetime?: { uri: string; database: string } | null } = {}) {
  let current: any = null;
  const completed = new Map<string, any>(), viewers = new Set<ServerResponse>();
  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'no-store');
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const json = (value: any, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/config') return json({ spacetime: options.spacetime ?? null });
    if (url.pathname === '/api/state') return json(current);
    if (url.pathname === '/api/runs') return json([...completed.values()].map(r => ({ id: r.id, engine: r.engine, mode: r.config.mode })));
    if (url.pathname.startsWith('/api/runs/')) return json(completed.get(url.pathname.slice(10)) ?? { error: 'Unknown run' }, completed.has(url.pathname.slice(10)) ? 200 : 404);
    if (url.pathname === '/api/events') {
      if (viewers.size >= 32) return json({ error: 'Viewer limit' }, 503);
      res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(current)}\n\n`); viewers.add(res);
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 1500);
      req.on('close', () => { clearInterval(heartbeat); viewers.delete(res); });
      return;
    }
    const file = url.pathname === '/' ? '../../web/live.html' : url.pathname === '/app.js' ? '../../web/dist/app.js' : url.pathname === '/theme.css' ? '../../web/theme.css' : null;
    if (!file) return json({ error: 'Not found' }, 404);
    try { const body = await readFile(new URL(file, import.meta.url)); res.writeHead(200, { 'content-type': file.endsWith('html') ? 'text/html' : file.endsWith('css') ? 'text/css' : 'text/javascript' }); res.end(body); }
    catch { json({ error: 'Run npm run build:board first' }, 503); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 4173, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing board address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    update(raw: any) {
      current = projectRun(raw);
      if (!current.live) { completed.set(current.id, current); while (completed.size > 10) completed.delete(completed.keys().next().value!); }
      for (const viewer of viewers) { if (viewer.writableLength > 4e6) { viewer.destroy(); viewers.delete(viewer); } else viewer.write(`data: ${JSON.stringify(current)}\n\n`); }
    },
    close: async () => { for (const v of viewers) v.end(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), value = (name: string, fallback: string) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
  const engine = value('--engine', 'fixture'); if (!['fixture', 'bitdeer'].includes(engine)) throw new Error('Unknown engine');
  const seconds = Number(value('--seconds', '30'));
  const config = spacetimeConfig(), publisher = config ? makePublisher(config) : null;
  const board = await startBoard({ port: Number(value('--port', '4173')), spacetime: config ? { uri: config.uri, database: config.database } : null });
  console.log(`Read-only board: ${board.url} · ${publisher ? 'Spacetime' : 'local stream (Spacetime not configured)'}`);
  console.log('Press Enter to start a fresh baseline/hardened pair; Ctrl-C to stop.');
  const controller = new AbortController(); let busy = false;
  const launch = async () => {
    if (busy || controller.signal.aborted) return; busy = true;
    try {
      for (const mode of ['baseline', 'hardened'] as const) {
        if (controller.signal.aborted) break;
        const run = await runMatch({ mode, engine: engine as 'fixture' | 'bitdeer', durationMs: seconds * 1000, loadProfile: 'burst', signal: controller.signal,
          onSnapshot: raw => { board.update(raw); publisher?.push(raw); } });
        await publisher?.flush();
        await mkdir('output/demo', { recursive: true });
        await writeFile(`output/demo/${run.id}.json`, JSON.stringify(projectRun(run), null, 2));
        console.log(`${mode} complete: ${run.id}; ${run.summary.agentErrors} decision errors`);
      }
    } catch (e) { console.error(e instanceof Error ? e.message : 'Demo failed'); }
    finally { busy = false; }
  };
  process.stdin.on('data', () => void launch()); process.stdin.resume();
  const stop = () => { controller.abort(); process.stdin.pause(); void board.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  if (args.includes('--autorun')) await launch();
}
