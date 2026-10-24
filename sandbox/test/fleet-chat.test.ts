import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { testDatabase } from './spacetime-helper.ts';
import { startService } from '../src/service.ts';
const operator = 'operator-chat-test-000000000000000000000';
const attacker = 'attacker-chat-test-000000000000000000000';
const defender = 'defender-chat-test-000000000000000000000';
test('chat delegates real fleet actions, separates roles, persists evidence and cancels', { skip: !process.env.SPACETIME_BINARY }, async () => {
  const db = await testDatabase();
  const original = globalThis.fetch;
  let calls = 0;
  let refuseSpecialist = false;
  globalThis.fetch = async (input: any, init?: any) => {
    if (String(input) !== 'https://api-inference.bitdeer.ai/v1/chat/completions') return original(input, init);
    calls++;
    const body = JSON.parse(init.body), system = JSON.parse(body.messages[0].content), context = JSON.parse(body.messages[1].content);
    if (refuseSpecialist && !system.agents) return new Response(JSON.stringify({choices:[{message:{refusal:"test refusal"}}]}));
    let value;
    if (system.agents) value = { tasks: system.agents.slice(0,2).map((id:number,i:number) => ({agentId:id,target:i+1,objective:'Assess assigned drone'})) };
    else value = {kind:system.role === 'attacker' ? context.observation.discovered === false ? 'discover' : 'command' : context.observation.isolated ? 'verify' : 'isolate'};
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(value)}}]}));
  };
  const env = {...db.env, BITDEER_API_KEY:'test-only', BITDEER_MODEL:'test-contract-model', SUDOKO_ATTACKER_TOKEN:attacker, SUDOKO_DEFENDER_TOKEN:defender};
  let service = await startService({operatorToken:operator,env});
  const request = async (path:string, token:string, body?:any, key='test-key') => {
    const r=await original(service.url+path,{method:body === undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':key},body:body === undefined?undefined:JSON.stringify(body)});
    return {status:r.status,body:await r.json() as any};
  };
  try {
    await service.store.call('start_fleet',[4,2,2,false]);
    await service.store.call('enable_fleet_chat',[]);
    assert.equal((await request('/v1/chat/operations',operator,{message:'attack'})).status,403);
    assert.equal((await request('/v1/runs',attacker)).status,401);
    const op=await request('/v1/chat/operations',attacker,{message:'Look for vulnerabilities and take over the assigned swarm'});
    assert.equal(op.status,202);assert.equal(op.body.tasks.length,2);
    assert.equal((await request(`/v1/chat/operations/${op.body.id}`,defender)).status,404);
    const duplicate=await request('/v1/chat/operations',attacker,{message:op.body.message});
    assert.equal(duplicate.body.id,op.body.id);
    assert.equal((await request('/v1/chat/operations',attacker,{message:'different'})).status,409);
    const poll=async(id:string,token:string,predicate:(o:any)=>boolean) => {
      for(let i=0;i<100;i++){const r=await request(`/v1/chat/operations/${id}`,token);if(predicate(r.body))return r.body;await delay(50);}
      throw Error('Operation did not reach expected state');
    };
    const attacked=await poll(op.body.id,attacker,o=>o.results.filter((r:any)=>r.outcome==='unauthorized_command_accepted').length>=2);
    assert.ok(attacked.results.some((r:any)=>r.evidenceId>0));
    await request(`/v1/chat/operations/${op.body.id}/stop`,attacker,{});
    const stopCount=(await service.store.query('SELECT * FROM fleet_chat_action')).length;
    await delay(300);
    assert.equal((await service.store.query('SELECT * FROM fleet_chat_action')).length,stopCount);
    const defense=await request('/v1/chat/operations',defender,{message:'Contain affected drones and verify recovery'});
    assert.equal(defense.status,202);
    await poll(defense.body.id,defender,o=>o.results.filter((r:any)=>r.outcome==='recovery_verified').length>=2);
    await request(`/v1/chat/operations/${defense.body.id}/stop`,defender,{});
    const drones=await service.store.query('SELECT * FROM fleet_drone');
    assert.ok(drones.filter((d:any)=>d.id<=2).every((d:any)=>d.controller==='defender'&&d.isolated));
    await assert.rejects(service.store.call('execute_fleet_chat_action',[service.store.session,op.body.id,24,1,1,'command',0]));
    assert.ok(calls>=6);
    await service.close();
    service=await startService({operatorToken:operator,env});
    const saved=await request(`/v1/chat/operations/${op.body.id}`,attacker);
    assert.equal(saved.body.state,'cancelled');assert.ok(saved.body.results.length>0);
    refuseSpecialist=true;
    const before=(await service.store.query('SELECT * FROM fleet_chat_action')).length;
    const rejected=await request('/v1/chat/operations',attacker,{message:'Assess targets'},'refusal-test');
    assert.equal(rejected.status,202);
    const failed=await poll(rejected.body.id,attacker,o=>o.state==='failed');
    assert.ok(failed.results.every((r:any)=>r.error==='provider_refused'));
    assert.equal((await service.store.query('SELECT * FROM fleet_chat_action')).length,before);

  } finally {await service.close();globalThis.fetch=original;await db.close();}
});
