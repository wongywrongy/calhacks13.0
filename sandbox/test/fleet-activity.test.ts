import test from "node:test";
import assert from "node:assert/strict";
import { attemptOutcome, groupActivity, stateSuggestions, taskActive, type AttemptActivity } from "../../web/fleet-activity.ts";
import {goalActions,goalSatisfied,validGoal} from "../src/fleet-goals.ts";
const attempt=(report:any,kind="spread"):AttemptActivity=>({key:"op:1:1",epoch:1,operation:"op",role:"attacker",agent:1,target:18,kind,stage:"resolved",at:1000,report:JSON.stringify(report)});
const initial=()=>({role:"attacker",selected:0,drones:[{id:18,controller:"attacker",isolated:false},{id:19,controller:"defender",isolated:false}],battle:[{drone:19,contamination:40,operational:true,readiness:0}],options:[{role:"attacker",drone:18,actions:["spread"],reachable:[19],blocker:""}],teams:[],attempts:[] as AttemptActivity[]});
test("suggestions track foothold, isolation, failure and recovery without offering invalid or duplicate operations",()=>{
 const s=initial();
 assert.ok(stateSuggestions(s).some(o=>o.text==="Attempt spread through DR-018"));
 s.options[0].actions=[];s.options[0].reachable=[];s.drones[0].isolated=true;s.attempts=[attempt({summary:"Attempt interrupted: relay isolated",succeeded:0})];
 assert.ok(!stateSuggestions(s).some(o=>o.text.startsWith("Attempt spread")));
 assert.ok(stateSuggestions(s).some(o=>o.text==="Which alternative connections remain?"));
 const defending={...initial(),role:"defender",drones:[{id:19,controller:"defender",isolated:true}],options:[{role:"defender",drone:19,actions:["verify"],reachable:[],blocker:""}]};
 assert.ok(stateSuggestions(defending).some(o=>o.text==="Attempt recovery on DR-019"));
 defending.battle[0].contamination=0;defending.options[0].actions=["release"];
 const clean=stateSuggestions(defending);assert.ok(clean.some(o=>o.text.includes("return DR-019")));assert.ok(!clean.some(o=>o.text.includes("recovery")));
 const active={...s,teams:[{role:"attacker",operation:"op",objective:"Spread",targets:[18],stage:"attempt",summary:"Attempt in progress",active_agents:1}]};
 assert.ok(stateSuggestions(active).every(o=>!o.text.startsWith("Attempt")));assert.equal(stateSuggestions(active).length,2);
});
test("meaningful outcomes are prominent; repeated failures and routine details are grouped",()=>{
 const result=attemptOutcome(attempt({summary:"One compromised; two resisted",succeeded:1,results:[{beforeController:"defender",controller:"attacker",beforeContamination:0,contamination:100,evidenceIds:[1,2],openedRoutes:[3]}]}));
 assert.equal(result.major,true);assert.equal(result.label,"Control changed");assert.deepEqual(result.evidenceIds,[1,2]);
 assert.equal(attemptOutcome(attempt({summary:"Attempt interrupted: isolated",succeeded:0})).label,"Interrupted");
 const groups=groupActivity([{major:true,group:"changed"},{major:true,group:"failed"},{major:true,group:"failed"},{major:false,group:"routine"}]);
 assert.equal(groups.find(g=>g.key==="changed")?.collapsed,false);assert.equal(groups.find(g=>g.key==="failed")?.items.length,2);assert.equal(groups.find(g=>g.key==="routine")?.collapsed,true);
});
test("typed objectives bound reassessment and terminal tasks leave the active roster",()=>{
 assert.ok(validGoal("attacker","spread"));assert.ok(!validGoal("defender","capture"));
 assert.deepEqual(goalActions("defender","contain",["prepare","isolate","verify","release"]),["prepare","isolate"]);
 assert.equal(goalSatisfied("recover",{controller:"defender",isolated:true},{contamination:40},true,{}),false);
 assert.equal(goalSatisfied("recover",{controller:"defender",isolated:true},{contamination:0},true,{}),true);
 assert.equal(goalSatisfied("restore",{controller:"defender",isolated:true},{contamination:0},true,{}),false);
 for(const state of ["completed","failed","cancelled"])assert.equal(taskActive({state} as any),false);
 for(const state of ["queued","running"])assert.equal(taskActive({state} as any),true);
});
