import { readFile, writeFile, stat } from 'node:fs/promises';
const args = process.argv.slice(2);
const value = (name: string, fallback: string) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const uri = value('--uri', 'http://127.0.0.1:3000');
const database = value('--database', `sudoko-live-${Date.now()}`);
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(uri)) throw new Error('This helper creates only local databases. Configure hosted deployment credentials separately.');
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(database)) throw new Error('Invalid database name');
try { await stat('.demo.env'); throw new Error('.demo.env already exists; reuse it or move it aside intentionally'); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
const wasm = await readFile('arena-live/target/wasm32-unknown-unknown/release/sudoko_live.wasm');
const exists = await fetch(`${uri}/v1/database/${database}`);
if (exists.status !== 404) throw new Error('Database name is unavailable or server rejected the check; choose a new name');
const auth = await fetch(`${uri}/v1/identity`, { method: 'POST' });
if (!auth.ok) throw new Error(`Identity creation failed: HTTP ${auth.status}`);
const identity = await auth.json() as any;
if (typeof identity.token !== 'string') throw new Error('Missing local publisher token');
const published = await fetch(`${uri}/v1/database/${database}?host_type=Wasm`, { method: 'PUT', headers: { authorization: `Bearer ${identity.token}` }, body: wasm });
if (!published.ok) throw new Error(`Deployment failed: HTTP ${published.status}`);
await writeFile('.demo.env', `SPACETIME_URI=${uri}\nSPACETIME_DATABASE=${database}\nSPACETIME_TOKEN=${identity.token}\n`, { mode: 0o600, flag: 'wx' });
console.log(`Created local database ${database}. Publisher credential saved privately to .demo.env. Run npm run demo:spacetime.`);
