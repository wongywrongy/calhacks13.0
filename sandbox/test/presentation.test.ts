import test from 'node:test';
import assert from 'node:assert/strict';
import { projectRun, replayFrame } from '../src/projection.ts';
import { inferenceMessages, bitdeerEngine } from '../src/agents.ts';
import { runMatch } from '../src/run.ts';
import { startBoard } from '../src/demo.ts';
import { spacetimeConfig } from '../src/spacetime.ts';

const actor = { id: 'red-scout-1', team: 'red' as const, role: 'scout' as const, token: 'private-actor-token' };
test('model receives scenario meanings, typed actions, task lifecycle and budget without its credential', () => {
  const messages = inferenceMessages(actor, { events: [] }, { decisionsRemaining: 4 });
  const contract = JSON.parse(messages[0].content), input = JSON.parse(messages[1].content);
  assert.equal(contract.scenarios.length, 3);
  assert(contract.scenarios.every((s: any) => s.effect.length > 20));
  assert(contract.tools.some((t: any) => t.kind === 'claim_task'));
  assert.equal(input.decisionsRemaining, 4);
  assert(!JSON.stringify(messages).includes(actor.token));
});
test('provider malformed JSON never echoes secret response content into traces', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'private-response-secret' } }] }))) as typeof fetch;
  await assert.rejects(() => bitdeerEngine({ apiKey: 'synthetic-key', model: 'test' })(actor, {}, {}), e => e instanceof Error && e.message === 'Model returned invalid action JSON');
});
test('public projection allowlists fields and replay derives control from observed transitions', () => {
  const flag = `FLAG_${'a'.repeat(48)}`;
  const raw = { id: 'test', engine: 'fixture', elapsedMs: 50, live: false, actors: [actor], config: {}, assets: [],
    events: [
      { id: 1, at: 10, kind: 'capture', actor: actor.id, team: 'red', target: 'blue', detail: { round: 1, artifact: flag } },
      { id: 2, at: 20, kind: 'untrusted_telemetry', actor: actor.id, team: 'red', target: 'blue', detail: { note: flag, scenario: 'WK-02' } },
      { id: 3, at: 30, kind: 'reclaim', actor: 'referee', team: '', target: 'blue', detail: { tokenRevoked: true } },
    ], agentTraces: [{ actor: actor.id, at: 11, action: { kind: 'submit_flag', value: flag }, error: actor.token, usage: { arbitrary: actor.token, total_tokens: 12 } }],
    refereeKey: 'private-referee', providerKey: 'private-provider', probes: [] };
  const projected = projectRun(raw), serialized = JSON.stringify(projected);
  for (const secret of [flag, actor.token, raw.refereeKey, raw.providerKey]) assert(!serialized.includes(secret));
  assert.equal(replayFrame(projected, 5).assets[1].controlledBy, 'blue');
  assert.equal(replayFrame(projected, 15).assets[1].controlledBy, 'red');
  assert.equal(replayFrame(projected, 50).assets[1].controlledBy, 'blue');
  assert.deepEqual(projectRun(projected), projected, 'projection is idempotent for imported public recordings');
});
test('real run streams bounded decisions and a final snapshot through a read-only board', async t => {
  const board = await startBoard({ port: 0 }); t.after(board.close);
  const snapshots: any[] = [];
  const run = await runMatch({ durationMs: 700, decisions: 1, onSnapshot: raw => { snapshots.push(projectRun(raw)); board.update(raw); } });
  assert(snapshots.length >= 2); assert.equal(snapshots.at(-1).live, false);
  assert(run.agentTraces.filter((trace: any) => trace.action).length <= 10);
  assert.equal((await fetch(`${board.url}/api/state`, { method: 'POST' })).status, 405);
  const state = await fetch(`${board.url}/api/state`).then(r => r.json()) as any;
  assert.equal(state.id, run.id); assert.equal(state.live, false);
  const recordings = await fetch(`${board.url}/api/runs`).then(r => r.json()) as any[];
  assert.equal(recordings.length, 1);
  assert(!/FLAG_[a-f0-9]{48}/.test(JSON.stringify(state)));
  await assert.rejects(() => runMatch({ decisions: 1000 }), /Decision budget/);
});
test('Spacetime configuration is explicit and cannot expose bearer credentials in URLs', () => {
  assert.equal(spacetimeConfig({}), null);
  assert.throws(() => spacetimeConfig({ SPACETIME_URI: 'http://evil.invalid' }), /together/);
  assert.throws(() => spacetimeConfig({ SPACETIME_URI: 'https://user:password@example.com', SPACETIME_DATABASE: 'test', SPACETIME_TOKEN: 'private' }), /HTTPS/);
});
