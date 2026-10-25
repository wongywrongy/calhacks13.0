import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium, type Browser } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { testDatabase } from "./spacetime-helper.ts";
import { RunStore } from "../src/run-store.ts";

// Fixture decisions through the production reservation/commit functions and real scheduled
// simulation reducers. The fixture endpoints are absent from the production module.
test("Maincloud durable mission loop (Fixture decisions, real SpacetimeDB)", { skip: !process.env.SPACETIME_BINARY, timeout: 180000 }, async t => {
  execFileSync("cargo", ["build", "--manifest-path", "arena-live/Cargo.toml", "--target", "wasm32-unknown-unknown", "--release", "--features", "mission-fixtures", "--target-dir", "arena-live/target/mission-fixtures"], {stdio:"pipe"});
  await build({stdin:{contents:await readFile("web/fleet.ts","utf8")+"\nObject.assign(globalThis,{auditViewport:()=>({pad:pad.scale.toArray(),epoch:fleetEpoch,count:frame.drones.length}),auditSelect:(id)=>pull(id),auditDisconnect:()=>close(),auditSuggestionTick:()=>render({...frame,teams:[...(frame.teams??[]),{role:\"defender\",operation:\"\",objective:\"\",targets:[],stage:\"observing\",summary:\"Fixture unrelated update\",active_agents:0}]})});",resolveDir:process.cwd()+"/web",loader:"ts"},bundle:true,format:"esm",outfile:"output/mission-loop/fleet.js"});
  const db = await testDatabase("arena-live/target/mission-fixtures/wasm32-unknown-unknown/release/sudoko_live.wasm");
  const owner = new RunStore({uri:db.env.SPACETIME_URI, database:db.env.SPACETIME_DATABASE, token:db.env.SPACETIME_TOKEN});
  const timings: {queueReceiptToResolvedMs:number}[] = [];
  const rows = async (table:string):Promise<any[]> => {
    const all=await owner.query("SELECT * FROM " + table);
    if(["battle_attempt","fleet_evidence"].includes(table)){const [s]=await owner.query("SELECT * FROM fleet_session");return all.filter((r:any)=>r.epoch===s?.epoch);}
    return all;
  };
  const call = (name:string,args:unknown[]) => owner.call(name,args);
  const identity:any = await fetch(db.env.SPACETIME_URI+"/v1/identity",{method:"POST"}).then(r=>r.json());
  const viewer = new RunStore({uri:db.env.SPACETIME_URI,database:db.env.SPACETIME_DATABASE,token:identity.token});
  const reserve = (id:string) => call("fixture_hosted_reserve",[id]);
  const reply = (id:string,value:any,error="") => call("fixture_hosted_reply",[id,JSON.stringify(value),error]);
  const job = async (id:string) => (await rows("hosted_job")).find(j=>j.id===id);
  const operation = async (id:string) => {const op=(await viewer.query("SELECT * FROM visible_chat_operations")).find((r:any)=>r.id===id); return {...op,config:JSON.parse(op.config),results:JSON.parse(op.result)};};
  const context = (j:any) => JSON.parse(JSON.parse(j.request).messages[1].content);
  const latest = async (id:string,agent:number) => (await rows("hosted_job")).filter(j=>j.operation===id&&j.agent===agent).sort((a,b)=>b.step-a.step)[0];
  const wait = async (check:()=>Promise<any>,ms=10000) => {const until=Date.now()+ms;while(Date.now()<until){const result=await check();if(result)return result;await delay(60)}assert.fail("Mission fixture timed out");};
  const resolve = async (j:any) => {await wait(async()=> (await rows("battle_attempt")).find(a=>a.key===j.id&&a.stage==="resolved"));await reserve(j.id);return (await operation(j.operation)).results.find((r:any)=>r.actionId===j.id);};
  const decide = async (j:any,kind:string,extra:any={}) => {
    await reserve(j.id);const claimed=await job(j.id);assert.equal(claimed.state,"running");
    const input=context(claimed);
    const decision={kind,target:claimed.target,recipientAgentId:0,explanation:`Fixture: choose ${kind} from current observations.`,evidenceIds:input.evidence.slice(0,1).map((e:any)=>e.id),...extra};
    await reply(j.id,decision);return decision;
  };
  const reset = async (seed=4) => {await call("start_fleet",[32,0,0,false]);await call("enable_fleet_chat",[]);await call("set_battle_seed",[seed]);const s=(await viewer.query("SELECT * FROM visible_fleet_session"))[0];await viewer.call("new_maincloud_chat",[s.epoch,s.conversation]);};
  const start = async (targets=[8,10],goal="capture",scopes=targets.map(n=>[n])) => {
    const session=(await viewer.query("SELECT * FROM visible_fleet_session"))[0], key=randomUUID();
    await viewer.call("send_maincloud_message",[key,"Run a bounded synthetic mission",0,session.epoch,session.conversation]);
    await viewer.call("send_maincloud_message",[key,"Run a bounded synthetic mission",0,session.epoch,session.conversation]);
    const turn=(await rows("backend_chat_turn")).find(t=>t.request_key.endsWith(key));
    await reserve(turn.id);
    const plan={intent:"deploy",answer:"Test entry on the assigned synthetic targets; verify control through simulator evidence.",evidenceIds:[],tasks:targets.map((target,i)=>({name:`Specialist ${i+1}`,specialty:"entry",target,targets:scopes[i],objective:"Verify the typed assignment objective",goal}))};
    await reply(turn.id,plan);
    const op=(await rows("backend_chat")).find(o=>JSON.parse(o.config).turnId===turn.id);
    return operation(op.id);
  };
  try {
    await call("grant_fleet_view",[identity.identity,"attacker"]);
    await t.test("read-only and ambiguous requests admit zero tasks; changed objectives cancel old assignments",async()=>{
      await reset();
      const send=async(message:string)=>{const session=(await viewer.query("SELECT * FROM visible_fleet_session"))[0],key=randomUUID();await viewer.call("send_maincloud_message",[key,message,0,session.epoch,session.conversation]);const turn=(await rows("backend_chat_turn")).find(t=>t.request_key.endsWith(key));await reserve(turn.id);return turn;};
      for(const intent of ["answer","clarify"]){
        const turn=await send(intent==="answer"?"What is this simulation?":"That drone, which one?");
        const request=JSON.parse((await job(turn.id)).request);assert.equal(request.response_format.json_schema.schema.properties.tasks.minItems,0);
        await assert.rejects(reply(turn.id,{intent,answer:intent,evidenceIds:[],tasks:[]}),"Routing labels cannot substitute for an operator-facing reply");
        await reply(turn.id,{intent,answer:"Fixture: a short read-only response or clarification.",evidenceIds:[],tasks:[]});
        assert.equal((await rows("backend_chat_turn")).find(t=>t.id===turn.id).state,"completed");assert.equal((await rows("fleet_agent")).length,0);
      }
      const pendingTurn=await send("Explain the fleet");
      const session=(await viewer.query("SELECT * FROM visible_fleet_session"))[0],requestKey=pendingTurn.request_key.split(":").at(-1);
      await assert.rejects(viewer.call("send_maincloud_message",[requestKey,"Conflicting retry",0,session.epoch,session.conversation]));
      assert.equal(JSON.parse((await rows("backend_chat_turn")).find(t=>t.id===pendingTurn.id).config).message,"Explain the fleet");
      await viewer.call("send_maincloud_message",[randomUUID(),"Stop.",0,session.epoch,session.conversation]);
      assert.equal((await rows("backend_chat_turn")).find(t=>t.id===pendingTurn.id).state,"cancelled");
      await assert.rejects(reply(pendingTurn.id,{intent:"answer",answer:"Late fixture reply",evidenceIds:[],tasks:[]}));
      const op=await start();const old=await latest(op.id,op.config.tasks[0].agentId);await reserve(old.id);const pending=await latest(op.id,op.config.tasks[0].agentId);await reserve(pending.id);
      const turn=await send("Change the objective to discovering drones 1 and 2");
      await reply(turn.id,{intent:"replace",answer:"Fixture: revised discovery objective.",evidenceIds:[],tasks:[1,2].map(target=>({name:`Scout ${target}`,specialty:"recon",target,targets:[target],objective:"Verify discovery",goal:"recon"}))});
      assert.equal((await operation(op.id)).state,"cancelled");
      await assert.rejects(reply(pending.id,{kind:"command",target:pending.target,recipientAgentId:0,explanation:"Fixture late cancelled choice.",evidenceIds:[]}));
      assert.equal((await rows("battle_attempt")).length,0);
      assert.ok((await viewer.query("SELECT * FROM visible_chat_operations")).some((r:any)=>r.id!==op.id&&r.state==="running"));
    });
    await t.test("selected single target admits one useful specialist and role-visible evidence without allowing duplicate assignments",async()=>{
      await reset();const recon=await start([1,2],"recon");for(const a of recon.config.tasks)await reserve((await latest(recon.id,a.agentId)).id);
      const session=(await viewer.query("SELECT * FROM visible_fleet_session"))[0],key=randomUUID();
      await viewer.call("send_maincloud_message",[key,"Attempt entry on DR-001",1,session.epoch,session.conversation]);
      const turn=(await rows("backend_chat_turn")).find(t=>t.request_key.endsWith(key));await reserve(turn.id);const input=context(await job(turn.id));
      assert.ok(input.evidence.some((e:any)=>e.target===2),"Coordinator retains role-visible evidence while selecting one action target");
      const task={name:"Entry 1",specialty:"capture",target:1,targets:[1],objective:"Attempt entry on DR-001",goal:"capture"};
      const plan={intent:"deploy",answer:"Fixture: one useful entry assignment for the selected target.",evidenceIds:input.evidence.map((e:any)=>e.id),tasks:[task]};
      await assert.rejects(reply(turn.id,{...plan,tasks:[]}));
      await assert.rejects(reply(turn.id,{...plan,tasks:[task,{...task,name:"Duplicate"}]}));
      await assert.rejects(reply(turn.id,{...plan,tasks:[{...task,target:2,targets:[2]}]}));
      await assert.rejects(reply(turn.id,{...plan,evidenceIds:[999999]}));
      await reply(turn.id,plan);const raw=(await rows("backend_chat")).find(o=>JSON.parse(o.config).turnId===turn.id),op=await operation(raw.id);
      assert.equal(op.config.tasks.length,1);assert.equal(op.config.tasks[0].target,1);assert.equal(op.config.tasks[0].goal,"capture");
      assert.equal((await rows("hosted_budget")).find(b=>b.operation===op.id).calls,1);
      const worker=await latest(op.id,op.config.tasks[0].agentId);await decide(worker,"command");await resolve(worker);
      assert.ok((await operation(op.id)).results.some((r:any)=>r.kind==="command"&&r.status==="executed"));
    });
    await t.test("blocked attempt resumes, choices adapt to evidence, result replay is idempotent, terminal roster clears",async()=>{
      await reset();const op=await start(), [a,b]=op.config.tasks;
      for(const agent of [a,b])await reserve((await latest(op.id,agent.agentId)).id); // required discovery is bookkeeping
      assert.equal((await rows("hosted_budget")).find(b=>b.operation===op.id).calls,1,"Discovery makes no provider calls");
      const j=await latest(op.id,a.agentId);await decide(j,"command");
      const pending=await job(j.id);await db.restart();assert.deepEqual(await job(j.id),pending,"Active attempt state survives database restart");
      const before=(await rows("fleet_drone")).find(d=>d.id===8).tick;
      const resisted=await resolve(j);assert.equal(resisted.simulation.succeeded,0);assert.equal(resisted.simulation.partial,0);
      assert.equal((await operation(op.id)).state,"running");
      const next=await latest(op.id,a.agentId);await reserve(next.id);
      const input=context(await job(next.id));assert.ok(input.memory.some((r:any)=>r.actionId===j.id&&r.simulation.succeeded===0));
      assert.ok(input.options.actions.includes("prepare")&&!input.options.actions.includes("command"));
      assert.ok(input.teammates.some((t:any)=>t.assignment.agentId===b.agentId));
      const choice={kind:"prepare",target:8,recipientAgentId:0,explanation:"Fixture: resisted entry requires preparation before retrying.",evidenceIds:input.evidence.map((e:any)=>e.id).slice(0,1)};
      await reply(next.id,choice);await reply(next.id,choice); // reconnect/retry cannot queue a second attempt
      assert.equal((await rows("battle_attempt")).filter(a=>a.key===next.id).length,1);
      const prepared=await resolve(next);
      const reassess=await latest(op.id,a.agentId);await reserve(reassess.id);
      const afterPreparation=context(await job(reassess.id));
      assert.ok(afterPreparation.evidence.some((e:any)=>e.id===prepared.evidenceId),"Own preparation evidence remains visible and citable after adaptation");
      await reply(reassess.id,{kind:"wait",target:8,recipientAgentId:0,explanation:"Fixture: cite the measured preparation before reassessment.",evidenceIds:[prepared.evidenceId]});
      const tick=(await rows("fleet_drone")).find(d=>d.id===8).tick;assert.ok(tick>before,"Movement continues while jobs await results");
      // Drive remaining choices from eligibility, never from a prewritten success sequence.
      for(let round=0;round<18;round++){
        const current=await operation(op.id);if(current.state!=="running")break;
        for(const task of current.config.tasks){
          const j=await latest(op.id,task.agentId);if(!["queued","waiting","attempt"].includes(j.state))continue;
          if(j.state==="attempt"){await resolve(j);continue;}
          await reserve(j.id);const saved=await job(j.id);if(saved.state!=="running")continue;
          const c=context(saved),kind=["command","prepare"].find(k=>c.options.actions.includes(k))??"finish";
          await reply(j.id,{kind,target:saved.target,recipientAgentId:0,explanation:"Fixture: use the currently eligible action after the measured result.",evidenceIds:c.evidence.slice(0,1).map((e:any)=>e.id)});
        }
        const replan=(await rows("hosted_job")).find(j=>j.operation===op.id&&j.agent===0&&j.state==="queued");
        if(replan){await reserve(replan.id);await reply(replan.id,{assignments:[],explanation:"Fixture: no further useful route in this bounded mission.",evidenceIds:[]});}
      }
      const done=await operation(op.id);assert.notEqual(done.state,"running");assert.ok(done.results.some((r:any)=>r.type==="mission"));
      const tasks=await viewer.query("SELECT * FROM visible_agent_tasks");assert.ok(tasks.every((t:any)=>!["queued","running","observing","deciding","executing","waiting"].includes(t.state)));
      assert.equal((await viewer.query("SELECT * FROM visible_team_activity"))[0].active_agents,0);
      assert.ok(done.results.filter((r:any)=>r.type==="inference").every((r:any)=>r.source==="Fixture decisions"));
      assert.ok((await rows("hosted_budget")).every(b=>b.calls<=33));assert.ok((await rows("hosted_job")).filter(j=>j.agent>0).every(j=>j.step<=8));
    });
    await t.test("wait schedules a real pause, resumes fresh observation and bounds unchanged waits",async()=>{
      await reset();const op=await start();const a=op.config.tasks[0];await reserve((await latest(op.id,a.agentId)).id);
      for(let count=0;count<3;count++){
        const j=await latest(op.id,a.agentId);await decide(j,"wait");
        const n=await latest(op.id,a.agentId);
        if(count<2){assert.equal(n.state,"waiting");const visible=await viewer.query("SELECT * FROM visible_agent_tasks");assert.equal(visible.find((t:any)=>t.agent===a.agentId).state,"waiting");const calls=(await rows("hosted_budget")).find(b=>b.operation===op.id).calls;await reserve(n.id);assert.equal((await job(n.id)).state,"waiting");assert.equal((await rows("hosted_budget")).find(b=>b.operation===op.id).calls,calls);await delay(1550);}
      }
      const current=await operation(op.id);assert.equal(current.results.filter((r:any)=>r.type==="worker"&&r.agentId===a.agentId).at(-1).state,"blocked");
      assert.equal(current.state,"running","Teammate's assignment is independent");
    });
    await t.test("retarget and evidence handoff enforce scopes, roles, current ownership and sequence",async()=>{
      await reset();const op=await start([8,10],"capture",[[8,9,10],[8,10]]),[a,b]=op.config.tasks;
      await reserve((await latest(op.id,a.agentId)).id);let j=await latest(op.id,a.agentId);await reserve(j.id);let c=context(await job(j.id));
      const value={kind:"retarget",target:10,recipientAgentId:0,explanation:"Fixture: use another allowed target.",evidenceIds:[c.evidence[0].id]};
      await assert.rejects(reply(j.id,value),"Cannot steal active teammate target");
      await assert.rejects(reply(j.id,{...value,target:31}),"Cannot leave coordinator scope");
      await assert.rejects(reply(j.id,{...value,target:9,evidenceIds:[999999]}),"Cannot invent evidence");
      await reply(j.id,{...value,kind:"handoff",target:8,recipientAgentId:b.agentId});
      assert.ok((await operation(op.id)).results.some((r:any)=>r.type==="handoff"&&r.recipientAgentId===b.agentId));
      j=await latest(op.id,a.agentId);await decide(j,"retarget",{target:9});
      assert.deepEqual((await operation(op.id)).config.completionConditions,op.config.completionConditions);assert.equal((await operation(op.id)).config.tasks[0].target,9);assert.equal((await operation(op.id)).config.tasks[0].goal,"capture");assert.match((await operation(op.id)).config.tasks[0].objective,/DR-009/);
      assert.equal((await latest(op.id,a.agentId)).target,9);assert.equal((await rows("fleet_agent")).length,2);
      await assert.rejects(viewer.call("fixture_hosted_reserve",[j.id]),"Viewer cannot invoke fixture authority");
    });
    await t.test("bounded replanning reuses identities, deadline and cumulative call reservations",async()=>{
      await reset();const op=await start([8,10],"capture",[[8,9],[10,11]]);
      for(const a of op.config.tasks){await reserve((await latest(op.id,a.agentId)).id);await decide(await latest(op.id,a.agentId),"help");}
      const replan=(await rows("hosted_job")).find(j=>j.operation===op.id&&j.agent===0);assert.ok(replan);
      const before=(await rows("hosted_budget")).find(b=>b.operation===op.id).calls;
      await reserve(replan.id);
      const changes={assignments:op.config.tasks.map((a:any,i:number)=>({agentId:a.agentId,target:[9,11][i]})),explanation:"Fixture: blocked specialists should inspect their allowed alternative routes.",evidenceIds:[]};
      await reply(replan.id,changes);
      const revised=await operation(op.id);assert.deepEqual(revised.config.completionConditions,op.config.completionConditions);assert.equal(revised.config.deadline,op.config.deadline);assert.deepEqual(revised.config.tasks.map((a:any)=>a.agentId),op.config.tasks.map((a:any)=>a.agentId));
      assert.equal((await rows("hosted_budget")).find(b=>b.operation===op.id).calls,before+1);
      assert.ok((await rows("hosted_job")).filter(j=>j.operation===op.id&&j.agent>0&&j.state==="queued").every(j=>j.step===3&&j.deadline===op.config.deadline));
    });
    await t.test("coordinator refusal ends replanning without a retry or fixture substitution",async()=>{
      await reset();const op=await start();
      for(const a of op.config.tasks){await reserve((await latest(op.id,a.agentId)).id);await decide(await latest(op.id,a.agentId),"help");}
      const replan=(await rows("hosted_job")).find(j=>j.operation===op.id&&j.agent===0);await reserve(replan.id);await reply(replan.id,{},"provider_refused");
      assert.equal((await operation(op.id)).state,"failed");assert.equal((await rows("hosted_job")).filter(j=>j.operation===op.id&&j.agent===0).length,1);
      assert.equal((await rows("battle_attempt")).length,0);
    });
    await t.test("verified objectives close assignments and persist their server-checked conditions",async()=>{
      await reset(2);const op=await start([1,18]);
      for(const a of op.config.tasks){await reserve((await latest(op.id,a.agentId)).id);const j=await latest(op.id,a.agentId);await decide(j,"command");const queuedAt=Date.now();const r=await resolve(j);timings.push({queueReceiptToResolvedMs:Date.now()-queuedAt});assert.equal(r.simulation.succeeded,1);}
      const done=await operation(op.id);assert.equal(done.state,"completed");
      const result=done.results.find((r:any)=>r.type==="mission");assert.equal(result.outcome,"verified_success");assert.ok(result.conditions.every((c:any)=>c.verified&&c.goal==="capture"));
      assert.equal((await viewer.query("SELECT * FROM visible_team_activity"))[0].active_agents,0);
      assert.ok((await rows("backend_chat_message")).some(m=>m.operation===op.id&&m.key.endsWith(":terminal")&&/2 of 2 objectives verified/.test(m.text)));
    });
    await t.test("global concurrency, exhaustion and deadline remain bounded across scheduler transitions",async()=>{
      await reset();const op=await start([1,2,3,4]);
      for(const a of op.config.tasks){await reserve((await latest(op.id,a.agentId)).id);await reserve((await latest(op.id,a.agentId)).id);}
      assert.equal((await rows("hosted_job")).filter(j=>j.state==="running").length,4);
      const defender:any=await fetch(db.env.SPACETIME_URI+"/v1/identity",{method:"POST"}).then(r=>r.json());await call("grant_fleet_view",[defender.identity,"defender"]);
      const other=new RunStore({uri:db.env.SPACETIME_URI,database:db.env.SPACETIME_DATABASE,token:defender.token});
      const session=(await other.query("SELECT * FROM visible_fleet_session"))[0];const key=randomUUID();await other.call("send_maincloud_message",[key,"Explain the current evidence",0,session.epoch,session.conversation]);
      const turn=(await rows("backend_chat_turn")).find(t=>t.request_key.endsWith(key));await reserve(turn.id);assert.equal((await job(turn.id)).state,"queued");assert.equal((await rows("backend_chat_turn")).find(t=>t.id===turn.id).state,"queued","No deciding status while waiting for an inference slot");
      const first=await latest(op.id,op.config.tasks[0].agentId);await reply(first.id,{},"provider_timeout");await reserve(turn.id);assert.equal((await job(turn.id)).state,"running");
      assert.equal((await rows("hosted_job")).filter(j=>j.state==="running").length,4);
      await reply(turn.id,{intent:"answer",answer:"Fixture: no additional agents were deployed.",evidenceIds:[],tasks:[]});
      for(const a of op.config.tasks.slice(1))await reply((await latest(op.id,a.agentId)).id,{},"provider_timeout");
      await reset();const bounded=await start();await call("fixture_hosted_limits",[bounded.id,33,10000]);
      for(const a of bounded.config.tasks){await reserve((await latest(bounded.id,a.agentId)).id);await reserve((await latest(bounded.id,a.agentId)).id);}
      assert.equal((await operation(bounded.id)).state,"exhausted");assert.equal((await rows("hosted_budget")).find(b=>b.operation===bounded.id).calls,33);
      await reset();const expiring=await start();await call("fixture_hosted_limits",[expiring.id,1,600]);
      const done=await wait(async()=>{const op=await operation(expiring.id);return op.state!=="running"&&op;});
      assert.equal(done.state,"exhausted");assert.equal(done.results.find((r:any)=>r.type==="mission").outcome,"deadline_exhausted");
    });
    await t.test("provider failure is execution failure, not an attack result; reconnect preserves jobs without duplicate effects",async()=>{
      await reset();const op=await start();
      for(const a of op.config.tasks){await reserve((await latest(op.id,a.agentId)).id);const j=await latest(op.id,a.agentId);await reserve(j.id);await reply(j.id,{},"provider_rate_limit: HTTP 429");}
      const done=await operation(op.id);assert.equal(done.state,"failed");assert.equal(done.results.find((r:any)=>r.type==="mission").outcome,"execution_failure");
      assert.equal((await rows("battle_attempt")).length,0);assert.ok(done.results.filter((r:any)=>r.type==="inference"&&r.stage==="specialist").every((r:any)=>r.status==="failed"));
      const saved=await rows("hosted_job");await db.restart();assert.deepEqual((await rows("hosted_job")).sort((a,b)=>a.id.localeCompare(b.id)),saved.sort((a,b)=>a.id.localeCompare(b.id)));
      assert.deepEqual((await operation(op.id)).results,done.results);
      const session=(await viewer.query("SELECT * FROM visible_fleet_session"))[0],key=randomUUID();
      await viewer.call("send_maincloud_message",[key,"Explain current evidence",0,session.epoch,session.conversation]);
      const turn=(await rows("backend_chat_turn")).find(t=>t.request_key.endsWith(key));await reserve(turn.id);await reply(turn.id,{},"provider_malformed_output");
      assert.equal((await viewer.query("SELECT * FROM visible_team_activity"))[0].stage,"execution_failure");

    });
    await t.test("existing Maincloud UI shows durable acknowledgment, verified summary and removes terminal cards",async()=>{
      await reset();await call("start_fleet",[200,0,0,false]);await call("enable_fleet_chat",[]);
      const defender:any=await fetch(db.env.SPACETIME_URI+"/v1/identity",{method:"POST"}).then(r=>r.json());await call("grant_fleet_view",[defender.identity,"defender"]);
      const observer:any=await fetch(db.env.SPACETIME_URI+"/v1/identity",{method:"POST"}).then(r=>r.json());await call("grant_fleet_view",[observer.identity,"observer"]);
      const config={maincloud:true,uri:db.env.SPACETIME_URI,database:db.env.SPACETIME_DATABASE,sandbox:db.env.SPACETIME_DATABASE,authenticated:true,chat:true,demo:true,switchableRoles:["attacker","defender","observer"],engine:"mocked",workspaces:{attacker:{token:identity.token},defender:{token:defender.token},observer:{token:observer.token}},models:{coordinator:"Fixture decisions",specialist:"Fixture decisions"}};
      const files:Record<string,[string,string]>={"/":["web/fleet.html","text/html"],"/theme.css":["web/theme.css","text/css"],"/fleet.js":["output/mission-loop/fleet.js","text/javascript"],"/assets/swarm-blockout.glb":["web/assets/swarm-blockout.glb","model/gltf-binary"],"/assets/environments/sudoko-dusk-basin.webp":["web/assets/environments/sudoko-dusk-basin.webp","image/webp"]};
      const server=createServer((request,response)=>{void(async()=>{
        const path=new URL(request.url!,"http://localhost").pathname;
        if(path==="/fleet-config"){response.setHeader("content-type","application/json");response.end(JSON.stringify(config));return;}
        const file=files[path];if(!file){response.writeHead(404).end();return;}response.setHeader("content-type",file[1]);response.end(await readFile(file[0]));
      })().catch(()=>response.writeHead(500).end());});
      await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
      let browser:Browser|undefined;
      try{
        browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,headless:true,args:["--no-sandbox","--enable-unsafe-swiftshader"]});
        const page=await browser.newPage({viewport:{width:1366,height:768}}),errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
        const sockets=new Set<any>();page.on("websocket",socket=>{sockets.add(socket);socket.on("close",()=>sockets.delete(socket));});
        await page.addInitScript(()=>sessionStorage.setItem("sudoko.role","attacker"));await page.goto(`http://127.0.0.1:${(server.address() as any).port}`);
        await page.waitForFunction(()=>document.querySelector("#live")?.textContent?.startsWith("Live"));
        const suggestion=page.getByRole("button",{name:/Discover two catalog drones/});await suggestion.waitFor();
        const heldSuggestion=await suggestion.elementHandle(),point=await suggestion.boundingBox();assert.ok(point);
        await page.mouse.move(point.x+point.width/2,point.y+point.height/2);await page.mouse.down();
        await page.evaluate(()=> (globalThis as any).auditSuggestionTick());
        await page.mouse.up();assert.ok(await heldSuggestion!.evaluate(node=>node.isConnected),"Unrelated live updates must preserve the pressed suggestion button");
        const turn=await wait(async()=>(await rows("backend_chat_turn")).find(t=>JSON.parse(t.config).message==="Discover two catalog drones"));
        await page.waitForFunction(()=>Array.from(document.querySelectorAll<HTMLButtonElement>("#suggest button")).every(b=>b.disabled));
        await page.locator("#say").fill("Explain another question while the first request is pending");await page.getByRole("button",{name:"Send",exact:true}).click();
        await page.waitForFunction(()=>document.querySelector("#error")?.textContent?.includes("pending"));
        await page.waitForTimeout(600);assert.match(await page.locator("#error").innerText(),/pending/);

        await reserve(turn.id);await reply(turn.id,{intent:"deploy",answer:"Discover the two assigned synthetic catalog targets.",evidenceIds:[],tasks:[8,10].map((target,i)=>({name:`Observer ${i+1}`,specialty:"recon",target,targets:[target],objective:"Verify catalog discovery",goal:"recon"}))});
        const op=(await rows("backend_chat")).find(o=>JSON.parse(o.config).turnId===turn.id),plan=await operation(op.id);
        await page.waitForFunction(()=>document.querySelectorAll("#agents .agent").length===2);
        await reserve((await latest(op.id,plan.config.tasks[0].agentId)).id);
        await page.waitForFunction(()=> (globalThis as any).auditViewport().count>0);
        await page.evaluate(()=> (globalThis as any).auditSelect(8));
        await page.waitForFunction(()=>!document.querySelector<HTMLButtonElement>("#suggest button")?.disabled&&document.querySelector("#suggest button")?.textContent?.includes("Explain the current operation"));
        await page.locator("#say").fill("");await page.locator("#say").press("Tab");
        assert.equal(await page.locator("#say").inputValue(),"Explain the current operation");await page.locator("#say").press("Enter");
        const followup=await wait(async()=>(await rows("backend_chat_turn")).find(t=>JSON.parse(t.config).message==="Explain the current operation"));
        assert.equal(JSON.parse(followup.config).target,null,"Tab acceptance preserves the suggestion's broad scope instead of the selected drone");
        await reserve(followup.id);await reply(followup.id,{intent:"answer",answer:"Fixture: one recon assignment remains active.",evidenceIds:[],tasks:[]});
        await reserve((await latest(op.id,plan.config.tasks[1].agentId)).id);
        const persistedAt=Date.now();
        await page.waitForFunction(()=>document.querySelectorAll("#agents .agent").length===0);
        await page.waitForFunction(id=>/2 of 2 objectives verified/.test(document.querySelector(`[data-turn-id="${id}"]`)?.textContent??""),turn.id);
        const persistedToVisibleMs=Date.now()-persistedAt;
        assert.match(await page.locator(`[data-turn-id="${turn.id}"]`).innerText(),/Discover the two assigned synthetic catalog targets/);
        await page.locator("#say").fill("Explain the fleet before cancellation");await page.getByRole("button",{name:"Send",exact:true}).click();
        const cancelledTurn=await wait(async()=>(await rows("backend_chat_turn")).find(t=>JSON.parse(t.config).message==="Explain the fleet before cancellation"));
        await reserve(cancelledTurn.id);
        await page.locator("#say").fill("Stop.");await page.getByRole("button",{name:"Send",exact:true}).click();
        await wait(async()=>(await rows("backend_chat_turn")).find(t=>t.id===cancelledTurn.id)?.state==="cancelled");
        await assert.rejects(reply(cancelledTurn.id,{intent:"answer",answer:"Late fixture reply",evidenceIds:[],tasks:[]}));
        await reply(cancelledTurn.id,{},"provider_timeout");
        await page.waitForFunction(()=>document.querySelector("#transcript")?.textContent?.includes("Stopped your pending work"));
        const receiptCount=(await rows("fleet_chat_action")).length;await page.reload();
        await page.waitForFunction(id=>/2 of 2 objectives verified/.test(document.querySelector(`[data-turn-id="${id}"]`)?.textContent??""),turn.id);
        assert.equal((await rows("fleet_chat_action")).length,receiptCount);assert.equal(await page.locator("#agents .agent").count(),0);
        await page.locator('nav [data-role="defender"]').click();await page.waitForFunction(()=>document.body.dataset.role==="defender"&&document.querySelector("#live")?.textContent?.startsWith("Live"));
        await page.waitForFunction(()=> (globalThis as any).auditViewport().count===200);
        const viewportBefore=await page.evaluate(()=> (globalThis as any).auditViewport());
        const cdp=await page.context().newCDPSession(page);await cdp.send("HeapProfiler.collectGarbage");const heapBefore=await cdp.send("Runtime.getHeapUsage");
        const currentSession=(await rows("fleet_session"))[0];
        await page.locator("#menu-btn").click();await page.locator("#reset-swarm").click();
        await page.waitForFunction(()=>document.querySelector("#reset-status")?.textContent?.includes("Conversations preserved"));
        assert.ok((await rows("fleet_session"))[0].epoch>currentSession.epoch);assert.equal((await rows("fleet_session"))[0].drones,200);
        await page.waitForFunction(()=> (globalThis as any).auditViewport().count===200);
        assert.deepEqual((await page.evaluate(()=> (globalThis as any).auditViewport())).pad,viewportBefore.pad);
        for(let repetition=0;repetition<2;repetition++){
          await page.locator("#menu-btn").click();await page.locator("#reset-swarm").click();await page.waitForFunction(()=>document.querySelector("#reset-status")?.textContent?.includes("Conversations preserved"));
          await page.waitForFunction(()=> (globalThis as any).auditViewport().count===200);
          assert.deepEqual((await page.evaluate(()=> (globalThis as any).auditViewport())).pad,viewportBefore.pad);
        }
        await wait(async()=>sockets.size===2);await cdp.send("HeapProfiler.collectGarbage");const heapAfter=await cdp.send("Runtime.getHeapUsage");
        await mkdir("output/audit-20261025",{recursive:true});await writeFile("output/audit-20261025/local-browser.json",JSON.stringify({scope:"Actual Chromium, actual local SpacetimeDB, fixture decisions, 200 drones",resets:3,activeSockets:sockets.size,pad:viewportBefore.pad,heapBefore,heapAfter,timings:{simulation:timings,persistedToVisibleMs,method:"Fixture decisions, real database: action queue receipt to observed resolution; recon persistence receipt to visible terminal summary. Includes HTTP/polling overhead; not GPU render time."}},null,2));
        await page.locator('nav [data-role="observer"]').click();
        await page.waitForFunction(()=>document.body.dataset.role==="observer"&&document.querySelector("#live")?.textContent?.startsWith("Live"));
        await page.waitForFunction(()=>document.querySelector("#assessment")?.textContent?.includes("0 / 200"));
        assert.equal(await page.locator("#compose").isVisible(),false);assert.equal(await page.locator("#reset-swarm").isVisible(),false);
        assert.match(await page.locator("#assessment").innerText(),/200 untested; security unknown/);
        await page.screenshot({path:"output/mission-loop/observer.png"});
        await page.route("**/fleet-config*",async route=>{await delay(1800);await route.continue();});
        await page.evaluate(()=> (globalThis as any).auditDisconnect());
        await page.waitForFunction(()=>document.querySelector("#live")?.textContent!=="Live");
        await page.waitForTimeout(2000);
        assert.equal((await page.evaluate(()=> (globalThis as any).auditViewport())).count,200,"Reconnect must retain the last fleet snapshot while configuration is delayed");
        assert.match(await page.locator("#assessment").innerText(),/Disconnected · last known records/);
        await page.waitForFunction(()=>document.querySelector("#live")?.textContent==="Live");
        assert.equal((await page.evaluate(()=> (globalThis as any).auditViewport())).count,200,"Live requires the hydrated subscription snapshot");
        await page.unroute("**/fleet-config*");

        await page.locator('nav [data-role="attacker"]').click();await page.waitForFunction(id=>/2 of 2 objectives verified/.test(document.querySelector(`[data-turn-id="${id}"]`)?.textContent??""),turn.id);
        await page.reload();await page.waitForFunction(id=>/2 of 2 objectives verified/.test(document.querySelector(`[data-turn-id="${id}"]`)?.textContent??""),turn.id);
        page.once("dialog",dialog=>void dialog.accept());await page.locator("#menu-btn").click();await page.locator("#reset-sandbox").click();
        await page.waitForFunction(()=>document.querySelector("#reset-status")?.textContent?.includes("Both chats are fresh"));
        assert.equal(await page.locator(`[data-turn-id="${turn.id}"]`).count(),0);
        await mkdir("output/mission-loop",{recursive:true});await page.screenshot({path:"output/mission-loop/desktop.png"});
        await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.ok(await page.locator("#filter button").evaluateAll(buttons=>buttons.every(b=>b.scrollWidth<=b.clientWidth)),"Narrow Activity controls must not overlap their labels");await page.screenshot({path:"output/mission-loop/mobile.png"});assert.deepEqual(errors,[]);
      }finally{await browser?.close();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
    });
    await t.test("cancellation and reset fence late inference and pending attempt resolution",async()=>{
      await reset();let op=await start(),a=op.config.tasks[0];await reserve((await latest(op.id,a.agentId)).id);let j=await latest(op.id,a.agentId);await decide(j,"command");
      const session=(await viewer.query("SELECT * FROM visible_fleet_session"))[0];await viewer.call("send_maincloud_message",[randomUUID(),"Stop.",0,session.epoch,session.conversation]);
      await delay(4500);assert.equal((await rows("fleet_drone")).find(d=>d.id===8).controller,"defender");assert.equal((await operation(op.id)).state,"cancelled");assert.equal((await operation(op.id)).results.findLast((r:any)=>r.type==="mission").outcome,"cancellation");
      await reset();op=await start();a=op.config.tasks[0];await reserve((await latest(op.id,a.agentId)).id);j=await latest(op.id,a.agentId);await reserve(j.id);const c=context(await job(j.id));
      const old=(await viewer.query("SELECT * FROM visible_fleet_session"))[0];await call("start_fleet",[32,0,0,false]);
      await assert.rejects(reply(j.id,{kind:"command",target:8,recipientAgentId:0,explanation:"Fixture late reply.",evidenceIds:c.evidence.map((e:any)=>e.id)}));
      assert.ok((await owner.query("SELECT * FROM hosted_record")).filter((r:any)=>r.operation===op.id).map((r:any)=>JSON.parse(r.body)).some((r:any)=>r.type==="mission"&&r.outcome==="cancellation"));
      assert.ok((await owner.query("SELECT * FROM hosted_assignment")).filter((a:any)=>a.operation===op.id).every((a:any)=>a.state==="cancelled"));
      assert.ok((await viewer.query("SELECT * FROM visible_chat_operations")).every((r:any)=>!["planning","running"].includes(r.state)),"Retained conversation contains only terminal old missions");
      assert.equal((await rows("fleet_agent")).length,0);assert.equal((await rows("battle_attempt")).length,0);
      await assert.rejects(viewer.call("send_maincloud_message",[randomUUID(),"stale",0,old.epoch,old.conversation]));
    });
    await t.test("new chat cancels reserved inference without resetting fleet or allowing late replies",async()=>{
      await reset();const op=await start([1],"capture"),task=op.config.tasks[0];
      await reserve((await latest(op.id,task.agentId)).id);const j=await latest(op.id,task.agentId);await reserve(j.id);
      const before=(await viewer.query("SELECT * FROM visible_fleet_session"))[0];
      await viewer.call("new_maincloud_chat",[before.epoch,before.conversation]);
      const after=(await viewer.query("SELECT * FROM visible_fleet_session"))[0];
      assert.equal(after.epoch,before.epoch);assert.equal(after.conversation,before.conversation+1);
      assert.deepEqual(await viewer.query("SELECT * FROM visible_chat_operations"),[]);
      assert.deepEqual(await viewer.query("SELECT * FROM visible_chat_messages"),[]);
      await assert.rejects(reply(j.id,{kind:"command",target:1,recipientAgentId:0,explanation:"Late fixture decision",evidenceIds:[]}));
      assert.equal((await rows("battle_attempt")).length,0);assert.ok((await rows("fleet_drone")).every(d=>d.controller==="defender"));
      await reply(j.id,{},"provider_timeout"); // The cancelled HTTP reservation releases only when its response/timeout arrives.
    });
    await t.test("owned fleet grows from 120 to 200 without resetting its epoch, evidence or agents",async()=>{
      await call("start_fleet",[120,0,0,false]);await call("enable_fleet_chat",[]);
      const op=await start([1,2],"recon");for(const task of op.config.tasks)await reserve((await latest(op.id,task.agentId)).id);
      const before=(await rows("fleet_session"))[0],clock=await rows("fleet_chat_clock"),evidence=await rows("fleet_evidence"),agents=await rows("fleet_agent"),health=await rows("battle_drone");
      await assert.rejects(viewer.call("grow_fleet",[before.epoch,200]));
      for(const args of [[before.epoch-1,200],[before.epoch,119],[before.epoch,257]])await assert.rejects(call("grow_fleet",args));
      await call("grow_fleet",[before.epoch,200]);await call("grow_fleet",[before.epoch,200]);
      assert.deepEqual((await rows("fleet_session"))[0],{...before,drones:200});assert.deepEqual(await rows("fleet_chat_clock"),clock);
      assert.deepEqual(await rows("fleet_evidence"),evidence);assert.deepEqual(await rows("fleet_agent"),agents);
      assert.equal((await rows("fleet_drone")).length,200);assert.equal((await rows("drone_schedule")).length,200);assert.equal((await rows("battle_drone")).length,200);assert.equal((await rows("battle_options")).length,400);
      const after=await rows("battle_drone");for(const row of health)assert.deepEqual(after.find(h=>h.drone===row.drone),row);
      assert.equal((await operation(op.id)).state,"completed");await delay(700);assert.ok((await rows("fleet_drone")).filter(d=>d.id>120).every(d=>d.tick>0));
    });
    await t.test("history admits 200 turns per role and keeps retries idempotent at the cap",async()=>{
      await reset();const session=(await viewer.query("SELECT * FROM visible_fleet_session"))[0];
      const before=(await rows("backend_chat_turn")).filter(t=>t.role==="attacker").length;
      for(let index=before;index<199;index++)await viewer.call("send_maincloud_message",[`history-limit-${index}`,"stop",0,session.epoch,session.conversation]);
      const op=await start();
      assert.equal((await rows("backend_chat_turn")).filter(t=>t.role==="attacker").length,200);
      await viewer.call("send_maincloud_message",["history-limit-198","stop",0,session.epoch,session.conversation]);
      await viewer.call("send_maincloud_message",["history-limit-200","Stop.",0,session.epoch,session.conversation]);
      assert.equal((await operation(op.id)).state,"cancelled","History exhaustion cannot prevent cancellation");
      await assert.rejects(viewer.call("send_maincloud_message",["history-limit-201","Another mission",0,session.epoch,session.conversation]));
      assert.equal((await rows("backend_chat_turn")).filter(t=>t.role==="attacker").length,200);
    });
  } finally { await db.close(); }
});

test("production hosted procedure reports missing provider configuration without fixtures",{skip:!process.env.SPACETIME_BINARY,timeout:20000},async()=>{
  const db=await testDatabase();
  const owner=new RunStore({uri:db.env.SPACETIME_URI,database:db.env.SPACETIME_DATABASE,token:db.env.SPACETIME_TOKEN});
  try{
    await owner.call("start_fleet",[32,0,0,false]);
    const identity:any=await fetch(db.env.SPACETIME_URI+"/v1/identity",{method:"POST"}).then(r=>r.json());await owner.call("grant_fleet_view",[identity.identity,"attacker"]);
    const viewer=new RunStore({uri:db.env.SPACETIME_URI,database:db.env.SPACETIME_DATABASE,token:identity.token});
    const state=(await viewer.query("SELECT * FROM visible_fleet_session"))[0];
    await viewer.call("send_maincloud_message",[randomUUID(),"Explain the visible evidence",0,state.epoch,state.conversation]);
    let failed:any;const until=Date.now()+10000;
    while(Date.now()<until){const turns=await viewer.query("SELECT * FROM visible_chat_turns");failed=turns.find((t:any)=>t.state==="failed");if(failed)break;await delay(60);}
    assert.ok(failed);assert.equal(JSON.parse(failed.result).error,"provider_not_configured");
    assert.deepEqual(await owner.query("SELECT * FROM fleet_agent"),[]);assert.deepEqual(await owner.query("SELECT * FROM battle_attempt"),[]);
    await assert.rejects(owner.call("fixture_hosted_reserve",[failed.id]),"Production module has no fixture endpoints");
  }finally{await db.close();}
});
