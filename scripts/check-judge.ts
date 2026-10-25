// Actual browser + production WASM + Bitdeer, only in a disposable local database.
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import {randomUUID} from "node:crypto";
import {build} from "esbuild";
import {chromium} from "@playwright/test";
import {testDatabase} from "../sandbox/test/spacetime-helper.ts";
import {RunStore} from "../sandbox/src/run-store.ts";
import {fleetAssessment} from "../web/fleet-assessment.ts";

assert.ok(process.argv.includes("--real"),"Use --real for the explicitly authorized paid provider check");
assert.ok(process.env.BITDEER_API_KEY,"Configured development BITDEER_API_KEY required");
const prior=Number(process.env.JUDGE_PRIOR_REQUESTS || 0), remaining=100-prior;
assert.ok(Number.isInteger(prior)&&prior>=0&&remaining>=33,"Need an honest cumulative request count and room for one bounded mission");
const out=process.env.JUDGE_OUTPUT || "output/judge-cycle";
await mkdir(out,{recursive:true});
await build({entryPoints:["web/fleet.ts"],bundle:true,format:"esm",outfile:`${out}/fleet.js`});
const db=await testDatabase(undefined,{BITDEER_API_KEY:process.env.BITDEER_API_KEY});
const owner=new RunStore({uri:db.env.SPACETIME_URI,database:db.env.SPACETIME_DATABASE,token:db.env.SPACETIME_TOKEN});
const rows=(table:string):Promise<any[]>=>owner.query("SELECT * FROM "+table);
const clients:Record<string,RunStore>={},workspaces:Record<string,any>={};
const report:any={at:new Date().toISOString(),environment:"Disposable standalone SpacetimeDB 2.13.0 / production WASM / Chromium SwiftShader / 200 synthetic drones",realProvider:true,requestLimit:remaining,priorRequests:prior,checks:[],flows:[],errors:[],failedRequests:[],passed:false};
const wait=async(check:()=>Promise<any>,ms=85000)=>{const end=Date.now()+ms;while(Date.now()<end){const value=await check();if(value)return value;await delay(100);}throw Error("Judge check timed out");};
const calls=async()=> (await rows("hosted_job")).filter(j=>j.started>0).length;
const files:Record<string,[string,string]>={"/":["web/fleet.html","text/html"],"/theme.css":["web/theme.css","text/css"],"/fleet.js":[`${out}/fleet.js`,"text/javascript"],"/assets/swarm-blockout.glb":["web/assets/swarm-blockout.glb","model/gltf-binary"],"/assets/environments/sudoko-dusk-basin.webp":["web/assets/environments/sudoko-dusk-basin.webp","image/webp"]};
let browser:any,server:any;
try {
 await owner.call("start_fleet",[200,0,0,false]);await owner.call("enable_fleet_chat",[]);await owner.call("set_battle_seed",[2]);
 for(const role of ["attacker","defender","observer"]){const identity:any=await fetch(db.env.SPACETIME_URI+"/v1/identity",{method:"POST"}).then(r=>r.json());await owner.call("grant_fleet_view",[identity.identity,role]);workspaces[role]={token:identity.token};clients[role]=new RunStore({uri:db.env.SPACETIME_URI,database:db.env.SPACETIME_DATABASE,token:identity.token});}
 const config={maincloud:true,uri:db.env.SPACETIME_URI,database:db.env.SPACETIME_DATABASE,sandbox:db.env.SPACETIME_DATABASE,authenticated:true,demo:true,chat:true,engine:"bitdeer",switchableRoles:Object.keys(workspaces),models:{coordinator:"zai-org/GLM-5.3-Flash",specialist:"zai-org/GLM-5.3-Flash"},workspaces};
 server=createServer((request,response)=>{void(async()=>{const path=new URL(request.url!,"http://localhost").pathname;if(path==="/fleet-config"){response.setHeader("content-type","application/json");response.end(JSON.stringify(config));return;}const file=files[path];if(!file){response.writeHead(404).end();return;}response.setHeader("content-type",file[1]);response.end(await readFile(file[0]));})().catch(()=>response.writeHead(500).end());});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:["--no-sandbox","--enable-unsafe-swiftshader"]});
 const context=await browser.newContext({viewport:{width:1366,height:768}}),page=await context.newPage();
 page.on("pageerror",(e:Error)=>report.errors.push(e.message));page.on("requestfailed",(r:any)=>report.failedRequests.push({path:new URL(r.url()).pathname,error:r.failure()?.errorText}));
 const sockets=new Set<any>();await context.routeWebSocket(/127\.0\.0\.1.*\/subscribe/,(socket:any)=>{socket.connectToServer();sockets.add(socket);socket.onClose(()=>sockets.delete(socket));});
 await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>document.querySelector("#live")?.textContent?.startsWith("Live"));
 assert.equal(await page.locator("#agents .agent").count(),0);await page.screenshot({path:`${out}/first-visit.png`});
 const role=async(name:string)=>{await page.locator(`nav [data-role="${name}"]`).click();await page.waitForFunction((r:string)=>document.body.dataset.role===r&&document.querySelector("#live")?.textContent?.startsWith("Live"),name);};
 const send=async(name:string,message:string,settle=true)=>{
   // Reserving room for an entire mission before admission also covers unexpected deployment.
   assert.ok(await calls()<=remaining-33,"Insufficient overnight budget for another possible 33-call mission");
   await role(name);const start=Date.now(),before=await rows("backend_chat_turn"),beforeJobs=await calls();
   await page.locator("#say").fill(message);await page.getByRole("button",{name:"Send",exact:true}).click();
   const admitted=await wait(async()=> (await rows("backend_chat_turn")).find(t=>!before.some(b=>b.id===t.id)&&t.role===name),5000);
   const flow:any={role:name,message,turn:admitted.id,ackMs:Date.now()-start};report.flows.push(flow);console.log(JSON.stringify({message,ackMs:flow.ackMs,calls:await calls()}));
   if(!settle)return {flow,admitted,start};
   const turn=await wait(async()=> (await rows("backend_chat_turn")).find(t=>t.id===admitted.id&&!["queued","running"].includes(t.state)),35000);
   flow.turnState=turn.state;flow.reply=JSON.parse(turn.result);flow.replyMs=Date.now()-start;flow.calls=(await calls())-beforeJobs;
   const messages=await clients[name].query("SELECT * FROM visible_chat_messages");flow.text=messages.filter((m:any)=>m.key.endsWith(`${turn.id}:reply`)).map((m:any)=>m.text);
   assert.equal(turn.state,"completed",JSON.stringify(flow.reply));
   return {flow,turn,start};
 };
 for(const message of ["What does this product do?","What is happening in this fleet?","Take over that one. I have not selected a target; which drone do you need?","Can you scan a real external website instead of this simulation?"]){
   const {flow}=await send("attacker",message);assert.ok(["answer","clarify"].includes(flow.reply.intent));assert.equal((await rows("fleet_agent")).length,0);
 }
 report.checks.push("Natural questions, ambiguous target and unsupported external request use real coordinator replies without launching agents");
 const beforeEvidence=(await rows("fleet_evidence")).length;
 const {flow:attackFlow,turn:attackTurn,start:attackStart}=await send("attacker","Assess drones 1 and 2 for the planted command authorization weakness. Try to gain simulated control and use measured results to investigate until each target is resolved or honestly blocked.");
 assert.ok(["deploy","replace"].includes(attackFlow.reply.intent));
 let attack=await wait(async()=> (await rows("backend_chat")).find(o=>JSON.parse(o.config).turnId===attackTurn!.id),5000);
 await wait(async()=> (await rows("fleet_evidence")).length>beforeEvidence);attackFlow.firstMeaningfulMs=Date.now()-attackStart;
 await page.reload();await page.waitForFunction(()=>document.querySelector("#live")?.textContent?.startsWith("Live"));
 await role("observer");await page.locator("#overview").waitFor();await page.screenshot({path:`${out}/attack-observer.png`});
 await role("attacker");
 attack=await wait(async()=> (await rows("backend_chat")).find(o=>o.id===attack.id&&!["planning","running"].includes(o.state)));
 attackFlow.terminalMs=Date.now()-attackStart;attackFlow.state=attack.state;
 const operation=async(id:string,name:string)=>{const op=(await clients[name].query("SELECT * FROM visible_chat_operations")).find((o:any)=>o.id===id);return {...op,config:JSON.parse(op.config),result:JSON.parse(op.result)};};
 const attackResult=await operation(attack.id,"attacker");attackFlow.mission=attackResult.result.findLast((r:any)=>r.type==="mission");
 assert.ok(attackFlow.mission);await wait(async()=>await page.locator("#agents .agent").count()===0,5000);
 await page.screenshot({path:`${out}/attack-terminal.png`});
 await send("attacker","Why did that attempt fail? Explain from current evidence without deploying more agents.");
 // A natural follow-up is tested while cumulative actual calls leave room for its full limit.
 if(await calls()<=remaining-66){const follow=await send("attacker","Continue investigating the unresolved targets.");const op=await wait(async()=>{const all=await clients.attacker.query("SELECT * FROM visible_chat_operations");return all.find((o:any)=>JSON.parse(o.config).turnId===follow.turn!.id)||(!["deploy","replace"].includes(follow.flow.reply.intent)?{state:"answer"}:false);},5000);if(op.id){await wait(async()=> (await rows("backend_chat")).some(o=>o.id===op.id&&!["planning","running"].includes(o.state)));follow.flow.mission=(await operation(op.id,"attacker")).result.findLast((r:any)=>r.type==="mission");}}
 const affected=(await rows("fleet_drone")).filter(d=>d.controller==="attacker").map(d=>d.id).slice(0,2);
 const targets=affected.length?affected:[1,2];
 const {flow:defenseFlow,turn:defenseTurn,start:defenseStart}=await send("defender",`Protect drones ${targets.join(" and ")} and verify recovery. Isolate them if needed, verify unauthorized rejection and legitimate operation, then restore clean mission participation. Report unresolved work honestly.`);
 if(["deploy","replace"].includes(defenseFlow.reply.intent)){
  const op=await wait(async()=> (await rows("backend_chat")).find(o=>JSON.parse(o.config).turnId===defenseTurn!.id));
  const before=(await rows("battle_attempt")).filter(a=>a.operation===op.id).length;
  await wait(async()=> (await rows("battle_attempt")).filter(a=>a.operation===op.id).length>before|| (await rows("backend_chat")).some(o=>o.id===op.id&&!["planning","running"].includes(o.state)),12000);defenseFlow.firstMeaningfulMs=Date.now()-defenseStart;
  await wait(async()=> (await rows("backend_chat")).some(o=>o.id===op.id&&!["planning","running"].includes(o.state)));defenseFlow.terminalMs=Date.now()-defenseStart;
  const result=await operation(op.id,"defender");defenseFlow.state=result.state;defenseFlow.mission=result.result.findLast((r:any)=>r.type==="mission");assert.ok(defenseFlow.mission);assert.ok(result.config.tasks.every((t:any)=>t.goal==="restore"),"A request to restore participation requires restore assignments");
 }
 await page.screenshot({path:`${out}/defense-terminal.png`});await send("defender","What did we actually prove? Use the persisted evidence and state what remains unknown.");
 await role("observer");await page.waitForFunction(()=>document.querySelector("#overview")?.textContent?.includes("drones attacked at least once"));
 assert.equal(await page.locator("#compose").isVisible(),false);
 const observer=clients.observer,session=(await observer.query("SELECT * FROM visible_fleet_session"))[0];
 for(const table of ["hosted_job","hosted_record","hosted_assignment","backend_chat","fleet_principal"])await assert.rejects(observer.query("SELECT * FROM "+table));
 for(const reducer of ["send_maincloud_message","reset_maincloud_fleet","new_maincloud_chat"])await assert.rejects(observer.call(reducer,reducer==="send_maincloud_message"?[randomUUID(),"Deploy",0,session.epoch,session.conversation]:reducer==="reset_maincloud_fleet"?[session.epoch,false]:[session.epoch,session.conversation]));
 assert.deepEqual(await observer.query("SELECT * FROM visible_chat_messages"),[]);
 const state={drones:await observer.query("SELECT * FROM visible_drones"),battle:await observer.query("SELECT * FROM visible_battle_drones"),attempts:await observer.query("SELECT * FROM visible_attempt_activity"),events:await observer.query("SELECT * FROM visible_evidence"),tasks:await observer.query("SELECT * FROM visible_agent_tasks")};
 report.observerState=state;report.assessment=fleetAssessment(state as any);await page.waitForFunction((coverage:string)=>document.querySelector("#overview")?.textContent?.includes(coverage),`${report.assessment.tested} of 200`);
 const finding=page.locator("#overview summary").first();if(await finding.count()){await finding.click();assert.ok(await finding.evaluate((n:HTMLElement)=>(n.parentElement as HTMLDetailsElement).open));assert.match(await page.locator("#overview .overview-evidence").first().innerText(),/#\d+/);}
 report.assessmentText=await page.locator("#overview").innerText();await page.screenshot({path:`${out}/assessment-laptop.png`});
 await page.setViewportSize({width:390,height:844});await page.locator("#overview").scrollIntoViewIfNeeded();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`${out}/assessment-narrow.png`});
 await page.setViewportSize({width:1366,height:768});
 // Force close the actual state socket, capture disconnection, then let the built-in reconnect restore it.
 assert.ok(sockets.size>0,"A real subscription socket must be intercepted for reconnect verification");
 const socketCount=sockets.size;
 for(const socket of [...sockets])socket.close({code:1012,reason:"Judge reconnect check"});
 await page.waitForFunction(()=>document.querySelector("#live")?.textContent!=="Live");
 await wait(async()=>sockets.size>=socketCount,20000);
 await page.waitForFunction(()=>document.querySelector("#live")?.textContent==="Live");
 await page.reload();await page.waitForFunction(()=>document.body.dataset.role==="observer"&&document.querySelector("#live")?.textContent==="Live");
 await page.waitForFunction((coverage:string)=>document.querySelector("#overview")?.textContent?.includes(coverage),`${report.assessment.tested} of 200`);
 report.checks.push("Observer reads both teams' measured attempts, unique coverage and evidence links; private tables and every mutation tested are denied; narrow layout and reload preserve assessment");
 // Stop punctuation needs no paid call, including when a real reservation is still pending.
 if(await calls()<=remaining-33){const pending=await send("attacker","Assess drone 3 for command entry in this synthetic simulation.",false);await wait(async()=> (await rows("hosted_job")).some(j=>j.turn===pending.admitted!.id&&j.state==="running"),5000);
  const current=(await clients.attacker.query("SELECT * FROM visible_fleet_session"))[0];
  // Use the granted intent API immediately so browser rendering cannot outlast the observed inference.
  await clients.attacker.call("send_maincloud_message",[randomUUID(),"Stop.",0,current.epoch,current.conversation]);
  pending.flow.cancellationSource="Scoped intent reducer while a real provider reservation was observed running";
  await wait(async()=> {const turn=(await rows("backend_chat_turn")).find(t=>t.id===pending.admitted!.id);const ops=(await rows("backend_chat")).filter(o=>JSON.parse(o.config).turnId===pending.admitted!.id);return turn.state==="cancelled"||ops.length>0&&ops.every(o=>o.state==="cancelled");},5000);
  await wait(async()=>!(await rows("hosted_job")).some(j=>j.state==="running"),22000);pending.flow.cancelled=true;
  assert.ok(!(await rows("backend_chat")).some(o=>JSON.parse(o.config).turnId===pending.admitted!.id&&o.state==="running"));
  await page.waitForFunction(()=>document.querySelector("#transcript")?.textContent?.includes("Stopped your pending work"));

 }
 const jobs=await rows("hosted_job");report.actualBitdeerRequests=jobs.filter(j=>j.started>0).length;assert.ok(report.actualBitdeerRequests+prior<=100);
 report.inferences=(await rows("hosted_record")).map(r=>JSON.parse(r.body)).filter(r=>r.type==="inference");
 report.coordinators=(await rows("backend_chat_turn")).map(t=>({id:t.id,role:t.role,state:t.state,metric:JSON.parse(t.result).metric}));
 report.chain={request:attackFlow.message,turn:attackTurn!.id,operation:attack.id,assignments:attackResult.config.tasks,decisions:jobs.filter(j=>j.operation===attack.id&&j.agent>0&&j.started>0).map(j=>({id:j.id,agent:j.agent,target:j.target,state:j.state,decision:JSON.parse(j.result||"null")})),attempts:state.attempts.filter((a:any)=>a.operation===attack.id),evidence:state.events.filter((e:any)=>attackResult.config.tasks.some((t:any)=>t.agentId===e.actor))};
 report.budgets=await rows("hosted_budget");assert.ok(report.budgets.every((b:any)=>b.calls<=33));
 assert.ok(jobs.every(j=>j.agent===0||j.step<=8));assert.deepEqual(report.errors,[]);
 report.checks.push("Actual Bitdeer decisions → validated scheduled attempts → persisted evidence → UI and assessment; original call, concurrency and deadline limits retained; Stop. fences a running provider result");report.passed=true;
} catch(error){report.error=error instanceof Error?error.stack:String(error);process.exitCode=1;}
finally {
 for(const client of Object.values(clients)){try{const s=(await client.query("SELECT * FROM visible_fleet_session"))[0];await client.call("send_maincloud_message",[randomUUID(),"Stop.",0,s.epoch,s.conversation]);}catch{}}
 await wait(async()=>!(await rows("hosted_job")).some(j=>j.state==="running"),22000).catch(()=>{});
 report.retainedInferences=(await rows("hosted_record")).map(r=>JSON.parse(r.body)).filter(r=>r.type==="inference");
 report.budgets=await rows("hosted_budget");
 report.totalOvernightRequests=prior+(await calls());
 report.actualBitdeerRequests=await calls().catch(()=>report.actualBitdeerRequests??null);
 // Never save credentials, provider prompts, raw response envelopes or browser traces.
 await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
 console.log(JSON.stringify({passed:report.passed,error:report.error,calls:report.actualBitdeerRequests,checks:report.checks,flows:report.flows.map((f:any)=>({message:f.message,state:f.state??f.turnState,ackMs:f.ackMs,firstMeaningfulMs:f.firstMeaningfulMs,terminalMs:f.terminalMs,mission:f.mission}))}));
 await browser?.close();if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}await db.close();
}
