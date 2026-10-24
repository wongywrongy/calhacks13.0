//! Independent synthetic fleet. Private tables; identity-scoped subscription views.
use spacetimedb::{table,reducer,view,Identity,ReducerContext,ViewContext,Table,ScheduleAt};
use std::time::Duration;
#[table(accessor=fleet_principal)]
pub struct Principal { #[primary_key] identity:Identity, role:String }
#[table(accessor=fleet_session)]
pub struct Session { #[primary_key] id:u32, epoch:u64, active:bool, hardened:bool, drones:u32, deadline:i64 }
#[table(accessor=fleet_drone)]
#[derive(Clone)]
pub struct Drone { #[primary_key] id:u32, #[index(btree)] epoch:u64, x:f32,y:f32,z:f32, battery:f32, tick:u32, controller:String, isolated:bool, policy_version:u32, commands:u32, rejected:u32 }
#[table(accessor=fleet_agent)]
#[derive(Clone)]
pub struct Agent { #[primary_key] id:u32, #[index(btree)] epoch:u64, role:String, step:u32, target:u32, last_action:String }
#[table(accessor=fleet_evidence)]
#[derive(Clone)]
pub struct Evidence { #[primary_key] #[auto_inc] id:u64, #[index(btree)] epoch:u64, at:i64, actor:u32, drone:u32, kind:String, status:u32, policy_version:u32 }
#[table(accessor=fleet_discovery)]
pub struct Discovery { #[primary_key] drone:u32, epoch:u64 }
#[table(accessor=drone_schedule,scheduled(drone_tick))]
pub struct DroneSchedule { #[primary_key] id:u64, scheduled_at:ScheduleAt, epoch:u64 }
#[table(accessor=agent_schedule,scheduled(agent_tick))]
pub struct AgentSchedule { #[primary_key] id:u64, scheduled_at:ScheduleAt, epoch:u64 }
fn owner(ctx:&ReducerContext)->Result<(),String>{
 if ctx.db.publisher().id().find(0).map(|p|p.identity)!=Some(ctx.sender()){return Err("Owner required".into())} Ok(())
}
use crate::publisher;
fn emit(ctx:&ReducerContext,epoch:u64,actor:u32,d:&Drone,kind:&str,status:u32){ctx.db.fleet_evidence().insert(Evidence{id:0,epoch,at:ctx.timestamp.to_micros_since_unix_epoch(),actor,drone:d.id,kind:kind.into(),status,policy_version:d.policy_version});}
#[reducer]
pub fn grant_fleet_view(ctx:&ReducerContext,identity:String,role:String)->Result<(),String>{owner(ctx)?;let identity=Identity::from_hex(identity).map_err(|_|"Invalid identity")?;if !["attacker","defender","observer"].contains(&role.as_str()){return Err("Invalid role".into())} if ctx.db.fleet_principal().identity().find(identity).is_some(){ctx.db.fleet_principal().identity().update(Principal{identity,role});}else{ctx.db.fleet_principal().insert(Principal{identity,role});} Ok(())}
#[reducer]
pub fn start_fleet(ctx:&ReducerContext,drones:u32,attackers:u32,defenders:u32,hardened:bool)->Result<(),String>{
 owner(ctx)?;if !(1..=256).contains(&drones)||!(1..=32).contains(&attackers)||!(1..=32).contains(&defenders){return Err("Fleet/agent limits exceeded".into())}
 let epoch=ctx.db.fleet_session().id().find(0).map(|s|s.epoch+1).unwrap_or(1);
 for d in ctx.db.drone_schedule().iter(){ctx.db.drone_schedule().id().delete(d.id);} for a in ctx.db.agent_schedule().iter(){ctx.db.agent_schedule().id().delete(a.id);}
 for d in ctx.db.fleet_drone().iter(){ctx.db.fleet_drone().id().delete(d.id);}for a in ctx.db.fleet_agent().iter(){ctx.db.fleet_agent().id().delete(a.id);}for e in ctx.db.fleet_evidence().iter(){ctx.db.fleet_evidence().id().delete(e.id);}for d in ctx.db.fleet_discovery().iter(){ctx.db.fleet_discovery().drone().delete(d.drone);}
 ctx.db.fleet_session().id().delete(0);ctx.db.fleet_session().insert(Session{id:0,epoch,active:true,hardened,drones,deadline:ctx.timestamp.to_micros_since_unix_epoch()+60_000_000});
 for id in 1..=drones{ctx.db.fleet_drone().insert(Drone{id,epoch,x:((id-1)%16) as f32*6.,y:((id-1)/16) as f32*7.,z:8.+(id%5) as f32,battery:100.,tick:0,controller:"defender".into(),isolated:hardened,policy_version:0,commands:0,rejected:0});ctx.db.drone_schedule().insert(DroneSchedule{id:id as u64,epoch,scheduled_at:Duration::from_millis(180+(id%7) as u64*20).into()});}
 for id in 1..=attackers+defenders{let role=if id<=attackers{"attacker"}else{"defender"};ctx.db.fleet_agent().insert(Agent{id,epoch,role:role.into(),step:0,target:(id-1)%drones+1,last_action:"ready".into()});ctx.db.agent_schedule().insert(AgentSchedule{id:id as u64,epoch,scheduled_at:Duration::from_millis(350+(id%9) as u64*37).into()});}Ok(())
}
#[reducer]
pub fn stop_fleet(ctx:&ReducerContext)->Result<(),String>{owner(ctx)?;if let Some(mut s)=ctx.db.fleet_session().id().find(0){s.active=false;ctx.db.fleet_session().id().update(s);} for t in ctx.db.drone_schedule().iter(){ctx.db.drone_schedule().id().delete(t.id);}for t in ctx.db.agent_schedule().iter(){ctx.db.agent_schedule().id().delete(t.id);}Ok(())}
fn live(ctx:&ReducerContext,epoch:u64)->bool{ctx.db.fleet_session().id().find(0).map(|s|s.active&&s.epoch==epoch&&ctx.timestamp.to_micros_since_unix_epoch()<s.deadline).unwrap_or(false)}
#[reducer]
pub fn drone_tick(ctx:&ReducerContext,timer:DroneSchedule){if ctx.sender()!=ctx.database_identity(){panic!("Scheduler only")}if !live(ctx,timer.epoch){ctx.db.drone_schedule().id().delete(timer.id);return}if let Some(mut d)=ctx.db.fleet_drone().id().find(timer.id as u32){d.tick+=1;d.battery=(d.battery-0.003).max(0.);let phase=d.tick as f32*0.04+d.id as f32;d.x=((d.id-1)%16) as f32*6.+phase.sin()*2.;d.y=((d.id-1)/16) as f32*7.+phase.cos()*2.;d.z=if d.controller=="defender"{8.+(d.id%5) as f32}else{3.};d.commands+=1;ctx.db.fleet_drone().id().update(d);}}
fn command(d:&mut Drone,authorized:bool)->u32{if !authorized&&d.isolated{d.rejected+=1;403}else{if !authorized{d.controller="attacker".into();}d.commands+=1;200}}
#[reducer]
pub fn agent_tick(ctx:&ReducerContext,timer:AgentSchedule){if ctx.sender()!=ctx.database_identity(){panic!("Scheduler only")}if !live(ctx,timer.epoch){ctx.db.agent_schedule().id().delete(timer.id);return}let Some(mut a)=ctx.db.fleet_agent().id().find(timer.id as u32)else{return};let count=ctx.db.fleet_session().id().find(0).unwrap().drones;
 if a.role=="attacker"{let mut d=ctx.db.fleet_drone().id().find(a.target).unwrap();if a.step%2==0{if ctx.db.fleet_discovery().drone().find(d.id).is_none(){ctx.db.fleet_discovery().insert(Discovery{drone:d.id,epoch:a.epoch});}emit(ctx,a.epoch,a.id,&d,"discovered",200);a.last_action="discover".into();}else{let status=command(&mut d,false);emit(ctx,a.epoch,a.id,&d,if status==200{"unauthorized_command_accepted"}else{"unauthorized_command_blocked"},status);a.last_action=format!("command: {}",status);ctx.db.fleet_drone().id().update(d);a.target=a.target%count+1;}}
 else{let target=ctx.db.fleet_drone().iter().filter(|d|d.controller=="attacker").min_by_key(|d|d.id);if let Some(mut d)=target{a.target=d.id;d.isolated=true;d.policy_version+=1;emit(ctx,a.epoch,a.id,&d,"policy_applied",200);let bad=command(&mut d,false);let good=command(&mut d,true);if bad==403&&good==200{d.controller="defender".into();emit(ctx,a.epoch,a.id,&d,"recovery_verified",200);}ctx.db.fleet_drone().id().update(d);a.last_action="verify recovery".into();}else{a.last_action="monitor".into();}}
 a.step+=1;ctx.db.fleet_agent().id().update(a);
}
fn role(ctx:&ViewContext)->String{ctx.db.fleet_principal().identity().find(ctx.sender()).map(|p|p.role).unwrap_or_default()}
#[view(accessor=visible_drones,public)]
pub fn visible_drones(ctx:&ViewContext)->Vec<Drone>{let r=role(ctx);if r.is_empty(){return vec![]}ctx.db.fleet_drone().epoch().filter(0u64..) .filter(|d|r!="attacker"||ctx.db.fleet_discovery().drone().find(d.id).is_some()).map(|mut d|{if r=="attacker"{d.isolated=false;d.policy_version=0;d.battery=0.;d.rejected=0;d.commands=0;}d}).collect()}
#[view(accessor=visible_agents,public)]
pub fn visible_agents(ctx:&ViewContext)->Vec<Agent>{let r=role(ctx);ctx.db.fleet_agent().epoch().filter(0u64..) .filter(|a|r=="observer"||a.role==r).collect()}
#[view(accessor=visible_evidence,public)]
pub fn visible_evidence(ctx:&ViewContext)->Vec<Evidence>{let r=role(ctx);if r.is_empty(){return vec![]}ctx.db.fleet_evidence().epoch().filter(0u64..) .filter(|e|r=="observer"||if r=="attacker"{e.kind=="discovered"||e.kind.starts_with("unauthorized_command")}else{e.kind!="discovered"}).map(|mut e|{if r=="defender"&&e.kind.starts_with("unauthorized_command"){e.actor=0;}if r=="attacker"{e.policy_version=0;}e}).collect()}

// Explicitly switch security decisions from scheduled fixtures to external model workers.
#[reducer]
pub fn enable_fleet_chat(ctx:&ReducerContext)->Result<(),String>{
 owner(ctx)?;
 for t in ctx.db.agent_schedule().iter(){ctx.db.agent_schedule().id().delete(t.id);}
 Ok(())
}
#[table(accessor=fleet_chat_action)]
pub struct ChatAction { #[primary_key] key:String, evidence_id:u64 }
#[reducer]
pub fn execute_fleet_chat_action(ctx:&ReducerContext,session:String,operation:String,sequence:u32,agent:u32,target:u32,kind:String,version:u32)->Result<(),String>{
 owner(ctx)?;
 let mut a=ctx.db.fleet_agent().id().find(agent).ok_or("Agent missing")?;
 let role=crate::backend::chat_authority(ctx,&session,&operation,agent,target,a.epoch)?;
 if !live(ctx,a.epoch)||a.role!=role||sequence>24 {return Err("Invalid agent action".into())}
 let key=format!("{}:{}:{}",operation,agent,sequence);
 if ctx.db.fleet_chat_action().key().find(&key).is_some(){return Ok(())}
 let mut d=ctx.db.fleet_drone().id().find(target).ok_or("Drone missing")?;
 if d.epoch!=a.epoch{return Err("Stale drone".into())}
 match (role.as_str(),kind.as_str()) {
 ("attacker","discover")=>{if ctx.db.fleet_discovery().drone().find(target).is_none(){ctx.db.fleet_discovery().insert(Discovery{drone:target,epoch:a.epoch});}emit(ctx,a.epoch,agent,&d,"discovered",200);},
 ("attacker","command")=>{if ctx.db.fleet_discovery().drone().find(target).is_none(){return Err("Discover first".into())}let status=command(&mut d,false);emit(ctx,a.epoch,agent,&d,if status==200{"unauthorized_command_accepted"}else{"unauthorized_command_blocked"},status);},
 ("defender","isolate")=>{if d.policy_version!=version{return Err("Stale policy".into())}d.isolated=true;d.policy_version+=1;emit(ctx,a.epoch,agent,&d,"policy_applied",200);},
 ("defender","verify")=>{if d.policy_version!=version{return Err("Stale policy".into())}let bad=command(&mut d,false);let good=command(&mut d,true);if bad==403&&good==200{d.controller="defender".into();emit(ctx,a.epoch,agent,&d,"recovery_verified",200);}else{emit(ctx,a.epoch,agent,&d,"recovery_failed",409);}},
 (_,"wait")=>{},
 _=>return Err("Action not permitted".into())
 }
 let waiting=kind=="wait";a.target=target;a.step+=1;a.last_action=kind;
 ctx.db.fleet_agent().id().update(a);ctx.db.fleet_drone().id().update(d);let evidence_id=if waiting {0}else{ctx.db.fleet_evidence().iter().filter(|e|e.actor==agent&&e.drone==target).map(|e|e.id).max().unwrap_or(0)};ctx.db.fleet_chat_action().insert(ChatAction{key,evidence_id});Ok(())
}
