import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readJson, send } from './server.ts';

const credential = process.env.INFERENCE_PROXY_KEY ?? '';
const apiKey = process.env.BITDEER_API_KEY ?? '';
const model = process.env.BITDEER_MODEL ?? '';
if (credential.length < 32 || !apiKey || !model) throw new Error('Set INFERENCE_PROXY_KEY, BITDEER_API_KEY and BITDEER_MODEL');
let active = 0;
const server = createServer({ requestTimeout: 3000, headersTimeout: 3000, maxHeaderSize: 4096 }, async (req, res) => {
  const auth = Buffer.from(String(req.headers.authorization ?? ''));
  const expected = Buffer.from(`Bearer ${credential}`);
  if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return send(res, { status: 403, body: { error: 'Not authorized' } });
  if (req.url !== '/decision' || req.method !== 'POST') return send(res, { status: 404, body: {} });
  if (active >= 24) return send(res, { status: 429, body: { error: 'Inference concurrency limit' } });
  active++;
  try {
    const body = await readJson(req, 65536);
    if (!Array.isArray(body.messages) || body.messages.length !== 2 || body.messages.some((m: any) => !['system', 'user'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 30000)) {
      return send(res, { status: 400, body: { error: 'Invalid messages' } });
    }
    // Fixed upstream, model, token ceiling and route. This is not a general HTTP proxy.
    const response = await fetch('https://api-inference.bitdeer.ai/v1/chat/completions', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: body.messages, temperature: 0, max_tokens: 256 }),
    });
    if (!response.ok) return send(res, { status: 502, body: { error: `Inference HTTP ${response.status}` } });
    const raw = await response.text();
    if (raw.length > 65536) throw new Error('Response too large');
    send(res, { status: 200, body: JSON.parse(raw) });
  } catch { send(res, { status: 502, body: { error: 'Inference unavailable' } }); }
  finally { active--; }
});
server.listen(8081, '0.0.0.0');
process.once('SIGTERM', () => { server.closeAllConnections(); server.close(); });
