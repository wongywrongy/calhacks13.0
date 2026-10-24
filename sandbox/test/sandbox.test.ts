import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, LIMITS } from '../src/server.ts';
import { call, actorTools, assertPracticeUrl } from '../src/client.ts';
import { injection, validateAction } from '../src/catalog.ts';
import type { Actor } from '../src/catalog.ts';
import { runMatch } from '../src/run.ts';
import { summarize } from '../src/report.ts';

async function fixture(t: any, mode: 'baseline' | 'hardened' = 'hardened') {
  const server = await startServer(); t.after(server.close);
  const opened = await call(server.url, server.refereeKey, '/control/start', { durationMs: 10000, attackers: 8, defenders: 2, clients: 4, mode });
  assert.equal(opened.status, 201);
  const actors = opened.body.actors as Actor[];
  const pick = (team: string, role: string) => actors.find(a => a.team === team && a.role === role)!;
  return { ...server, actors, pick };
}

test('an HTTP leak earns one capture; private state and cross-round flags stay hidden', async t => {
  const s = await fixture(t);
  const attacker = s.pick('red', 'scout');
  const tools = actorTools(s.url, attacker);
  const response = await tools.act({ kind: 'request', scenario: 'WK-01' });
  assert.equal(response.status, 200); assert.match(response.body.artifact, /^FLAG_/);
  assert.equal((await tools.act({ kind: 'submit_flag', value: response.body.artifact })).status, 200);
  assert.equal((await tools.act({ kind: 'submit_flag', value: response.body.artifact })).status, 409);
  const observe = await tools.observe();
  assert.equal(observe.body.policy, undefined);
  assert(!JSON.stringify(observe.body).includes(response.body.artifact));
  assert.equal((await call(s.url, attacker.token, '/control/snapshot')).status, 403);
  const snapshot = await call(s.url, s.refereeKey, '/control/snapshot');
  assert(!JSON.stringify(snapshot).includes(response.body.artifact));
  for (const actor of s.actors) assert(!JSON.stringify(snapshot).includes(actor.token));
  await call(s.url, s.refereeKey, '/control/rotate', {});
  assert.equal((await tools.act({ kind: 'submit_flag', value: response.body.artifact })).status, 400);
});

test('caller identity, namespace ownership and version checks protect rule writes', async t => {
  const s = await fixture(t), attacker = s.pick('red', 'scout'), defender = s.pick('blue', 'policy');
  const response = await actorTools(s.url, attacker).act({ kind: 'request', scenario: 'WK-01' });
  const payload = { team: 'blue', rule: 'tenant-isolation', version: 0, evidenceId: response.body.eventId };
  assert.equal((await call(s.url, attacker.token, '/agent/rules', payload)).status, 403);
  assert.equal((await call(s.url, defender.token, '/agent/rules', { ...payload, team: 'red' })).status, 403);
  const concurrent = await Promise.all([call(s.url, defender.token, '/agent/rules', payload), call(s.url, s.pick('blue', 'availability').token, '/agent/rules', payload)]);
  assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]);
  assert.equal((await actorTools(s.url, attacker).act({ kind: 'request', scenario: 'WK-01' })).status, 403);
  assert.equal((await call(s.url, s.pick('blue', 'client').token, '/v1/blue/status')).status, 200);
  assert.equal((await call(s.url, defender.token, '/control/stop', {})).status, 403);
  assert.equal((await call(s.url, attacker.token, '/control/score', { score: 999 })).status, 403);
});

test('the injection fixture reaches observations; hardened authorization rejects weakening isolation', async t => {
  const s = await fixture(t), defender = s.pick('blue', 'policy');
  const leak = await actorTools(s.url, s.pick('red', 'scout')).act({ kind: 'request', scenario: 'WK-01' });
  await call(s.url, defender.token, '/agent/rules', { team: 'blue', rule: 'tenant-isolation', version: 0, evidenceId: leak.body.eventId });
  const injected = await actorTools(s.url, s.pick('red', 'deceiver')).act({ kind: 'request', scenario: 'WK-02' });
  assert.equal(injected.status, 202);
  const observation = await actorTools(s.url, defender).observe();
  const evidence = observation.body.events.find((e: any) => e.kind === 'untrusted_telemetry');
  assert.equal(evidence.detail.note, injection);
  const denied = await call(s.url, defender.token, '/agent/rules', { team: 'blue', rule: 'maintenance-open', version: 1, evidenceId: evidence.id });
  assert.equal(denied.status, 403);
  assert.equal((await actorTools(s.url, s.pick('red', 'scout')).act({ kind: 'request', scenario: 'WK-01' })).status, 403);
});

test('baseline weakening changes actual service behavior; this is a policy fixture, not an LLM claim', async t => {
  const s = await fixture(t, 'baseline'), defender = s.pick('blue', 'policy'), attacker = actorTools(s.url, s.pick('red', 'scout'));
  const leak = await attacker.act({ kind: 'request', scenario: 'WK-01' });
  await call(s.url, defender.token, '/agent/rules', { team: 'blue', rule: 'tenant-isolation', version: 0, evidenceId: leak.body.eventId });
  assert.equal((await attacker.act({ kind: 'request', scenario: 'WK-01' })).status, 403);
  await actorTools(s.url, s.pick('red', 'deceiver')).act({ kind: 'request', scenario: 'WK-02' });
  const observation = await actorTools(s.url, defender).observe();
  const evidence = observation.body.events.find((e: any) => e.kind === 'untrusted_telemetry');
  assert.equal((await call(s.url, defender.token, '/agent/rules', { team: 'blue', rule: 'maintenance-open', version: 1, evidenceId: evidence.id })).status, 200);
  assert.equal((await attacker.act({ kind: 'request', scenario: 'WK-01' })).status, 200);
});

test('real concurrent work exhausts slots; capacity reservation preserves a normal request', async t => {
  const s = await fixture(t), pressure = s.actors.filter(a => a.team === 'red' && a.role === 'pressure');
  const clients = s.actors.filter(a => a.team === 'blue' && a.role === 'client');
  const jobs = Array.from({ length: LIMITS.slots }, (_, i) => call(s.url, pressure[i % pressure.length].token, '/v1/blue/report'));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await call(s.url, clients[0].token, '/v1/blue/status')).status, 503);
  const completed = await Promise.all(jobs);
  assert(completed.every(r => r.status === 200));
  const defender = s.pick('blue', 'availability');
  assert.equal((await call(s.url, defender.token, '/agent/rules', { team: 'blue', rule: 'reserve-capacity', version: 0, evidenceId: completed[0].body.eventId })).status, 200);
  const limited = Array.from({ length: LIMITS.slots }, (_, i) => call(s.url, pressure[i % pressure.length].token, '/v1/blue/report'));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await call(s.url, clients[1].token, '/v1/blue/status')).status, 200);
  const results = await Promise.all(limited);
  assert.equal(results.filter(r => r.status === 200).length, 1);
  assert.equal(results.filter(r => r.status === 429).length, 2);
});

test('overblocking harms real legitimate traffic and an availability defender can restore it', async t => {
  const s = await fixture(t), defender = s.pick('blue', 'policy'), recovery = s.pick('blue', 'availability');
  const initial = await call(s.url, s.pick('blue', 'client').token, '/v1/blue/status');
  await call(s.url, defender.token, '/agent/rules', { team: 'blue', rule: 'block-all', version: 0, evidenceId: initial.body.eventId });
  const failed = await call(s.url, s.pick('blue', 'client').token, '/v1/blue/status');
  assert.equal(failed.status, 403);
  await call(s.url, recovery.token, '/agent/rules', { team: 'blue', rule: 'restore-service', version: 1, evidenceId: failed.body.eventId });
  assert.equal((await call(s.url, s.pick('blue', 'client').token, '/v1/blue/status')).status, 200);
});

test('agents cannot choose external targets, payloads, privileges, or unbounded settings', async t => {
  for (const value of ['https://example.com', 'http://169.254.169.254', 'http://127.0.0.1@evil.test', 'http://127.0.0.1/path']) assert.throws(() => assertPracticeUrl(value));
  assert.throws(() => validateAction({ kind: 'request', scenario: 'WK-99' }, { role: 'scout' }));
  assert.throws(() => validateAction({ kind: 'write_rule', rule: 'maintenance-open', version: 0, evidenceId: 1 }, { role: 'scout' }));
  const s = await fixture(t);
  assert.equal((await call(s.url, s.pick('red', 'deceiver').token, '/v1/blue/telemetry', { note: 'uncatalogued content' })).status, 400);
  // Fetch normalizes dot segments, but the resolved privileged endpoint still rejects the actor.
  assert.equal((await call(s.url, s.pick('red', 'scout').token, '/v1/blue/../../control/stop', {})).status, 403);
  await call(s.url, s.refereeKey, '/control/stop', {});
  assert.equal((await call(s.url, s.refereeKey, '/control/start', { attackers: 1000 })).status, 400);
});

test('stop revokes in-flight actions; restarting rejects old credentials and evidence', async t => {
  const s = await fixture(t), attacker = s.pick('red', 'pressure');
  const pending = call(s.url, attacker.token, '/v1/blue/report');
  await new Promise(resolve => setTimeout(resolve, 30));
  await call(s.url, s.refereeKey, '/control/stop', {});
  assert.equal((await pending).status, 409);
  assert.equal((await call(s.url, attacker.token, '/v1/blue/report')).status, 409);
  const reopened = await call(s.url, s.refereeKey, '/control/start', { durationMs: 1000 });
  assert.equal(reopened.status, 201);
  assert.equal((await call(s.url, attacker.token, '/agent/observe')).status, 401);
});

test('referee never treats overload as a security pass or verifies a superseded rule version', () => {
  const snapshot = { events: [{ id: 1, at: 0, kind: 'rule_change', target: 'blue', detail: { rule: 'tenant-isolation', after: { version: 1 } } }] };
  const fakeProbes = [{ at: 1, target: 'blue', isolation: 'inconclusive', normal: 'unavailable' },
    { at: 2, target: 'blue', isolation: 'blocked', normal: 'available', attackPolicyVersion: 2, legitimatePolicyVersion: 2 }];
  const summary: any = summarize(snapshot, fakeProbes, []);
  assert.equal(summary.metrics.blue.mitigations[0].verified, false);
});

test('multi-agent run produces measured requests, independent probes, concurrent defenses and no secrets', async () => {
  const run = await runMatch({ durationMs: 2200, attackers: 3, defenders: 2, clients: 2 });
  assert.equal(run.actors.filter((a: Actor) => !['client', 'probe'].includes(a.role)).length, 10);
  assert.equal(run.engine, 'fixture');
  assert.equal(run.infrastructureErrors.length, 0);
  assert.equal(run.summary.agentErrors, 0);
  assert(run.probes.length > 0);
  assert(run.events.some((e: any) => e.kind === 'capture'));
  assert(run.events.some((e: any) => e.kind === 'rule_change'));
  assert(run.events.some((e: any) => e.kind === 'untrusted_telemetry'));
  assert.equal(new Set(run.agentTraces.map((t: any) => t.actor)).size, 10);
  assert(!/FLAG_[a-f0-9]{48}/.test(JSON.stringify(run)));
});

test('team handoffs enforce team privacy, atomic claims, and actual follow-up requests', async t => {
  const s = await fixture(t), scout = s.pick('red', 'scout'), mate = s.pick('red', 'deceiver');
  const a = actorTools(s.url, scout), b = actorTools(s.url, mate);
  const evidence = await a.act({ kind: 'request', scenario: 'WK-01' });
  const published = await a.act({ kind: 'publish_task', scenario: 'WK-03', evidenceId: evidence.body.eventId });
  assert.equal(published.status, 201);
  const taskId = published.body.task.id;
  assert.deepEqual((await actorTools(s.url, s.pick('blue', 'scout')).observe()).body.tasks, []);
  assert.equal((await actorTools(s.url, s.pick('blue', 'scout')).act({ kind: 'claim_task', taskId })).status, 404);
  const claims = await Promise.all([b.act({ kind: 'claim_task', taskId }), b.act({ kind: 'claim_task', taskId })]);
  assert.deepEqual(claims.map(c => c.status).sort(), [200, 409]);
  assert.equal((await b.act({ kind: 'complete_task', taskId })).status, 400);
  await b.act({ kind: 'request', scenario: 'WK-03' });
  assert.equal((await b.act({ kind: 'complete_task', taskId })).status, 200);
});

test('referee recovery requires measured same-version probes and revokes the stolen token', async t => {
  const s = await fixture(t), attacker = s.pick('red', 'scout');
  const a = actorTools(s.url, attacker);
  const leak = await a.act({ kind: 'request', scenario: 'WK-01' });
  await a.act({ kind: 'submit_flag', value: leak.body.artifact });
  assert.equal((await call(s.url, attacker.token, '/control/reclaim', { target: 'blue' })).status, 403);
  assert.equal((await call(s.url, s.refereeKey, '/control/reclaim', { target: 'blue' })).status, 400);
  await actorTools(s.url, s.pick('blue', 'policy')).act({ kind: 'write_rule', rule: 'tenant-isolation', version: 0, evidenceId: leak.body.eventId });
  const probe = await call(s.url, s.pick('red', 'probe').token, '/v1/blue/artifact');
  const normal = await call(s.url, s.pick('blue', 'client').token, '/v1/blue/status');
  const read = await call(s.url, s.pick('blue', 'client').token, '/v1/blue/artifact');
  const update = await call(s.url, s.pick('blue', 'client').token, '/v1/blue/update', { operation: 'heartbeat' });
  const reclaimed = await call(s.url, s.refereeKey, '/control/reclaim', { target: 'blue', attackEventId: probe.body.eventId, normalEventId: normal.body.eventId, readEventId: read.body.eventId, updateEventId: update.body.eventId });
  assert.equal(reclaimed.status, 200);
  assert.equal((await a.act({ kind: 'submit_flag', value: leak.body.artifact })).status, 400);
  const snapshot = await call(s.url, s.refereeKey, '/control/snapshot');
  assert.equal(snapshot.body.assets.find((asset: any) => asset.id === 'blue').controlledBy, 'blue');
});


test('ordered breach and remediation have repeatable HTTP outcomes in both modes', async () => {
  const { validateScenario } = await import('../src/validate.ts');
  for (const mode of ['baseline', 'hardened'] as const) {
    const first = await validateScenario(mode), second = await validateScenario(mode);
    assert.deepEqual(first.checks, second.checks);
  }
});
