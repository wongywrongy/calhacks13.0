// Explicit, bounded provider verification on a disposable local database; no production writes.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { testDatabase } from "../sandbox/test/spacetime-helper.ts";
import { RunStore } from "../sandbox/src/run-store.ts";

assert.ok(process.argv.includes("--real"), "Pass --real to authorize actual Bitdeer calls");
assert.ok(process.env.BITDEER_API_KEY, "An authorized BITDEER_API_KEY is required");
const db = await testDatabase(undefined, {BITDEER_API_KEY:process.env.BITDEER_API_KEY});
const owner = new RunStore({uri:db.env.SPACETIME_URI,database:db.env.SPACETIME_DATABASE,token:db.env.SPACETIME_TOKEN});
const report:any = {at:new Date().toISOString(),scope:"Disposable local SpacetimeDB 2.13.0, production WASM, actual Bitdeer, 200 synthetic drones, original deadlines and call limits",checks:[],turns:[],operations:[]};
const wait = async (fn:()=>Promise<any>,ms=85000) => {
  const end=Date.now()+ms;
  while(Date.now()<end){const value=await fn();if(value)return value;await delay(250);}
  throw Error("Provider verification timed out");
};
try {
  await owner.call("start_fleet",[200,0,0,false]);
  await owner.call("enable_fleet_chat",[]);
  await owner.call("set_battle_seed",[4]);
  const clients:Record<string,RunStore>={};
  for(const role of ["attacker","defender"]){
    const identity:any=await fetch(db.env.SPACETIME_URI+"/v1/identity",{method:"POST"}).then(r=>r.json());
    await owner.call("grant_fleet_view",[identity.identity,role]);
    clients[role]=new RunStore({uri:db.env.SPACETIME_URI,database:db.env.SPACETIME_DATABASE,token:identity.token});
  }
  const send=async(role:string,message:string)=>{
    const client=clients[role],session=(await client.query("SELECT * FROM visible_fleet_session"))[0],key=randomUUID();
    const args=[key,message,0,session.epoch,session.conversation];
    await client.call("send_maincloud_message",args);await client.call("send_maincloud_message",args);
    const turn=await wait(async()=> (await client.query("SELECT * FROM visible_chat_turns")).find((t:any)=>t.request_key.endsWith(key)&&!["queued","running"].includes(t.state)),35000);
    report.turns.push({role,message,state:turn.state,result:JSON.parse(turn.result)});
    return turn;
  };
  const answer=await send("attacker","What does this synthetic simulation measure? Explain briefly; do not deploy agents.");
  assert.equal(answer.state,"completed");
  assert.equal(JSON.parse(answer.result).intent,"answer");
  assert.equal((await owner.query("SELECT * FROM fleet_agent")).length,0);
  report.checks.push("Ordinary question answered by Bitdeer without deploying agents; duplicate admission idempotent");
  const unclear=await send("attacker","Take over that one. I have not selected a drone or specified which target I mean; ask me which target.");
  assert.equal(unclear.state,"completed");assert.equal(JSON.parse(unclear.result).intent,"clarify");
  assert.equal((await owner.query("SELECT * FROM fleet_agent")).length,0);
  report.checks.push("Ambiguous target clarified without deploying agents");
  const planning=await Promise.allSettled([
    send("attacker","Deploy exactly two complementary specialists to test synthetic command entry on drones 8 and 10, one per target. Verify capture from simulator evidence. If entry is resisted, use useful permitted preparation or another approach and reassess. Keep singleton target scopes and the original budgets; stop honestly if blocked."),
    send("defender","Deploy exactly two specialists to harden synthetic drones 8 and 10, one per target, until readiness 90 is verified. Choose useful allowed actions using current evidence. Keep singleton target scopes and the original budgets; report unresolved work honestly.")
  ]);
  planning.forEach((r:any)=>{if(r.status==="rejected")throw r.reason;assert.equal(r.value.state,"completed");});
  await wait(async()=>{
    const all=await Promise.all(Object.values(clients).map(c=>c.query("SELECT * FROM visible_chat_operations")));
    return all.every(rows=>rows.length>0&&rows.every((o:any)=>!["planning","running"].includes(o.state)));
  });
  for(const [role,client] of Object.entries(clients)){
    const operations=await client.query("SELECT * FROM visible_chat_operations");
    for(const op of operations){
      const config=JSON.parse(op.config),results=JSON.parse(op.result);
      report.operations.push({role,state:op.state,config,results});
      assert.ok(results.some((r:any)=>r.type==="mission"),"Honest terminal mission outcome required");
      assert.ok(results.filter((r:any)=>r.type==="inference").every((r:any)=>r.source==="Bitdeer"));
      assert.ok((await client.query("SELECT * FROM visible_agent_tasks")).every((t:any)=>!["queued","running","observing","deciding","executing","waiting"].includes(t.state)));
    }
  }
  report.budgets=await owner.query("SELECT * FROM hosted_budget");
  assert.ok(report.budgets.every((b:any)=>b.calls<=33));
  const jobs=await owner.query("SELECT * FROM hosted_job");assert.ok(jobs.every((j:any)=>j.agent===0||j.step<=8));
  report.checks.push("Concurrent attacker/defender missions use actual Bitdeer choices and close with persisted simulator outcomes, bounded cumulative calls and no active terminal agents");
  report.attempts=await owner.query("SELECT * FROM battle_attempt");
  report.passed=true;
} catch(error){report.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{
  await mkdir("output/audit-20261025",{recursive:true});
  await writeFile("output/audit-20261025/provider.json",JSON.stringify(report,null,2));
  await db.close();
}
console.log(JSON.stringify({passed:report.passed,error:report.error,checks:report.checks,turns:report.turns.map((t:any)=>({role:t.role,state:t.state,result:t.result})),missions:report.operations.map((o:any)=>({role:o.role,state:o.state,outcome:o.results.findLast((r:any)=>r.type==="mission"),inferences:o.results.filter((r:any)=>r.type==="inference")}))}));
