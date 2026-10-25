import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { testDatabase } from "./spacetime-helper.ts";
import { RunStore } from "../src/run-store.ts";

test("populated hosted schema upgrades and backfills without clearing data", {skip:!process.env.SPACETIME_BINARY||!process.env.MIGRATION_FROM_WASM,timeout:30000},async()=>{
  const db=await testDatabase(process.env.MIGRATION_FROM_WASM);
  const owner=new RunStore({uri:db.env.SPACETIME_URI,database:db.env.SPACETIME_DATABASE,token:db.env.SPACETIME_TOKEN});
  const rows=(table:string):Promise<any[]>=>owner.query("SELECT * FROM "+table);
  const call=(name:string,args:unknown[])=>owner.call(name,args);
  try {
    const identity:any=await fetch(db.env.SPACETIME_URI+"/v1/identity",{method:"POST"}).then(r=>r.json());
    const viewer=new RunStore({uri:db.env.SPACETIME_URI,database:db.env.SPACETIME_DATABASE,token:identity.token});
    await call("grant_fleet_view",[identity.identity,"attacker"]);await call("start_fleet",[32,0,0,false]);
    const session=randomUUID(),turn=randomUUID(),id=randomUUID(),epoch=(await rows("fleet_session"))[0].epoch;
    await call("acquire_backend",[session,2,2]);
    const config={epoch,conversation:1,message:"Inspect two synthetic targets",target:null,createdAt:Date.now(),deadline:Date.now()+70000,maxDecisionsPerAgent:8,maxModelCalls:33,turnId:turn,scopes:{"1":[1,3],"2":[2]}};
    await call("create_chat_turn",[session,turn,"legacy-turn","attacker",JSON.stringify({...config,deadline:Date.now()+29000})]);
    await call("update_chat_turn",[session,turn,"running","{}",""]);
    await call("create_chat_operation",[session,id,"hosted:"+turn,"attacker",epoch,JSON.stringify(config)]);
    const tasks=[1,2].map(agentId=>({agentId,name:"Scout "+agentId,specialty:"recon",target:agentId,goal:"recon",objective:"Inspect the assigned target"}));
    await call("plan_chat_operation",[session,id,JSON.stringify(tasks)]);
    for(const task of tasks)await call("execute_fleet_chat_action",[session,id,1,task.agentId,task.target,"discover",0]);
    const receipts=await rows("fleet_chat_action");
    const records=tasks.flatMap(t=>[{type:"worker",agentId:t.agentId,target:t.target,state:"completed",reason:"Measured discovery",at:Date.now()},{agentId:t.agentId,target:t.target,actionId:`${id}:${t.agentId}:1`,kind:"discover",status:"executed",evidenceId:receipts.find(r=>r.key===`${id}:${t.agentId}:1`)!.evidence_id}]);
    await call("update_chat_operation",[session,id,"completed",JSON.stringify(records)]);
    const before={operation:(await rows("backend_chat"))[0],messages:await rows("backend_chat_message"),turns:await rows("backend_chat_turn"),evidence:await rows("fleet_evidence"),grants:await rows("fleet_principal")};
    await db.upgrade("arena-live/target/wasm32-unknown-unknown/release/sudoko_live.wasm");
    assert.equal((await rows("backend_chat"))[0].result,before.operation.result,"Publish alone preserves legacy authority");
    const args=[[id],[turn],before.messages.map(m=>m.id)];
    await call("migrate_hosted_workflow",args);await call("migrate_hosted_workflow",args);
    const op=(await rows("backend_chat"))[0];assert.equal(op.result,"[]");assert.equal(op.generation,1);
    for(const key of ["tasks","completionConditions","deadline","conversation"])assert.equal(JSON.parse(op.config)[key],undefined);
    const assignments=await rows("hosted_assignment");assert.equal(assignments.length,2);assert.deepEqual(assignments.find(a=>a.agent===1).targets,[1,3],"Legacy approved alternatives survive normalization");assert.ok(assignments.every(a=>a.operation===id&&a.epoch===epoch&&a.generation===1&&a.state==="completed"));
    assert.deepEqual((await rows("hosted_record")).sort((a,b)=>a.sequence-b.sequence).map(r=>JSON.parse(r.body)),records,"Backfill preserves all historical records");
    assert.deepEqual(await rows("fleet_evidence"),before.evidence);assert.deepEqual(await rows("fleet_principal"),before.grants);
    assert.deepEqual((await rows("backend_chat_message")).map(({epoch,generation,...m})=>m).sort((a,b)=>a.id-b.id),before.messages.sort((a,b)=>a.id-b.id));
    const visible=(await viewer.query("SELECT * FROM visible_chat_operations"))[0];assert.equal(visible.id,id);assert.equal(JSON.parse(visible.config).tasks.length,2);
    assert.equal((await viewer.query("SELECT * FROM visible_chat_messages")).length,before.messages.length);
    for(const table of ["hosted_assignment","hosted_record","hosted_workflow"])await assert.rejects(viewer.query("SELECT * FROM "+table));
    await assert.rejects(viewer.call("migrate_hosted_workflow",args));
    await db.restart();assert.deepEqual(await viewer.query("SELECT * FROM visible_chat_operations"),[visible]);
    await viewer.call("new_maincloud_chat",[epoch,1]);assert.deepEqual(await viewer.query("SELECT * FROM visible_chat_operations"),[]);assert.deepEqual(await viewer.query("SELECT * FROM visible_chat_messages"),[]);
    assert.equal((await rows("hosted_record")).length,records.length,"New chat hides history without erasing it");
  }finally{await db.close();}
});
