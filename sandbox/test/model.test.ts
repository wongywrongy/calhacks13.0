import test from 'node:test';
import assert from 'node:assert/strict';
import { bitdeerEngine } from '../src/agents.ts';
import type { Actor } from '../src/catalog.ts';

const actor: Actor = { id: 'red-scout-1', role: 'scout', team: 'red', token: 'synthetic-test-credential' };
test('Bitdeer adapter validates responses and never grants a new tool or target', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let content = '{"action":{"kind":"request","scenario":"WK-01"}}';
  globalThis.fetch = (async (url: any, options: any) => {
    assert.equal(url, 'https://api-inference.bitdeer.ai/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    const sent = JSON.parse(options.body);
    assert.equal(sent.max_tokens, 256);
    assert.equal(sent.model, 'test-model');
    assert(!options.body.includes(actor.token));
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 40 } }));
  }) as typeof fetch;
  const engine = bitdeerEngine({ apiKey: 'synthetic-provider-key', model: 'test-model' });
  const decided = await engine(actor, { events: [] }, {});
  assert.deepEqual(decided.action, { kind: 'request', scenario: 'WK-01' });
  content = '{"action":{"kind":"write_rule","rule":"maintenance-open","version":0,"evidenceId":1}}';
  await assert.rejects(() => engine(actor, {}, {}), /outside/);
  content = '{"action":{"kind":"request","scenario":"https://example.com"}}';
  await assert.rejects(() => engine(actor, {}, {}), /outside/);
  content = 'not JSON';
  await assert.rejects(() => engine(actor, {}, {}));
});
test('missing model configuration and provider failures are explicit, with no fixture fallback', async t => {
  assert.throws(() => bitdeerEngine({ model: '' }), /BITDEER_MODEL/);
  assert.throws(() => bitdeerEngine({ model: 'test-model' }), /BITDEER_API_KEY/);
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (async () => new Response('{}', { status: 503 })) as typeof fetch;
  await assert.rejects(() => bitdeerEngine({ model: 'test-model', apiKey: 'test' })(actor, {}, {}), /HTTP 503/);
});
