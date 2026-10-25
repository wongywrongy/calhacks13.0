import test from "node:test";
import assert from "node:assert/strict";
import { overviewRecords, type OverviewFrame } from "../../web/fleet-overview.ts";

const frame = (): OverviewFrame => ({
  drones:[1,2,3].map(id=>({id,controller:"defender",isolated:false,policy_version:1})),
  battle:[1,2,3].map(drone=>({drone,contamination:0,operational:true})),attempts:[],events:[],tasks:[],
});
const event=(id:number,drone:number,kind:string,status=200,at=id)=>({id,drone,kind,status,at,actor:1,policy_version:1});
test("overview keeps empty sessions unknown and uses actual fleet size",()=>{
  const a=overviewRecords(frame());assert.equal(a.tested,0);assert.equal(a.untested,3);assert.equal(a.incidents.length,0);
  assert.ok(a.cells.every(c=>c.now==="untested"));
});
test("spread groups evidence, partial impact stays open, and recovery needs both paired checks",()=>{
  const f=frame();f.drones[0].controller="attacker";f.battle[1].contamination=35;
  f.events=[event(1,1,"unauthorized_command_accepted"),event(2,2,"limited_access",206),event(3,3,"unauthorized_command_blocked",403)];
  f.attempts=[{key:"spread-1",epoch:1,operation:"test",role:"attacker",agent:1,target:1,kind:"spread",stage:"resolved",at:1,report:JSON.stringify({results:[1,2,3].map(target=>({target,eligible:true,evidenceIds:[target]}))})}];
  let a=overviewRecords(f);assert.equal(a.incidents.length,1);assert.equal(a.open,1);assert.equal(a.everAffected,2);assert.equal(a.tested,3);
  assert.equal(a.cells[0].now,"compromised");assert.equal(a.cells[1].now,"partial");assert.equal(a.cells[2].now,"blocked");
  f.events.push(event(4,1,"policy_applied"),event(5,1,"recovery_verified"));
  assert.equal(overviewRecords(f).open,1,"Unpaired recovery label cannot close an incident");
  for(const drone of [1,2]) {
    const at=100+drone;
    f.events.push(event(10+drone*3,drone,"verification_unauthorized",403,at),event(11+drone*3,drone,"verification_authorized",200,at),event(12+drone*3,drone,"recovery_verified",200,at));
    f.drones[drone-1].controller="defender";f.battle[drone-1].contamination=0;
  }
  a=overviewRecords(f);assert.equal(a.open,0);assert.equal(a.verifiedRecoveries,2);assert.equal(a.cells[0].now,"recovered");assert.equal(a.cells[0].session,"affected");
  assert.equal(overviewRecords({...f,events:[...f.events,...f.events]}).incidents.length,1,"Replay deduplicates IDs");
});
test("later recovery resolves repeated attacks and a new compromise opens a fresh incident",()=>{
  const f=frame();f.events=[event(1,1,"unauthorized_command_accepted"),event(2,1,"unauthorized_command_accepted"),event(3,1,"verification_unauthorized",403,10),event(4,1,"verification_authorized",200,10),event(5,1,"recovery_verified",200,10)];
  assert.equal(overviewRecords(f).open,0);
  f.events.push(event(6,1,"unauthorized_command_accepted"));assert.equal(overviewRecords(f).open,1);
  f.events.push(event(7,99,"unauthorized_command_accepted"));assert.equal(overviewRecords(f).everAffected,1,"Unknown drones are excluded");
});
