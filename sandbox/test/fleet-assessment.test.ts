import test from "node:test";
import assert from "node:assert/strict";
import { fleetAssessment } from "../../web/fleet-assessment.ts";
import type { AttemptActivity } from "../../web/fleet-activity.ts";

test("assessment counts unique tested targets, current impact and paired recovery without certifying untested drones", () => {
  const drones=[1,2,3,4].map(id=>({id,controller:id===1?"attacker":"defender",isolated:id===2,policy_version:1}));
  const battle=drones.map(d=>({drone:d.id,contamination:d.id===1?100:0,operational:!d.isolated}));
  const attempt=(key:string,results:any[],extra:any={}):AttemptActivity=>({key,epoch:1,operation:"mission",role:"attacker",agent:1,target:1,kind:"spread",stage:"resolved",at:1,report:JSON.stringify({results}),...extra});
  const attempts=[attempt("a",[{target:1,eligible:true},{target:2,eligible:true}]),attempt("b",[{target:1,eligible:true},{target:3,eligible:false}]),attempt("c",[{target:4,eligible:true}],{stage:"executing"})];
  const event=(id:number,kind:string,status=200)=>({id,drone:2,actor:9,kind,status,policy_version:1,at:100});
  const events=[event(1,"policy_applied"),event(2,"recovery_verified")];
  const frame={drones,battle,attempts,events,tasks:[]};
  assert.equal(fleetAssessment(frame).paired,0,"A recovery label alone is not paired verification");
  events.push(event(3,"verification_unauthorized",403),event(4,"verification_authorized"));
  const result=fleetAssessment(frame);
  assert.equal(result.tested,2);assert.equal(result.untested,2);assert.equal(result.exposed,1);assert.equal(result.isolated,1);assert.equal(result.available,3);assert.equal(result.paired,1);
  assert.equal(result.findings.length,1);assert.equal(result.findings[0].id,2);assert.match(result.next,/Defend/);
  drones[1].policy_version=2;assert.equal(fleetAssessment(frame).paired,0,"A newer policy needs fresh verification");assert.equal(fleetAssessment(frame).verifiedRecoveries,1,"A release or newer policy preserves historical paired evidence");
});

test("empty, failed and interrupted work never becomes coverage or security success", () => {
  const result=fleetAssessment({drones:[{id:1,controller:"defender",isolated:false,policy_version:0}],battle:[],attempts:[],events:[],tasks:[]});
  assert.equal(result.tested,0);assert.equal(result.untested,1);assert.equal(result.paired,0);assert.equal(result.available,0);assert.match(result.next,/unknown/);
});

test("clean isolation still requires restoring participation", () => {
  const result=fleetAssessment({drones:[{id:1,controller:"defender",isolated:true,policy_version:1}],battle:[{drone:1,contamination:0,operational:false}],attempts:[],events:[],tasks:[]});
  assert.equal(result.exposed,0);assert.equal(result.available,0);assert.match(result.next,/return clean isolated drones/);
});

test("repeated retained history does not inflate coverage or finding counts", () => {
  const drones=Array.from({length:200},(_,i)=>({id:i+1,controller:"defender",isolated:false,policy_version:0}));
  const events=Array.from({length:12800},(_,i)=>({id:i+1,drone:i%200+1,actor:1,at:i,policy_version:0,kind:"unauthorized_command_blocked",status:403}));
  const result=fleetAssessment({drones,battle:[],events,attempts:[],tasks:[]});
  assert.equal(result.findings.length,200);assert.equal(result.findings[0].id,12800);assert.equal(result.untested,200);assert.equal(result.verifiedRecoveries,0);
});
