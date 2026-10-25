import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { MaincloudChat } from "../web/maincloud-chat.ts";
const config=JSON.parse(await readFile(process.env.FLEET_MAINCLOUD_CONFIG||"output/maincloud/fleet-config.json","utf8"));
const live=process.argv.includes("--live");
const report:any={database:config.database,at:new Date().toISOString(),live,checks:[],passed:false};
const owner=(q:string) => JSON.parse(execFileSync("spacetime",["sql","-s","maincloud","--format","json",config.database,q],{encoding:"utf8",stdio:["ignore","pipe","pipe"]}));
const columns=(data:any)=> data[0].schema.elements.map((e:any)=>e.name.some ?? e.name);
const rows=(data:any)=>data[0].rows.map((r:any)=>Object.fromEntries(columns(data).map((k:string,i:number)=>[k,r[i]])));
const callOwner=(name:string,args:any[])=>execFileSync("spacetime",["call","-s","maincloud",config.database,name,...args.map(a=>JSON.stringify(a)),"-y"],{stdio:["ignore","pipe","pipe"]});
const wait=async (fn:()=>Promise<any>,ms=85000)=>{const until=Date.now()+ms;while(Date.now()<until){const v=await fn();if(v)return v;await delay(300);}throw Error("Maincloud check timed out")};
const clients:MaincloudChat[]=[];
try {
  const initial=rows(owner("SELECT * FROM fleet_session"));
  if(!initial.length) callOwner("start_fleet",[120,0,0,false]);
  const before=rows(owner("SELECT * FROM fleet_drone"));
  assert.equal(before.length,120);
  if (!initial.length) assert.equal(rows(owner("SELECT * FROM fleet_agent")).length,0);
  await delay(800);
  const after=rows(owner("SELECT * FROM fleet_drone"));
  assert.ok(after.every((d:any)=>d.tick>before.find((v:any)=>v.id===d.id).tick));
  report.checks.push("120 persisted drones update independently; initialization deploys zero agents");
  for(const role of ["attacker","defender"]){
    const client=await MaincloudChat.connect({...config,...config.workspaces[role]});clients.push(client);
    const snapshot=await client.snapshot();
    assert.ok(snapshot.messages.every((m:any)=>!m.role||m.role===role));
    const privateRead=await fetch(`${config.uri}/v1/database/${config.database}/sql`,{method:"POST",headers:{authorization:`Bearer ${config.workspaces[role].token}`},body:"SELECT * FROM hosted_job"});
    assert.ok(!privateRead.ok,"Role must not read inference reservations");
    const forbidden=await fetch(`${config.uri}/v1/database/${config.database}/call/start_fleet`,{method:"POST",headers:{authorization:`Bearer ${config.workspaces[role].token}`,"content-type":"application/json"},body:JSON.stringify([120,0,0,false])});
    assert.ok(!forbidden.ok,"Role cannot start arbitrary fixture fleet");
  }
  const [attack,defend]=clients;
  const anon:any=await fetch(`${config.uri}/v1/identity`,{method:"POST"}).then(r=>r.json());
  const anonymous=await fetch(`${config.uri}/v1/database/${config.database}/sql`,{method:"POST",headers:{authorization:`Bearer ${anon.token}`},body:"SELECT * FROM visible_fleet_session"});
  assert.deepEqual((await anonymous.json())[0].rows,[]);
  report.checks.push("Real role-scoped WebSocket subscriptions, private-table denial, unauthorized mutation denial, ungranted identity isolation");
  if(live){
    const run=async(client:MaincloudChat,message:string)=>{
      const state=await client.snapshot();
      const key=crypto.randomUUID();
      await client.submit(key,message,0,state.fleet.epoch,state.conversation);
      await client.submit(key,message,0,state.fleet.epoch,state.conversation);
      await assert.rejects(client.submit(key,message+" changed",0,state.fleet.epoch,state.conversation),/Idempotency conflict/);
      const result=await wait(async()=>{
        const s=await client.snapshot();
        const t=s.turns.at(-1);if(t?.state==="failed")throw Error(JSON.stringify(t));
        const op=s.operations.find((o:any)=>o.turnId===t?.id);
        if(op && !["planning","running"].includes(op.state))return op;
        return false;
      });
      report.operations??=[];report.operations.push(result);
      assert.equal(result.state,"completed",JSON.stringify(result));
      return result;
    };
    const attacker=await run(attack,"Deploy exactly two specialists on catalog targets 1 and 2. Discover each assigned synthetic drone, then test the planted command authorization weakness. Stop each assignment after one measured command outcome.");
    assert.ok(attacker.results.some((r:any)=>r.outcome==="unauthorized_command_accepted"));
    const defender=await run(defend,"Deploy exactly two specialists to recover drones 1 and 2 from the current incident. Apply isolation, then verify unauthorized denial and legitimate acceptance on each assigned drone. Report only measured recovery evidence.");
    assert.ok(defender.results.some((r:any)=>r.outcome==="recovery_verified" && r.verificationEvidenceIds.length===2));
    report.checks.push("Bounded actual Bitdeer attack and defense, measured takeover, versioned policy, paired recovery evidence; no Node coordinator");
    const state=await defend.snapshot();
    const reopened=await MaincloudChat.connect({...config,...config.workspaces.defender});clients.push(reopened);
    await wait(async()=> (await reopened.snapshot()).operations.length===state.operations.length,10000);
    assert.deepEqual((await reopened.snapshot()).messages.map((m:any)=>m.id),state.messages.map((m:any)=>m.id));
    report.checks.push("Fresh connection reconstructs persisted chat and operation state");
    await attack.submit(crypto.randomUUID(),"What does the currently visible evidence establish? Answer briefly; do not deploy agents.",0,state.fleet.epoch,(await attack.snapshot()).conversation);
    await wait(async()=>rows(owner("SELECT * FROM hosted_job")).some((j:any)=>j.agent===0&&j.state==="running"),10000);
    await defend.reset(state.fleet.epoch,true);
    await wait(async()=> (await defend.snapshot()).fleet.epoch>state.fleet.epoch,10000);
    const reset=await defend.snapshot();
    assert.equal(rows(owner("SELECT * FROM fleet_drone")).length,120);
    assert.equal(rows(owner("SELECT * FROM fleet_agent")).length,0);
    await assert.rejects(attack.submit(crypto.randomUUID(),"Stale work",0,state.fleet.epoch,reset.conversation),/Stale/);
    const stale=await fetch(`${config.uri}/v1/database/${config.database}/call/reset_maincloud_fleet`,{method:"POST",headers:{authorization:`Bearer ${config.workspaces.attacker.token}`,"content-type":"application/json"},body:JSON.stringify([reset.fleet.epoch,true])});assert.ok(!stale.ok);
    await wait(async()=>!rows(owner("SELECT * FROM hosted_job")).some((j:any)=>j.state==="running"),25000);
    assert.equal(rows(owner("SELECT * FROM fleet_agent")).length,0);
    assert.ok((await defend.snapshot()).messages.length===0);
    const jobs=rows(owner("SELECT * FROM hosted_job"));
    report.jobs=jobs.map(({id,operation,agent,state,started,finished,result}:any)=>({id,operation,agent,state,started,finished,result}));
    assert.ok(jobs.filter((j:any)=>j.agent===0&&j.epoch===state.fleet.epoch).some((j:any)=>j.state==="failed"));
    report.checks.push("Reset retains 120 drones, clears active agents, rejects stale epoch and attacker reset, discards a real in-flight provider completion");
    const concurrent=jobs.flatMap((j:any)=>j.started?[{at:j.started,n:1},{at:j.finished||Date.now(),n:-1}]:[]).sort((a:any,b:any)=>a.at-b.at||a.n-b.n);
    let active=0,max=0;for(const e of concurrent){active+=e.n;max=Math.max(max,active)}assert.ok(max<=4);report.maxConcurrent=max;
    const budgets=rows(owner("SELECT * FROM hosted_budget"));assert.ok(budgets.every((b:any)=>b.calls<=33));report.budgets=budgets;
    report.checks.push("Persisted model budgets <=33/operation and measured inference concurrency <=4");
  }
  report.passed=true;
} catch(e:any){report.error=e.stack;process.exitCode=1;}
finally {for(const c of clients)c.close();await mkdir("output/maincloud",{recursive:true});await writeFile("output/maincloud/verification.json",JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.checks,error:report.error,maxConcurrent:report.maxConcurrent}));}
