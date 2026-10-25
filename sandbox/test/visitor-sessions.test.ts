import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { setTimeout as delay } from "node:timers/promises";
import { testDatabase } from "./spacetime-helper.ts";
import { FLEET } from "../../shared/fleet.ts";

test("isolated visitors through two browsers and real SpacetimeDB (Fixture decisions)", { skip: !process.env.SPACETIME_BINARY, timeout:180000 }, async t => {
  execFileSync("cargo", ["build","--manifest-path","arena-live/Cargo.toml","--target","wasm32-unknown-unknown","--release","--features","mission-fixtures","--target-dir","arena-live/target/mission-fixtures"],{stdio:"pipe"});
  await build({entryPoints:["web/fleet.ts"],bundle:true,format:"esm",outfile:"output/visitor-test/fleet.js"});
  const db = await testDatabase("arena-live/target/mission-fixtures/wasm32-unknown-unknown/release/sudoko_live.wasm");
  t.after(() => db.close());
  const {SPACETIME_URI:uri,SPACETIME_DATABASE:database,SPACETIME_TOKEN:owner}=db.env;
  const sql=async(token:string,statement:string)=>{
    const r=await fetch(`${uri}/v1/database/${database}/sql`,{method:"POST",headers:{authorization:`Bearer ${token}`},body:statement});
    if(!r.ok)throw Error(await r.text());const [result]=await r.json();if(!result)return [];const names=result.schema.elements.map((e:any)=>e.name.some);return result.rows.map((row:any[])=>Object.fromEntries(row.map((v:any,i:number)=>[names[i],v])));
  };
  const call=async(token:string,name:string,args:unknown[]=[])=>{
    const r=await fetch(`${uri}/v1/database/${database}/call/${name}`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(args)});
    if(!r.ok)throw Error(`${name}: ${await r.text()}`);
  };
  const rows=(table:string)=>sql(owner,`SELECT * FROM ${table}`);
  const identity=(hex:string)=>({__identity__:`0x${hex}`});
  const wait=async(check:()=>Promise<any>,ms=15000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=await check();if(v)return v;await delay(100)}throw Error("Visitor assertion timed out");};
  const server=createServer(async(req,res)=>{
    try {
      const path=new URL(req.url!,"http://localhost").pathname;
      if(path==="/fleet-config"){res.setHeader("content-type","application/json");res.end(JSON.stringify({maincloud:true,visitorSessions:true,uri,database,sandbox:database,authenticated:true,demo:true,chat:true,engine:"mocked"}));return;}
      const file=path==="/"?"web/fleet.html":path==="/fleet.js"?"output/visitor-test/fleet.js":"web"+path;
      res.setHeader("content-type",path.endsWith(".js")?"text/javascript":path.endsWith(".css")?"text/css":"text/html");res.end(await readFile(file));
    } catch {res.writeHead(404);res.end();}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url=`http://127.0.0.1:${(server.address() as any).port}`;
  const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,headless:true,args:["--no-sandbox","--enable-unsafe-swiftshader"]});
  const contexts=await Promise.all([browser.newContext({viewport:{width:1365,height:900}}),browser.newContext({viewport:{width:1365,height:900}})]);
  const pages=await Promise.all(contexts.map(c=>c.newPage()));
  const errors:string[]=[];pages.forEach(p=>p.on("pageerror",e=>errors.push(e.message)));
  try {
    for(const p of pages) {
      await p.goto(url);await p.locator("#continue").waitFor({state:"visible"});
      assert.equal((await rows("fleet_drone")).length,0,"Entry does not connect to or initialize the legacy fleet");
    }
    await mkdir("output/visitor-test",{recursive:true});
    await pages[0].screenshot({path:"output/visitor-test/entry-desktop.png"});
    await pages[1].setViewportSize({width:390,height:844});await pages[1].screenshot({path:"output/visitor-test/entry-mobile.png"});
    await Promise.all(pages.map(p=>p.locator("#continue").click()));
    await Promise.all(pages.map(p=>p.locator("#entry").waitFor({state:"hidden"})));
    const saved=await Promise.all(pages.map(p=>p.evaluate(()=>JSON.parse(sessionStorage.getItem("sudoko.visitor.v1")!))));
    const [a,b]=saved;assert.ok(a.id&&b.id&&a.id!==b.id);
    assert.equal((await rows("visitor_session")).length,2);assert.equal((await rows("fleet_drone")).length,2*FLEET.drones);
    assert.equal((await rows("fleet_agent")).length,0);
    for(const session of saved){
      await Promise.all([call(session.roles.attacker.token,"create_visitor_session",[identity(session.roles.defender.identity),identity(session.roles.observer.identity)]),call(session.roles.attacker.token,"create_visitor_session",[identity(session.roles.defender.identity),identity(session.roles.observer.identity)])]);
      assert.equal((await sql(session.roles.defender.token,"SELECT * FROM visible_drones")).length,FLEET.drones);
      assert.deepEqual(await sql(session.roles.attacker.token,"SELECT * FROM visible_drones"),[]);
    }
    assert.equal((await rows("visitor_session")).length,2,"Unknown-result retries reuse the same atomic fleet");
    const state=async(s:any,role="attacker")=>(await sql(s.roles[role].token,"SELECT * FROM visible_fleet_session"))[0];
    const send=async(s:any,key:string,message:string)=>{const x=await state(s);await call(s.roles.attacker.token,"send_maincloud_message",[key,message,0,x.epoch,x.conversation]);return (await rows("backend_chat_turn")).find((t:any)=>t.session_id===s.id&&t.request_key.endsWith(key));};
    const local=(s:any,id:string)=>id.replace(`visitor:${s.id}:`,"");
    const reserve=(s:any,id:string)=>call(owner,"fixture_visitor_reserve",[s.id,local(s,id)]);
    const reply=(s:any,id:string,value:any)=>call(owner,"fixture_visitor_reply",[s.id,local(s,id),JSON.stringify(value),""]);
    const plan={intent:"deploy",answer:"Fixture: discover the selected synthetic drone.",evidenceIds:[],tasks:[{name:"Scout One",specialty:"recon",target:1,targets:[1],objective:"Verify discovery",goal:"recon"}]};
    const turn=await send(a,"same-key","A private objective");await reserve(a,turn.id);await reply(a,turn.id,plan);
    const worker=(await rows("hosted_job")).find((j:any)=>j.session_id===a.id&&j.agent>0);assert.ok(worker);
    await reserve(a,worker.id);
    assert.ok((await sql(a.roles.attacker.token,"SELECT * FROM visible_evidence")).length>0);
    for(const table of ["visible_chat_messages","visible_chat_operations","visible_chat_turns","visible_agents","visible_evidence","visible_attempt_activity","visible_agent_tasks"]){assert.deepEqual(await sql(b.roles.observer.token,`SELECT * FROM ${table}`),[],`B never sees A's ${table}`);}
    assert.equal((await sql(b.roles.defender.token,"SELECT * FROM visible_drones")).length,FLEET.drones);
    const bt=await send(b,"same-key","B private objective");await reserve(b,bt.id);await reply(b,bt.id,{intent:"answer",answer:"Fixture: B's independent answer.",evidenceIds:[],tasks:[]});
    assert.ok((await sql(b.roles.attacker.token,"SELECT * FROM visible_chat_messages")).some((m:any)=>m.text.includes("B private")));
    assert.ok((await sql(a.roles.attacker.token,"SELECT * FROM visible_chat_messages")).every((m:any)=>!m.text.includes("B private")));
    await pages[0].reload();await pages[0].locator("#entry").waitFor({state:"hidden"});
    assert.equal(await pages[0].evaluate(()=>JSON.parse(sessionStorage.getItem("sudoko.visitor.v1")!).id),a.id);
    for(const role of ["defender","observer","attacker"]){await pages[0].locator(`nav button[data-role="${role}"]`).click();await wait(async()=>await pages[0].getAttribute("body","data-role")===role);assert.equal((await state(a,role)).session_id,a.id);}
    const pending=await send(a,"delayed","A delayed fixture reply");await reserve(a,pending.id);
    const beforeB=await state(b), messagesB=await sql(b.roles.attacker.token,"SELECT * FROM visible_chat_messages"),dronesB=await sql(b.roles.defender.token,"SELECT * FROM visible_drones");
    const sa=await state(a,"defender");await call(a.roles.defender.token,"reset_maincloud_fleet",[sa.epoch,false]);
    await assert.rejects(reply(a,pending.id,plan));
    assert.equal((await rows("fleet_agent")).filter((r:any)=>r.session_id===a.id).length,0);
    assert.equal((await state(b)).epoch,beforeB.epoch);assert.deepEqual(await sql(b.roles.attacker.token,"SELECT * FROM visible_chat_messages"),messagesB);
    const stable=(ds:any[])=>ds.map(({id,controller,policy_version,isolated}:any)=>({id,controller,policy_version,isolated}));
    assert.deepEqual(stable(await sql(b.roles.defender.token,"SELECT * FROM visible_drones")),stable(dronesB));
    const aop=(await sql(a.roles.attacker.token,"SELECT * FROM visible_chat_operations"))[0];
    await assert.rejects(call(b.roles.attacker.token,"execute_fleet_chat_action",["maincloud",aop.id,1,1,1,"discover",0]));
    await assert.rejects(call(b.roles.defender.token,"reset_maincloud_fleet",[sa.epoch+99,true]));
    await assert.rejects(call(a.roles.observer.token,"reset_maincloud_fleet",[(await state(a,"observer")).epoch,true]));
    await assert.rejects(call(a.roles.observer.token,"send_maincloud_message",["forged","Deploy attackers",1,(await state(a,"observer")).epoch,1]));
    for(const table of ["fleet_drone","hosted_job","backend_chat","visitor_session"]){await assert.rejects(sql(a.roles.attacker.token,`SELECT * FROM ${table}`));}
    await assert.rejects(call(a.roles.attacker.token,"create_visitor_session",[b.roles.defender.identity,b.roles.observer.identity]));
    await assert.rejects(call(a.roles.attacker.token,"drone_tick",[{id:4096*b.id+1,scheduled_at:{Interval:200000},epoch:1,session_id:b.id}]));
    const anonymous:any=await fetch(`${uri}/v1/identity`,{method:"POST"}).then(r=>r.json());
    assert.deepEqual(await sql(anonymous.token,"SELECT * FROM visible_drones"),[]);await assert.rejects(call(anonymous.token,"reset_maincloud_fleet",[1,true]));
    // Expiration fences admission immediately, then scheduled cleanup removes only A.
    await call(owner,"fixture_age_visitor",[a.id]);await assert.rejects(call(a.roles.attacker.token,"heartbeat_visitor_session"));
    await wait(async()=> (await rows("visitor_session")).find((s:any)=>s.id===a.id)?.closed,40000);
    await pages[0].reload();await pages[0].locator("#entry").waitFor({state:"visible"});
    assert.equal(await pages[0].evaluate(()=>sessionStorage.getItem("sudoko.visitor.v1")),null);
    await wait(async()=>!(await rows("fleet_drone")).some((d:any)=>d.session_id===a.id),40000);
    assert.equal((await sql(b.roles.defender.token,"SELECT * FROM visible_drones")).length,FLEET.drones);
    assert.equal((await rows("fleet_session")).some((s:any)=>s.session_id===0),false,"No missing credential path creates the shared fleet");
    assert.deepEqual(errors,[]);
    await writeFile("output/visitor-test/report.json",JSON.stringify({source:"Fixture decisions",sessions:2,dronesPerSession:FLEET.drones,checks:["atomic admission and retry","two browser contexts","session-private chat agents evidence results","session reset and delayed completion fencing","refresh and role switches","cross-session and observer denials","anonymous denial","idle expiration and cleanup"]},null,2));
  } finally {
    await browser.close();
  }
});
