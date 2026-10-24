import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { startBoard } from '../sandbox/src/demo.ts';
import { runMatch } from '../sandbox/src/run.ts';
import { makePublisher } from '../sandbox/src/spacetime.ts';
import { projectRun } from '../sandbox/src/projection.ts';

let localProcess: ReturnType<typeof spawn> | undefined;
let temporary: string | undefined;
const uri = process.env.CHECK_SPACETIME_URI ?? 'http://127.0.0.1:3011';
if (process.env.SPACETIME_BINARY) {
  temporary = await mkdtemp('/tmp/sudoko-stdb-test-');
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await writeFile(`${temporary}/private.pem`, keys.privateKey, { mode: 0o600 });
  await writeFile(`${temporary}/public.pem`, keys.publicKey);
  localProcess = spawn(process.env.SPACETIME_BINARY, ['start', '--listen-addr', new URL(uri).host, '--data-dir', `${temporary}/data`, '--in-memory', '--jwt-priv-key-path', `${temporary}/private.pem`, '--jwt-pub-key-path', `${temporary}/public.pem`, '--non-interactive'], { stdio: 'ignore' });
  process.on('exit', () => localProcess?.kill());
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${uri}/v1/ping`)).ok) break; } catch {}
    if (localProcess.exitCode !== null) throw new Error(`Spacetime exited: ${localProcess.exitCode}`);
    await delay(200);
  }
}
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(uri)) throw new Error('Integration check only creates databases on a local test server');
const database = `sudoko-check-${Date.now()}`;
const identityResponse = await fetch(`${uri}/v1/identity`, { method: 'POST' });
assert(identityResponse.ok, 'local identity creation');
const identity = await identityResponse.json() as any;
assert.equal(typeof identity.token, 'string');
const headers = { authorization: `Bearer ${identity.token}` };
const published = await fetch(`${uri}/v1/database/${database}?host_type=Wasm`, { method: 'PUT', headers, body: await readFile('arena-live/target/wasm32-unknown-unknown/release/sudoko_live.wasm') });
assert(published.ok, `Module deployment: ${published.status} ${await published.text()}`);
console.log('Compiled module deployed to a new local test database.');
const publisher = makePublisher({ uri, database, token: identity.token });
const board = await startBoard({ port: 0, spacetime: { uri, database } });
const browser = await chromium.launch({ headless: true });
try {
  const a = await browser.newPage(), b = await browser.newPage();
  const errors: string[] = []; a.on('pageerror', e => errors.push(e.message)); b.on('pageerror', e => errors.push(e.message));
  await Promise.all([a.goto(board.url), b.goto(board.url)]);
  const run = await runMatch({ durationMs: 3500, onSnapshot: state => { board.update(state); publisher.push(state); } });
  await publisher.flush();
  await Promise.all([a.waitForFunction(id => document.getElementById('metadata')?.textContent?.includes(id), run.id.slice(0,8)), b.waitForFunction(id => document.getElementById('metadata')?.textContent?.includes(id), run.id.slice(0,8))]);
  assert.equal(await a.locator('#metadata').textContent(), await b.locator('#metadata').textContent());
  assert.equal(await a.locator('.roster li').count(), 10);
  assert.equal(await a.locator('#transport').textContent(), 'SPACETIME SUBSCRIPTION');
  const original = await a.locator('#teams').textContent();
  await b.reload(); await b.waitForFunction(() => document.querySelectorAll('.roster li').length === 10);
  assert.equal(await b.locator('#teams').textContent(), original, 'reconnect preserves outcomes');
  const payload = projectRun(run);
  const call = (args: any[], authorized: boolean) => fetch(`${uri}/v1/database/${database}/call/publish_snapshot`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? headers : {}) }, body: JSON.stringify(args) });
  assert(!(await call([run.id, 999, JSON.stringify(payload)], false)).ok, 'viewer cannot publish');
  assert(!(await call([run.id, 1, JSON.stringify(payload)], true)).ok, 'stale sequence rejected');
  const next = await runMatch({ durationMs: 700, mode: 'baseline' });
  board.update(next); publisher.push(next); await publisher.flush();
  await a.waitForFunction(id => document.getElementById('metadata')?.textContent?.includes(id), next.id.slice(0,8));
  assert(!(await call([run.id, 9999, JSON.stringify(payload)], true)).ok, 'old match cannot overwrite new match');
  assert.equal((await fetch(`${board.url}/api/state`, { method: 'POST' })).status, 405);
  const state = await fetch(`${board.url}/api/state`).then(r => r.text());
  assert(!state.includes(identity.token)); assert(!/FLAG_[a-f0-9]{48}/.test(state));
  await a.selectOption('#recordings', run.id);
  await a.waitForFunction(() => document.getElementById('connection')?.textContent === 'RECORDED');
  await a.waitForTimeout(100);
  assert.equal(await a.locator('#notice').textContent(), '', 'intentional replay disconnect is not an error');
  await a.locator('#scrub').fill('0'); await a.locator('#scrub').dispatchEvent('input');
  assert.equal(await a.locator('.asset strong').first().textContent(), 'RED TEAM');
  await a.locator('#scrub').fill(String(run.elapsedMs)); await a.locator('#scrub').dispatchEvent('input');
  await mkdir('output/qa', { recursive: true });
  await a.screenshot({ path: 'output/qa/board-desktop.png', fullPage: true });
  await a.setViewportSize({ width: 390, height: 844 });
  assert(await a.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile has no horizontal overflow');
  await a.screenshot({ path: 'output/qa/board-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('PASS: two real subscriptions, ten-agent roster, reconnect, unauthorized/stale writes, new-match reset, secret-free projection, replay, desktop/mobile and zero browser errors.');
} finally {
  await browser.close(); await board.close();
  const removed = await fetch(`${uri}/v1/database/${database}`, { method: 'DELETE', headers });
  if (!removed.ok) console.error(`Test database cleanup failed: HTTP ${removed.status}`);
  if (localProcess) { localProcess.kill(); await new Promise(resolve => localProcess!.once('exit',resolve)); }
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
