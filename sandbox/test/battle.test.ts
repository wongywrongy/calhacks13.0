import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { testDatabase } from "./spacetime-helper.ts";
import { RunStore } from "../src/run-store.ts";

// These are reducer integration fixtures, not model behavior or frontend animation.
test("seeded battle: local cumulative effects, fallibility, adaptation, interruption and epoch reset", { skip: !process.env.SPACETIME_BINARY, timeout: 120000 }, async (t) => {
 const db=await testDatabase();
 const store=new RunStore({uri:db.env.SPACETIME_URI,database:db.env.SPACETIME_DATABASE,token:db.env.SPACETIME_TOKEN});
 const rows=(table:string)=>store.query("SELECT * FROM "+table);
 const drone=async(id:number)=>(await rows("fleet_drone")).find((d:any)=>d.id===id);
 const health=async(id:number)=>(await rows("battle_drone")).find((d:any)=>d.drone===id);
 const heartbeat=setInterval(()=>void store.heartbeat().catch(()=>{}),5000);
 let nextAgent=100;
 let baselineEntry:any[]=[];
 const plan=async(role:string,targets:number[],goal?:string,duration=75000)=>{
  const epoch=(await rows("fleet_session"))[0].epoch, id=randomUUID();
  const generation=(await rows("backend_chat_session")).find((r:any)=>r.role===role)?.generation??1;
  await store.call("create_chat_operation",[store.session,id,id,role,epoch,JSON.stringify({conversation:generation,message:"Synthetic battle fixture",target:null,tasks:[],maxDecisionsPerAgent:8,maxModelCalls:33,createdAt:Date.now(),deadline:Date.now()+duration})]);
  const tasks=targets.map(target=>({agentId:++nextAgent,name:"Fixture "+nextAgent,specialty:"simulation",target,objective:"Exercise validated virtual action",...(goal?{goal}:{})}));
  await store.call("plan_chat_operation",[store.session,id,JSON.stringify(tasks)]);
  const sequence=new Map<number,number>();
  return {id,tasks,queue:async(index:number,kind:string)=>{
   const task=tasks[index], step=(sequence.get(index)??0)+1;
   await store.call("execute_fleet_chat_action",[store.session,id,step,task.agentId,task.target,kind,role==="defender"?(await drone(task.target)).policy_version:0]);
   sequence.set(index,step);return `${id}:${task.agentId}:${step}`;
  },finish:()=>store.call("update_chat_operation",[store.session,id,"completed","[]"])};
 };
 const resolved=async(key:string)=>{
  for(let i=0;i<130;i++){
   const a=(await rows("battle_attempt")).find((a:any)=>a.key===key);
   if(a?.stage==="resolved")return JSON.parse(a.report);
   await delay(50);
  }
  assert.fail("Scheduled attempt failed to resolve");
 };
 const reset=async(seed:number)=>{
  await store.call("start_fleet",[32,0,0,false]);
  await store.call("enable_fleet_chat",[]);
  await store.call("set_battle_seed",[seed]);
 };
 try {
  await store.call("acquire_backend",[store.session,2,8]);
  await reset(2);
  await t.test("selected entry takes time; spread exceeds two captures with a partial outcome",async()=>{
   const a=await plan("attacker",[1,18]);
   await a.queue(0,"discover");await a.queue(1,"discover");
   const keys=await Promise.all([a.queue(0,"command"),a.queue(1,"command")]);
   assert.ok((await rows("fleet_drone")).every((d:any)=>d.controller==="defender"),"Selection cannot seize drones");
   const stages=new Set<string>(), deadline=Date.now()+8000;
   while(Date.now()<deadline&&(await rows("battle_attempt")).some((a:any)=>a.stage!=="resolved")){
    for(const a of await rows("battle_attempt"))stages.add(a.stage);await delay(80);
   }
   // The queued stage may advance before the first HTTP sample.
   assert.ok(stages.has("preparing")&&stages.has("executing"),JSON.stringify([...stages]));
   const entry=await Promise.all(keys.map(resolved));assert.ok(entry.every(r=>r.succeeded===1));baselineEntry=entry;
   const route=(await rows("battle_options")).find((o:any)=>o.key==="attacker:18");
   assert.ok(route.actions.includes("spread")&&route.reachable.length>0,"A foothold opens eligible local routes");
   const spread=await resolved(await a.queue(1,"spread"));
   assert.ok(spread.succeeded>0&&spread.succeeded<spread.total,JSON.stringify(spread));
   assert.ok(spread.partial>0,JSON.stringify(spread));
   assert.ok((await rows("fleet_drone")).filter((d:any)=>d.controller==="attacker").length>2);
   assert.ok((await health(19)).contamination>0);
   assert.ok(spread.results.some((r:any)=>r.openedRoutes.length>0));
   assert.ok(spread.results.every((r:any)=>r.beforeController&&Array.isArray(r.evidenceIds)),"Outcome facts support one canonical activity entry");
   assert.equal((await drone(19)).controller,"defender","Limited access is not capture");
   assert.equal((await health(32)).contamination,0,"No global automatic infection");
   assert.ok(spread.results.every((r:any)=>r.factors.chance>=5&&r.factors.chance<=90&&typeof r.roll==="number"));
   await a.finish();
  });
  await t.test("defense can fail or partially recover; a connected source prevents cleanup",async()=>{
   const d=await plan("defender",[1,18]);
   const connected=await resolved(await d.queue(0,"verify"));
   assert.match(connected.summary,/source remains connected/);
   const isolation=await Promise.all([d.queue(0,"isolate"),d.queue(1,"isolate")]);
   const reports=await Promise.all(isolation.map(resolved));
   t.diagnostic("Isolation reports: "+JSON.stringify(reports));
   assert.ok(reports.some(r=>r.succeeded<r.total),"Defensive selection can fail");
   const isolated=(await rows("fleet_drone")).filter((v:any)=>v.isolated);
   assert.ok(isolated.length>0);
   const id=isolated[0].id,index=id===1?0:1;
   assert.equal((await rows("battle_drone")).find((h:any)=>h.drone===id).contamination,100,"Containment does not erase contamination");
   const before=await drone(id);await delay(550);assert.equal((await drone(id)).commands,before.commands,"Isolation suspends mission commands");
   const recovery=await resolved(await d.queue(index,"verify"));
   t.diagnostic("Recovery report: "+JSON.stringify(recovery));
   assert.ok(recovery.succeeded>0||recovery.partial>0,"Recovery can reduce contamination");
   assert.ok((await health(id)).contamination<100);
   const release=await resolved(await d.queue(index,"release"));assert.equal(release.succeeded,1);
   assert.equal((await drone(id)).isolated,false,"Clean release restores availability");
   await d.finish();
   const renewed=await plan("attacker",[1,18]);
   const reinfection=await resolved(await renewed.queue(0,"command"));
   assert.equal(reinfection.results[0].eligible,true);assert.ok(reinfection.results[0].factors.exposure>0);
   assert.equal(reinfection.succeeded,1,"Remaining connected footholds allow renewed exposure after recovery");
   await renewed.finish();
  });
  await t.test("new views preserve role scope and private simulation authority",async()=>{
   for(const role of ["attacker","defender","observer",""]){
    const identity:any=await fetch(db.env.SPACETIME_URI+"/v1/identity",{method:"POST"}).then(r=>r.json());
    if(role)await store.call("grant_fleet_view",[identity.identity,role]);
    const reader=new RunStore({uri:db.env.SPACETIME_URI,database:db.env.SPACETIME_DATABASE,token:identity.token});
    const visible=await reader.query("SELECT * FROM visible_battle_drones");
    const attempts=await reader.query("SELECT * FROM visible_battle_attempts");
    for(const view of ["visible_battle_options","visible_attempt_activity","visible_agent_tasks","visible_team_activity"]){
     const visible=await reader.query("SELECT * FROM "+view);
     if(!role)assert.deepEqual(visible,[]);else if(role!=="observer")assert.ok(visible.every((r:any)=>r.role===role),view+" must hide opponent operations");
    }
    if(role==="defender"){
     const attackerIds=new Set((await rows("fleet_agent")).filter((a:any)=>a.role==="attacker").map((a:any)=>a.id));
     assert.ok((await reader.query("SELECT * FROM visible_evidence")).every((e:any)=>!attackerIds.has(e.actor)),"New evidence must not reveal attacker identities");
    }
    if(!role){assert.deepEqual(visible,[]);assert.deepEqual(attempts,[])}
    else {
     assert.ok(visible.length>0);
     if(role==="attacker")assert.ok(visible.every((h:any)=>h.readiness===0));
     if(role!=="observer"){
      const ownAgents=new Set((await rows("fleet_agent")).filter((a:any)=>a.role===role).map((a:any)=>a.id));
      assert.ok(attempts.every((a:any)=>ownAgents.has(a.agent)));
     }
    }
    for(const table of ["battle_state","battle_drone","battle_attempt","battle_retry","battle_options"])await assert.rejects(reader.query("SELECT * FROM "+table));
    await assert.rejects(reader.call("set_battle_seed",[1]));
   }
  });
  await t.test("a fresh failed attempt and unchanged retries never accumulate bonuses",async()=>{
   await reset(4);
   const a=await plan("attacker",[8,9]);await a.queue(0,"discover");
   const first=await resolved(await a.queue(0,"command"));
   t.diagnostic("Entry failure report: "+JSON.stringify(first));
   assert.equal(first.succeeded,0);assert.equal(first.partial,0);
   for(let i=0;i<2;i++){
    const r=await resolved(await a.queue(0,"command"));
    assert.equal(r.succeeded,0);assert.equal(r.results[0].eligible,false);assert.match(r.summary,/Unchanged strategy/);
   }
   assert.equal((await drone(8)).controller,"defender");
   const opts=(await rows("battle_options")).find((o:any)=>o.key==="attacker:8");
   assert.ok(!opts.actions.includes("command")&&opts.actions.includes("prepare"),"Resisted action is removed; materially different preparation remains eligible");
   await a.finish();
  });
  await t.test("a defensive countermeasure interrupts pending spread",async()=>{
   await reset(2);
   const a=await plan("attacker",[1,18]);await a.queue(0,"discover");await a.queue(1,"discover");
   const replay=await Promise.all([a.queue(0,"command"),a.queue(1,"command")].map(async p=>resolved(await p)));
   const facts=(reports:any[])=>reports.map(({at,...report})=>({...report,results:report.results.map(({evidenceIds,...result}:any)=>result)}));
   assert.deepEqual(facts(replay),facts(baselineEntry),"Same seed and ordered conditions reproduce outcomes across epochs");
   const d=await plan("defender",[18,1]);
   const pending=await a.queue(1,"spread"),contain=await d.queue(0,"isolate");
   const isolation=await resolved(contain);t.diagnostic("Countermeasure: "+JSON.stringify(isolation));
   assert.equal(isolation.succeeded,1);
   const options=(await rows("battle_options")).find((o:any)=>o.key==="attacker:18");assert.ok(!options.actions.includes("spread"),"Isolation invalidates the spread suggestion");
   assert.ok((await rows("battle_options")).find((o:any)=>o.key==="defender:18").actions.includes("verify"),"Contained contamination can be assessed for cleanup");
   const interrupted=await resolved(pending);assert.equal(interrupted.succeeded,0);assert.match(interrupted.summary,/interrupted/);
   assert.equal((await health(2)).contamination,0);await a.finish();await d.finish();
  });
  await t.test("reset during an attempt clears timers, state and chats; stale calls cannot return",async()=>{
   const before=await rows("battle_drone");
   await db.restart();
   assert.deepEqual((await rows("battle_drone")).sort((a:any,b:any)=>a.drone-b.drone),before.sort((a:any,b:any)=>a.drone-b.drone),"Consequences persist across database restart");
   await reset(2);
   const a=await plan("attacker",[1,18]);await a.queue(0,"discover");const key=await a.queue(0,"command");
   const epoch=(await rows("fleet_session"))[0].epoch;
   await store.call("reset_chat_fleet",[store.session,epoch,true]);
   for(const table of ["battle_attempt","battle_retry","battle_schedule","battle_drone","battle_state","battle_options","fleet_hold","fleet_chat_action","fleet_discovery","hosted_job","hosted_alarm"])
    assert.deepEqual(await rows(table),[],table);
   await delay(4500);
   assert.ok((await rows("fleet_drone")).every((d:any)=>d.controller==="defender"&&!d.isolated&&d.policy_version===0));
   await assert.rejects(store.call("execute_fleet_chat_action",[store.session,a.id,3,a.tasks[0].agentId,1,"command",0]));
   assert.ok(!(await rows("battle_attempt")).some((a:any)=>a.key===key));
   for(const role of ["attacker","defender"]){
    const generation=(await rows("backend_chat_session")).find((r:any)=>r.role===role).generation;
    assert.ok(!(await rows("backend_chat_message")).some((m:any)=>m.role===role&&m.key.startsWith(`epoch:${epoch+1}:chat:${generation}:`)));
   }
  });
  await t.test("typed objectives are reducer enforced and orphaned work expires with a truthful closed status",async()=>{
   await reset(2);const a=await plan("attacker",[1,18],"recon",1000);await a.queue(0,"discover");
   await assert.rejects(a.queue(0,"command"),"Recon objective cannot expand into a capture");
   await store.call("update_chat_operation",[store.session,a.id,"running",JSON.stringify(a.tasks.map(task=>({type:"worker",agentId:task.agentId,target:task.target,state:"queued",at:Date.now()})))]);
   await delay(1800);
   assert.equal((await rows("backend_chat")).find((o:any)=>o.id===a.id).state,"failed");
   const identity:any=await fetch(db.env.SPACETIME_URI+"/v1/identity",{method:"POST"}).then(r=>r.json());await store.call("grant_fleet_view",[identity.identity,"attacker"]);
   const reader=new RunStore({uri:db.env.SPACETIME_URI,database:db.env.SPACETIME_DATABASE,token:identity.token});
   const tasks=await reader.query("SELECT * FROM visible_agent_tasks");assert.ok(tasks.every((task:any)=>task.state==="failed"&&/time budget/.test(task.summary)));
   const team=(await reader.query("SELECT * FROM visible_team_activity"))[0];assert.equal(team.active_agents,0);assert.equal(team.stage,"blocked");
  });
 } finally {clearInterval(heartbeat);await db.close()}
});
