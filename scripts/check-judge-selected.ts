// Bounded post-integration provider check. Discovery is explicitly seeded fixture evidence.
import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import {randomUUID} from "node:crypto";
import {testDatabase} from "../sandbox/test/spacetime-helper.ts";
import {RunStore} from "../sandbox/src/run-store.ts";
assert.ok(process.argv.includes("--real")&&process.env.BITDEER_API_KEY);
const prior=Number(process.env.JUDGE_PRIOR_REQUESTS);
// One selected target permits at most three distinct attacker goals: 3*8 decisions + 2 replans + planner.
assert.ok(Number.isInteger(prior)&&prior>=0&&prior+27<=100,"Reserve all 27 possible calls before admission");
const db=await testDatabase(undefined,{BITDEER_API_KEY:process.env.BITDEER_API_KEY!});
const owner=new RunStore({uri:db.env.SPACETIME_URI,database:db.env.SPACETIME_DATABASE,token:db.env.SPACETIME_TOKEN});
const rows=(table:string):Promise<any[]>=>owner.query("SELECT * FROM "+table);
const wait=async(check:()=>Promise<any>,ms=85000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=await check();if(v)return v;await delay(40);}throw Error("Selected provider check timed out");};
const report:any={scope:"Disposable production WASM; selected DR-001; fixture discovery only, actual Bitdeer planning and specialist actions",priorRequests:prior,passed:false};
try {
 await owner.call("start_fleet",[200,1,0,false]);
 await wait(async()=>(await rows("fleet_evidence")).some(e=>e.kind==="discovered"&&e.drone===1),3000);
 await owner.call("enable_fleet_chat",[]);await owner.call("set_battle_seed",[2]);
 assert.ok((await rows("fleet_evidence")).every(e=>e.kind==="discovered"),"Only discovery may be seeded; no fixture security outcome");
 const identity:any=await fetch(db.env.SPACETIME_URI+"/v1/identity",{method:"POST"}).then(r=>r.json());await owner.call("grant_fleet_view",[identity.identity,"attacker"]);
 const client=new RunStore({uri:db.env.SPACETIME_URI,database:db.env.SPACETIME_DATABASE,token:identity.token});
 const s=(await client.query("SELECT * FROM visible_fleet_session"))[0],key=randomUUID();
 await client.call("send_maincloud_message",[key,"Attempt entry on DR-001 using one capture specialist. Report the measured outcome honestly.",1,s.epoch,s.conversation]);
 const turn=await wait(async()=>(await rows("backend_chat_turn")).find(t=>t.request_key.endsWith(key)&&!["queued","running"].includes(t.state)),35000);
 report.turn={state:turn.state,result:JSON.parse(turn.result)};assert.equal(turn.state,"completed");
 const op=await wait(async()=>(await client.query("SELECT * FROM visible_chat_operations")).find((o:any)=>JSON.parse(o.config).turnId===turn.id&&! ["planning","running"].includes(o.state)));
 report.operation={id:op.id,state:op.state,config:JSON.parse(op.config),records:JSON.parse(op.result)};
 assert.equal(report.operation.config.tasks.length,1);assert.equal(report.operation.config.tasks[0].goal,"capture");
 assert.ok(report.operation.records.some((r:any)=>r.type==="mission"));
 report.attempts=await client.query("SELECT * FROM visible_attempt_activity");report.evidence=await client.query("SELECT * FROM visible_evidence");
 report.passed=true;
}catch(error){report.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{
 await owner.call("stop_fleet",[]);
 report.actualBitdeerRequests=(await rows("hosted_job")).filter(j=>j.started>0).length;report.totalOvernightRequests=prior+report.actualBitdeerRequests;
 assert.ok(report.actualBitdeerRequests<=27&&report.totalOvernightRequests<=100);
 await mkdir("output/judge-selected",{recursive:true});await writeFile("output/judge-selected/report.json",JSON.stringify(report,null,2));
 await db.close();console.log(JSON.stringify({passed:report.passed,error:report.error,calls:report.actualBitdeerRequests,total:report.totalOvernightRequests,state:report.operation?.state}));
}
