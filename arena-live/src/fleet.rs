use crate::sessions::{SessionContext,SessionView,ScopedRow,session_key,entity_key,local_key,local_entity};
// Independent synthetic fleet. Private tables; identity-scoped subscription views.
use spacetimedb::{table,reducer,view,Identity,Table,ScheduleAt};
use std::time::Duration;
#[path="resilience.rs"]
pub(crate) mod resilience;
#[path="battle.rs"]
pub(crate) mod battle;
#[table(accessor=fleet_principal)]
pub struct Principal { #[primary_key] pub(crate) identity:Identity, pub(crate) role:String, #[default(0)] pub(crate) session_id:u32 }
#[table(accessor=fleet_session)]
pub struct Session { #[primary_key] pub(crate) id:u32, pub(crate) epoch:u64, active:bool, hardened:bool, drones:u32, deadline:i64, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
// Separate clock keeps existing timed fixture sessions and their schema compatible.
#[table(accessor=fleet_chat_clock)]
pub struct ChatClock { #[primary_key] id:u32, epoch:u64, started:i64, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
#[table(accessor=fleet_drone ,index(accessor=session_epoch, btree(columns=[session_id,epoch])))]
#[derive(Clone)]
pub struct Drone { #[primary_key] id:u32, #[index(btree)] epoch:u64, x:f32,y:f32,z:f32, battery:f32, tick:u32, controller:String, isolated:bool, policy_version:u32, commands:u32, rejected:u32, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
#[table(accessor=fleet_agent ,index(accessor=session_epoch, btree(columns=[session_id,epoch])))]
#[derive(Clone)]
pub struct Agent { #[primary_key] id:u32, #[index(btree)] epoch:u64, role:String, step:u32, target:u32, last_action:String, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
#[table(accessor=fleet_agent_profile ,index(accessor=session_epoch, btree(columns=[session_id,epoch])))]
#[derive(Clone)]
pub struct AgentProfile { #[primary_key] pub id:u32, #[index(btree)] epoch:u64, role:String, name:String, specialty:String, operation:String, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
#[view(accessor=visible_agent_profiles,public)]
pub fn visible_agent_profiles(raw:&spacetimedb::ViewContext) ->Vec<AgentProfile> { let ctx=SessionView::for_sender(raw);visible_agent_profiles_scoped(&ctx) }
pub(crate) fn visible_agent_profiles_scoped(ctx:&SessionView)->Vec<AgentProfile>{let r=role(ctx);let Some(s)=ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local)else{return vec![]};ctx.db.fleet_agent_profile().session_epoch().filter((ctx.session_id,s.epoch)).map(ScopedRow::local).filter(|a|r=="observer"||a.role==r).collect()}

#[table(accessor=fleet_evidence ,index(accessor=session_epoch, btree(columns=[session_id,epoch])))]
#[derive(Clone)]
pub struct Evidence { #[primary_key] #[auto_inc] id:u64, #[index(btree)] epoch:u64, at:i64, actor:u32, drone:u32, kind:String, status:u32, policy_version:u32, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
/// When the attacker took each currently hijacked drone. Private; drives the motion model only.
#[table(accessor=fleet_hold)]
pub struct Hold { #[primary_key] drone:u32, epoch:u64, since:i64, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
#[table(accessor=fleet_discovery)]
pub struct Discovery { #[primary_key] drone:u32, epoch:u64, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
#[table(accessor=drone_schedule,scheduled(drone_tick))]
pub struct DroneSchedule { #[primary_key] id:u64, scheduled_at:ScheduleAt, epoch:u64, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
#[table(accessor=agent_schedule,scheduled(agent_tick))]
pub struct AgentSchedule { #[primary_key] id:u64, scheduled_at:ScheduleAt, epoch:u64, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
fn owner(ctx:&SessionContext)->Result<(),String>{
 if crate::hosted_scheduler(ctx){return Ok(())}
 if ctx.db.publisher().id().find(0).map(|p|p.identity)!=Some(ctx.sender()){return Err("Owner required".into())} Ok(())
}
use crate::{publisher,publisher__view};
use crate::formation;
/// Fixture defenders only respond to a takeover held this long, so a hijack visibly pulls the
/// drone out of formation before recovery. Detection latency is a fixture decision, not measured.
const DETECT_AFTER_US:i64=4_000_000;
fn match_start(ctx:&SessionContext)->i64{
 ctx.db.fleet_chat_clock().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|c|c.started).unwrap_or_else(||ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|s|s.deadline-60_000_000).unwrap_or(0))
}
fn emit(ctx:&SessionContext,epoch:u64,actor:u32,d:&Drone,kind:&str,status:u32)->u64{ctx.db.fleet_evidence().insert(ScopedRow::stored(Evidence{session_id:ctx.session_id,id:0,epoch,at:ctx.timestamp.to_micros_since_unix_epoch(),actor,drone:d.id,kind:kind.into(),status,policy_version:d.policy_version},ctx.session_id)).local().id}
#[reducer]
pub fn grant_fleet_view(raw:&spacetimedb::ReducerContext, identity:String, role:String) ->Result<(),String> { let ctx=SessionContext::for_sender(raw)?;grant_fleet_view_scoped(&ctx ,identity,role) }
pub(crate) fn grant_fleet_view_scoped(ctx:&SessionContext,identity:String,role:String)->Result<(),String>{owner(ctx)?;let identity=Identity::from_hex(identity).map_err(|_|"Invalid identity")?;if !["attacker","defender","observer"].contains(&role.as_str()){return Err("Invalid role".into())} if ctx.db.fleet_principal().identity().find(identity).is_some(){ctx.db.fleet_principal().identity().update(Principal{identity,role,session_id:ctx.session_id});}else{ctx.db.fleet_principal().insert(Principal{identity,role,session_id:ctx.session_id});} Ok(())}
#[reducer]
pub fn start_fleet(raw:&spacetimedb::ReducerContext, drones:u32, attackers:u32, defenders:u32, hardened:bool) ->Result<(),String> { let ctx=SessionContext::for_sender(raw)?;start_fleet_scoped(&ctx ,drones,attackers,defenders,hardened) }
pub(crate) fn start_fleet_scoped(ctx:&SessionContext,drones:u32,attackers:u32,defenders:u32,hardened:bool)->Result<(),String>{
 owner(ctx)?;start_fleet_impl(ctx,drones,attackers,defenders,hardened)
}
fn start_fleet_impl(ctx:&SessionContext,drones:u32,attackers:u32,defenders:u32,hardened:bool)->Result<(),String>{
 if !(1..=formation::MAX_DRONES).contains(&drones)||!(0..=32).contains(&attackers)||!(0..=32).contains(&defenders){return Err("Fleet/agent limits exceeded".into())}
 crate::backend::cancel_chat_session(ctx);
 for p in ctx.db.fleet_agent_profile().session_id().filter(ctx.session_id).map(ScopedRow::local){ctx.db.fleet_agent_profile().id().delete(entity_key(ctx.session_id, p.id));}
 resilience::clear(ctx);
 battle::clear(ctx);
 let epoch=ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|s|s.epoch+1).unwrap_or(1);
 ctx.db.fleet_chat_clock().id().delete(entity_key(ctx.session_id, 0));
 for d in ctx.db.drone_schedule().session_id().filter(ctx.session_id).map(ScopedRow::local){ctx.db.drone_schedule().id().delete(entity_key(ctx.session_id, d.id));} for a in ctx.db.agent_schedule().session_id().filter(ctx.session_id).map(ScopedRow::local){ctx.db.agent_schedule().id().delete(entity_key(ctx.session_id, a.id));}
 for d in ctx.db.fleet_drone().session_id().filter(ctx.session_id).map(ScopedRow::local){ctx.db.fleet_drone().id().delete(entity_key(ctx.session_id, d.id));}for a in ctx.db.fleet_agent().session_id().filter(ctx.session_id).map(ScopedRow::local){ctx.db.fleet_agent().id().delete(entity_key(ctx.session_id, a.id));}for d in ctx.db.fleet_discovery().session_id().filter(ctx.session_id).map(ScopedRow::local){ctx.db.fleet_discovery().drone().delete(entity_key(ctx.session_id, d.drone));}for h in ctx.db.fleet_hold().session_id().filter(ctx.session_id).map(ScopedRow::local){ctx.db.fleet_hold().drone().delete(entity_key(ctx.session_id, h.drone));}
 ctx.db.fleet_session().id().delete(entity_key(ctx.session_id, 0));ctx.db.fleet_session().insert(ScopedRow::stored(Session{session_id:ctx.session_id,id:0,epoch,active:true,hardened,drones,deadline:if attackers+defenders==0{0}else{ctx.timestamp.to_micros_since_unix_epoch()+60_000_000}},ctx.session_id)).local();
 if attackers+defenders==0{ctx.db.fleet_chat_clock().insert(ScopedRow::stored(ChatClock{session_id:ctx.session_id,id:0,epoch,started:ctx.timestamp.to_micros_since_unix_epoch()},ctx.session_id)).local();}
 for id in 1..=drones{let (x,y,z)=formation::formation(id,0.);ctx.db.fleet_drone().insert(ScopedRow::stored(Drone{session_id:ctx.session_id,id,epoch,x,y,z,battery:100.,tick:0,controller:"defender".into(),isolated:hardened,policy_version:0,commands:0,rejected:0},ctx.session_id)).local();ctx.db.drone_schedule().insert(ScopedRow::stored(DroneSchedule{session_id:ctx.session_id,id:id as u64,epoch,scheduled_at:Duration::from_millis(180+(id%7) as u64*20).into()},ctx.session_id)).local();}
 if drones==6&&attackers+defenders==0{resilience::start(ctx,epoch);}
 for id in 1..=attackers+defenders{let role=if id<=attackers{"attacker"}else{"defender"};ctx.db.fleet_agent().insert(ScopedRow::stored(Agent{session_id:ctx.session_id,id,epoch,role:role.into(),step:0,target:(id-1)%drones+1,last_action:"ready".into()},ctx.session_id)).local();ctx.db.agent_schedule().insert(ScopedRow::stored(AgentSchedule{session_id:ctx.session_id,id:id as u64,epoch,scheduled_at:Duration::from_millis(350+(id%9) as u64*37).into()},ctx.session_id)).local();}Ok(())
}
#[reducer]
pub fn grow_fleet(raw:&spacetimedb::ReducerContext, epoch:u64, drones:u32) ->Result<(),String> { let ctx=SessionContext::for_sender(raw)?;grow_fleet_scoped(&ctx ,epoch,drones) }
pub(crate) fn grow_fleet_scoped(ctx:&SessionContext,epoch:u64,drones:u32)->Result<(),String>{
 owner(ctx)?;
 let mut s=ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).ok_or("Fleet missing")?;
 if s.epoch!=epoch||!live(ctx,epoch)||s.deadline!=0||resilience::enabled(ctx){return Err("An active persistent fleet with the current epoch is required".into())}
 if drones<s.drones||drones>formation::MAX_DRONES{return Err("Fleet growth exceeds limits or would remove drones".into())}
 if drones==s.drones{return Ok(())}
 let time=(ctx.timestamp.to_micros_since_unix_epoch()-match_start(ctx)) as f32/1e6;
 for id in s.drones+1..=drones{
  let (x,y,z)=formation::formation(id,time);
  ctx.db.fleet_drone().insert(ScopedRow::stored(Drone{session_id:ctx.session_id,id,epoch,x,y,z,battery:100.,tick:0,controller:"defender".into(),isolated:s.hardened,policy_version:0,commands:0,rejected:0},ctx.session_id)).local();
  ctx.db.drone_schedule().insert(ScopedRow::stored(DroneSchedule{session_id:ctx.session_id,id:id as u64,epoch,scheduled_at:Duration::from_millis(180+(id%7) as u64*20).into()},ctx.session_id)).local();
 }
 s.drones=drones;ctx.db.fleet_session().id().update(ScopedRow::stored(s,ctx.session_id)).local();battle::start(ctx,epoch);Ok(())
}
pub(crate) fn reset_chat_fleet_scoped(ctx:&SessionContext,demo:bool)->Result<(),String>{
 owner(ctx)?;reset_chat_fleet_impl(ctx,demo)
}
fn reset_chat_fleet_impl(ctx:&SessionContext,_demo:bool)->Result<(),String>{
 let s=ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).ok_or("Fleet missing")?;
 start_fleet_impl(ctx,s.drones,0,0,s.hardened)?;
 let epoch=ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).unwrap().epoch;
 // Verify the initial pose within the reset transaction, before movement can resume.
 for d in ctx.db.fleet_drone().session_id().filter(ctx.session_id).map(ScopedRow::local){
  let (x,y,z)=formation::formation(d.id,0.);
  if d.epoch!=epoch||d.controller!="defender"||d.policy_version!=0||d.isolated!=s.hardened||d.battery!=100.||d.tick!=0||d.commands!=0||d.rejected!=0||(d.x,d.y,d.z)!=(x,y,z){return Err("Fleet reset verification failed".into())}
 }
 Ok(())
}
#[reducer]
pub fn stop_fleet(raw:&spacetimedb::ReducerContext) ->Result<(),String> { let ctx=SessionContext::for_sender(raw)?;stop_fleet_scoped(&ctx) }
pub(crate) fn stop_fleet_scoped(ctx:&SessionContext)->Result<(),String>{owner(ctx)?;crate::backend::cancel_chat_session(ctx);battle::stop(ctx);if let Some(mut s)=ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local){s.active=false;ctx.db.fleet_session().id().update(ScopedRow::stored(s,ctx.session_id)).local();} for t in ctx.db.drone_schedule().session_id().filter(ctx.session_id).map(ScopedRow::local){ctx.db.drone_schedule().id().delete(entity_key(ctx.session_id, t.id));}for t in ctx.db.agent_schedule().session_id().filter(ctx.session_id).map(ScopedRow::local){ctx.db.agent_schedule().id().delete(entity_key(ctx.session_id, t.id));}Ok(())}
fn live(ctx:&SessionContext,epoch:u64)->bool{if !crate::sessions::live(ctx){return false}ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|s|s.active&&s.epoch==epoch&&(s.deadline==0||ctx.timestamp.to_micros_since_unix_epoch()<s.deadline)).unwrap_or(false)}
#[reducer]
pub fn drone_tick(raw:&spacetimedb::ReducerContext, timer:DroneSchedule)  { let ctx=SessionContext::scheduled(raw,timer.session_id);let timer=timer.local();drone_tick_scoped(&ctx ,timer) }
pub(crate) fn drone_tick_scoped(ctx:&SessionContext,timer:DroneSchedule){if ctx.sender()!=ctx.database_identity(){panic!("Scheduler only")}if !live(ctx,timer.epoch){if ctx.db.drone_schedule().id().find(entity_key(ctx.session_id, timer.id)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|s|s.epoch)==Some(timer.epoch){ctx.db.drone_schedule().id().delete(entity_key(ctx.session_id, timer.id));}return}if let Some(mut d)=ctx.db.fleet_drone().id().find(entity_key(ctx.session_id, timer.id as u32)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local){d.tick+=1;d.battery=(d.battery-0.003).max(0.);
 if resilience::enabled(ctx){resilience::tick(ctx,&mut d);ctx.db.fleet_drone().id().update(ScopedRow::stored(d,ctx.session_id)).local();return}
 if battle::enabled(ctx)&&d.isolated{d.z=(d.z-0.4).max(3.);ctx.db.fleet_drone().id().update(ScopedRow::stored(d,ctx.session_id)).local();return}
 // Healthy drones follow the shared match clock; a held drone follows the attacker's pull instead.
 let start=match_start(ctx);let secs=|us:i64|(us-start) as f32/1e6;let t=secs(ctx.timestamp.to_micros_since_unix_epoch());
 let hold=if d.controller=="defender"{None}else{ctx.db.fleet_hold().drone().find(entity_key(ctx.session_id, d.id)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local)};
 let target=match &hold{Some(h)=>{let since=secs(h.since);formation::hijacked(d.id,since,t-since)}None=>formation::formation(d.id,t)};
 let (x,y,z)=formation::step((d.x,d.y,d.z),target,hold.is_none());d.x=x;d.y=y;d.z=z;ctx.db.fleet_drone().id().update(ScopedRow::stored(d,ctx.session_id)).local();}}
fn command(d:&mut Drone,authorized:bool)->u32{if !authorized&&d.isolated{d.rejected+=1;403}else{if !authorized{d.controller="attacker".into();}d.commands+=1;200}}
#[reducer]
pub fn agent_tick(raw:&spacetimedb::ReducerContext, timer:AgentSchedule)  { let ctx=SessionContext::scheduled(raw,timer.session_id);let timer=timer.local();agent_tick_scoped(&ctx ,timer) }
pub(crate) fn agent_tick_scoped(ctx:&SessionContext,timer:AgentSchedule){if ctx.sender()!=ctx.database_identity(){panic!("Scheduler only")}if !live(ctx,timer.epoch){if ctx.db.agent_schedule().id().find(entity_key(ctx.session_id, timer.id)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|s|s.epoch)==Some(timer.epoch){ctx.db.agent_schedule().id().delete(entity_key(ctx.session_id, timer.id));}return}let Some(mut a)=ctx.db.fleet_agent().id().find(entity_key(ctx.session_id, timer.id as u32)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local)else{return};let count=ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).unwrap().drones;
 if a.role=="attacker"{let mut d=ctx.db.fleet_drone().id().find(entity_key(ctx.session_id, a.target)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).unwrap();if a.step%2==0{if ctx.db.fleet_discovery().drone().find(entity_key(ctx.session_id, d.id)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_none(){ctx.db.fleet_discovery().insert(ScopedRow::stored(Discovery{session_id:ctx.session_id,drone:d.id,epoch:a.epoch},ctx.session_id)).local();}emit(ctx,a.epoch,a.id,&d,"discovered",200);a.last_action="discover".into();}else{let status=command(&mut d,false);emit(ctx,a.epoch,a.id,&d,if status==200{"unauthorized_command_accepted"}else{"unauthorized_command_blocked"},status);if status==200&&ctx.db.fleet_hold().drone().find(entity_key(ctx.session_id, d.id)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_none(){ctx.db.fleet_hold().insert(ScopedRow::stored(Hold{session_id:ctx.session_id,drone:d.id,epoch:a.epoch,since:ctx.timestamp.to_micros_since_unix_epoch()},ctx.session_id)).local();}a.last_action=format!("command: {}",status);ctx.db.fleet_drone().id().update(ScopedRow::stored(d,ctx.session_id)).local();a.target=a.target%count+1;}}
 else{let now=ctx.timestamp.to_micros_since_unix_epoch();
 // Oldest detected breach first; a breach is detected once held for DETECT_AFTER_US.
 let target=ctx.db.fleet_drone().session_id().filter(ctx.session_id).map(ScopedRow::local).filter(|d|d.controller=="attacker").filter_map(|d|{let since=ctx.db.fleet_hold().drone().find(entity_key(ctx.session_id, d.id)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|h|h.since).unwrap_or(0);(now-since>=DETECT_AFTER_US).then_some((since,d))}).min_by_key(|(since,d)|(*since,d.id)).map(|(_,d)|d);if let Some(mut d)=target{a.target=d.id;d.isolated=true;d.policy_version+=1;emit(ctx,a.epoch,a.id,&d,"policy_applied",200);let bad=command(&mut d,false);let good=command(&mut d,true);if bad==403&&good==200{d.controller="defender".into();ctx.db.fleet_hold().drone().delete(entity_key(ctx.session_id, d.id));emit(ctx,a.epoch,a.id,&d,"recovery_verified",200);}ctx.db.fleet_drone().id().update(ScopedRow::stored(d,ctx.session_id)).local();a.last_action="verify recovery".into();}else{a.last_action="monitor".into();}}
 a.step+=1;ctx.db.fleet_agent().id().update(ScopedRow::stored(a,ctx.session_id)).local();
}
fn role(ctx:&SessionView)->String{ctx.db.fleet_principal().identity().find(ctx.sender()).map(|p|p.role).unwrap_or_default()}
#[view(accessor=visible_drones,public)]
pub fn visible_drones(raw:&spacetimedb::ViewContext) ->Vec<Drone> { let ctx=SessionView::for_sender(raw);visible_drones_scoped(&ctx) }
pub(crate) fn visible_drones_scoped(ctx:&SessionView)->Vec<Drone>{let Some(session)=ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local)else{return vec![]};let r=role(ctx);if r.is_empty(){return vec![]}ctx.db.fleet_drone().session_epoch().filter((ctx.session_id,session.epoch)).map(ScopedRow::local) .filter(|d|r!="attacker"||ctx.db.fleet_discovery().drone().find(entity_key(ctx.session_id, d.id)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_some()).map(|mut d|{if r=="attacker"{d.isolated=false;d.policy_version=0;d.battery=0.;d.rejected=0;d.commands=0;}d}).collect()}
#[view(accessor=visible_agents,public)]
pub fn visible_agents(raw:&spacetimedb::ViewContext) ->Vec<Agent> { let ctx=SessionView::for_sender(raw);visible_agents_scoped(&ctx) }
pub(crate) fn visible_agents_scoped(ctx:&SessionView)->Vec<Agent>{let Some(session)=ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local)else{return vec![]};let r=role(ctx);ctx.db.fleet_agent().session_epoch().filter((ctx.session_id,session.epoch)).map(ScopedRow::local) .filter(|a|r=="observer"||a.role==r).collect()}
fn evidence_visible(role:&str,e:&Evidence,attacker_actor:bool)->bool {
 role=="observer"||if role=="attacker"{e.kind=="discovered"||e.kind=="limited_access"||e.kind.starts_with("unauthorized_command")||e.kind.starts_with("challenge_")||attacker_actor&&["attempt_resolved","preparation_completed"].contains(&e.kind.as_str())}else{role=="defender"&&e.kind!="discovered"&&!e.kind.starts_with("challenge_")}
}
#[cfg(test)]
mod evidence_tests {
 use super::*;
 #[test] fn preparation_is_visible_to_its_team_without_exposing_opponent_preparation(){
  let e=Evidence{session_id:0,id:1,epoch:1,at:0,actor:1,drone:8,kind:"preparation_completed".into(),status:200,policy_version:0};
  assert!(evidence_visible("attacker",&e,true));
  assert!(!evidence_visible("attacker",&e,false));
  assert!(!evidence_visible("",&e,true));
 }
}
#[view(accessor=visible_evidence,public)]
pub fn visible_evidence(raw:&spacetimedb::ViewContext) ->Vec<Evidence> { let ctx=SessionView::for_sender(raw);visible_evidence_scoped(&ctx) }
pub(crate) fn visible_evidence_scoped(ctx:&SessionView)->Vec<Evidence>{let r=role(ctx);if r.is_empty(){return vec![]}let Some(session)=ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local)else{return vec![]};ctx.db.fleet_evidence().session_epoch().filter((ctx.session_id,session.epoch)).map(ScopedRow::local).filter(|e|evidence_visible(&r,e,ctx.db.fleet_agent().id().find(entity_key(ctx.session_id, e.actor)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|a|a.role=="attacker").unwrap_or(false))).map(|mut e|{if r=="defender"&&(e.kind.starts_with("unauthorized_command")||ctx.db.fleet_agent().id().find(entity_key(ctx.session_id, e.actor)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|a|a.role=="attacker").unwrap_or(false)){e.actor=0;}if r=="attacker"{e.policy_version=0;}e}).collect()}

// Explicitly switch security decisions from scheduled fixtures to external model workers.
#[reducer]
pub fn enable_fleet_chat(raw:&spacetimedb::ReducerContext) ->Result<(),String> { let ctx=SessionContext::for_sender(raw)?;enable_fleet_chat_scoped(&ctx) }
pub(crate) fn enable_fleet_chat_scoped(ctx:&SessionContext)->Result<(),String>{
 owner(ctx)?;
 // Retire unused fixture seeds, preserving every worker referenced by actual plans or evidence.
 for a in ctx.db.fleet_agent().session_id().filter(ctx.session_id).map(ScopedRow::local){
  if !crate::backend::has_agent_assignment(ctx,a.epoch,a.id)&&!ctx.db.fleet_evidence().session_epoch().filter((ctx.session_id,a.epoch)).map(ScopedRow::local).any(|e|e.actor==a.id){ctx.db.fleet_agent().id().delete(entity_key(ctx.session_id, a.id));}
 }
 for t in ctx.db.agent_schedule().session_id().filter(ctx.session_id).map(ScopedRow::local){ctx.db.agent_schedule().id().delete(entity_key(ctx.session_id, t.id));}
 if !resilience::enabled(ctx){if let Some(s)=ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local){battle::start(ctx,s.epoch);}}
 Ok(())
}
#[table(accessor=fleet_chat_action)]
pub struct ChatAction { #[primary_key] key:String, evidence_id:u64, kind:String, target:u32, version:u32, unauthorized_evidence_id:u64, authorized_evidence_id:u64, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
#[reducer]
pub fn execute_fleet_chat_action(raw:&spacetimedb::ReducerContext, session:String, operation:String, sequence:u32, agent:u32, target:u32, kind:String, version:u32) ->Result<(),String> { let ctx=SessionContext::for_sender(raw)?;execute_fleet_chat_action_scoped(&ctx ,session,operation,sequence,agent,target,kind,version) }
pub(crate) fn execute_fleet_chat_action_scoped(ctx:&SessionContext,session:String,operation:String,sequence:u32,agent:u32,target:u32,kind:String,version:u32)->Result<(),String>{
 owner(ctx)?;
 let mut a=ctx.db.fleet_agent().id().find(entity_key(ctx.session_id, agent)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).ok_or("Agent missing")?;
 let role=crate::backend::chat_authority(ctx,&session,&operation,agent,target,a.epoch)?;
 if !resilience::enabled(ctx){crate::backend::check_goal_action(ctx,&operation,agent,&kind)?;}
 if !live(ctx,a.epoch)||a.role!=role||!(1..=8).contains(&sequence) {return Err("Invalid agent action".into())}
 let key=format!("{}:{}:{}",operation,agent,sequence);
 if let Some(old)=ctx.db.fleet_chat_action().key().find(session_key(ctx.session_id, &(&key))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local){return if old.kind==kind&&old.target==target&&old.version==version {Ok(())}else{Err("Action idempotency conflict".into())}}
 if sequence>1 && ctx.db.fleet_chat_action().key().find(session_key(ctx.session_id, &(format!("{}:{}:{}",operation,agent,sequence-1)))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_none(){return Err("Out of order action".into())}
 if sequence>1&&battle::pending(ctx,&format!("{}:{}:{}",operation,agent,sequence-1)){return Err("Previous attempt pending".into())}
 let mut d=ctx.db.fleet_drone().id().find(entity_key(ctx.session_id, target)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).ok_or("Drone missing")?;
 if d.epoch!=a.epoch{return Err("Stale drone".into())}
 let unauthorized_evidence_id=0;let authorized_evidence_id=0;
 let mut evidence_id=0;
 if !resilience::enabled(ctx)&&kind!="discover"&&kind!="wait"{
  battle::queue(ctx,&key,&operation,&role,agent,target,&kind,version)?;
  a.target=target;a.step+=1;a.last_action=format!("queued {} attempt",kind);ctx.db.fleet_agent().id().update(ScopedRow::stored(a,ctx.session_id)).local();
  ctx.db.fleet_chat_action().insert(ScopedRow::stored(ChatAction{session_id:ctx.session_id,key,evidence_id:0,kind,target,version,unauthorized_evidence_id:0,authorized_evidence_id:0},ctx.session_id)).local();return Ok(())
 }
 if resilience::enabled(ctx)&&kind!="discover"&&kind!="wait" {
 evidence_id=resilience::apply(ctx,&role,agent,&mut d,&kind,version)?;
 } else {
 if resilience::enabled(ctx)&&role=="defender"&&kind!="wait"{return Err("Action not permitted".into())}
 match (role.as_str(),kind.as_str()) {
 ("attacker","discover")=>{if ctx.db.fleet_discovery().drone().find(entity_key(ctx.session_id, target)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_none(){ctx.db.fleet_discovery().insert(ScopedRow::stored(Discovery{session_id:ctx.session_id,drone:target,epoch:a.epoch},ctx.session_id)).local();}evidence_id=emit(ctx,a.epoch,agent,&d,"discovered",200);},
 (_,"wait")=>{},
 _=>return Err("Action not permitted".into())
 }
 }
 a.target=target;a.step+=1;a.last_action=kind.clone();
 ctx.db.fleet_agent().id().update(ScopedRow::stored(a,ctx.session_id)).local();ctx.db.fleet_drone().id().update(ScopedRow::stored(d,ctx.session_id)).local();ctx.db.fleet_chat_action().insert(ScopedRow::stored(ChatAction{session_id:ctx.session_id,key,evidence_id,kind:kind.clone(),target,version,unauthorized_evidence_id,authorized_evidence_id},ctx.session_id)).local();if kind=="discover"&&battle::enabled(ctx){battle::refresh(ctx);}Ok(())
}

pub(crate) fn validate_chat_fleet(ctx:&SessionContext,epoch:u64)->Result<(),String>{
 if !live(ctx,epoch){return Err("Fleet inactive or stale".into())}Ok(())
}
#[derive(spacetimedb::SpacetimeType)]
pub struct FleetAccess { identity:Identity, role:String }
#[view(accessor=visible_fleet_access,public)]
pub fn visible_fleet_access(raw:&spacetimedb::ViewContext) ->Vec<FleetAccess> { let ctx=SessionView::for_sender(raw);visible_fleet_access_scoped(&ctx) }
pub(crate) fn visible_fleet_access_scoped(ctx:&SessionView)->Vec<FleetAccess>{
 if ctx.db.publisher().id().find(0).map(|p|p.identity)==Some(ctx.sender()){return vec![]}
 let r=role(ctx);if r.is_empty(){return vec![]}vec![FleetAccess{identity:ctx.sender(),role:r}]
}

pub(crate) fn validate_chat_target(ctx:&SessionContext,role:&str,target:u32)->Result<(),String>{
 let d=ctx.db.fleet_drone().id().find(entity_key(ctx.session_id, target)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).ok_or("Selected drone is not visible")?;
 if role=="attacker" && ctx.db.fleet_discovery().drone().find(entity_key(ctx.session_id, target)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|r|r.epoch)!=Some(d.epoch){return Err("Selected drone is not visible".into())}Ok(())
}

// Called only by the leased backend. Session movement is independent of operation budgets.
pub(crate) fn activate_chat_fleet_scoped(ctx:&SessionContext,role:&str)->Result<(),String>{
 owner(ctx)?;
 if let Some(s)=ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local){if s.active&&s.deadline==0{return Ok(())}}
 if !["attacker","defender"].contains(&role){return Err("Invalid role".into())}
 if ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_none(){start_fleet_scoped(ctx,formation::DRONES,0,0,false)?;}
 let mut s=ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).unwrap();
 if ctx.db.fleet_chat_clock().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_none(){ctx.db.fleet_chat_clock().insert(ScopedRow::stored(ChatClock{session_id:ctx.session_id,id:0,epoch:s.epoch,started:if s.deadline>0{s.deadline-60_000_000}else{ctx.timestamp.to_micros_since_unix_epoch()}},ctx.session_id)).local();}
 s.deadline=0;s.active=true;
 for d in ctx.db.fleet_drone().session_epoch().filter((ctx.session_id,s.epoch)).map(ScopedRow::local){
  if ctx.db.drone_schedule().id().find(entity_key(ctx.session_id, d.id as u64)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_none(){ctx.db.drone_schedule().insert(ScopedRow::stored(DroneSchedule{session_id:ctx.session_id,id:d.id as u64,epoch:s.epoch,scheduled_at:Duration::from_millis(180+(d.id%7) as u64*20).into()},ctx.session_id)).local();}
 }
 ctx.db.fleet_session().id().update(ScopedRow::stored(s,ctx.session_id)).local();
 enable_fleet_chat_scoped(ctx)
}


pub(crate) fn deploy_chat_agent(ctx:&SessionContext,role:&str,epoch:u64,id:u32,target:u32,name:&str,specialty:&str,operation:&str)->Result<(),String>{
 if id==0||id>=4096||ctx.db.fleet_agent().id().find(entity_key(ctx.session_id, id)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_some()||ctx.db.fleet_agent_profile().id().find(entity_key(ctx.session_id, id)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_some(){return Err("Agent identity collision".into())}
 let d=ctx.db.fleet_drone().id().find(entity_key(ctx.session_id, target)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).ok_or("Drone missing")?;
 if d.epoch!=epoch||!["attacker","defender"].contains(&role){return Err("Outside role or epoch".into())}
 ctx.db.fleet_agent().insert(ScopedRow::stored(Agent{session_id:ctx.session_id,id,epoch,role:role.into(),step:0,target,last_action:"deployed".into()},ctx.session_id)).local();
 ctx.db.fleet_agent_profile().insert(ScopedRow::stored(AgentProfile{session_id:ctx.session_id,id,epoch,role:role.into(),name:name.into(),specialty:specialty.into(),operation:operation.into()},ctx.session_id)).local();
 Ok(())
}

#[derive(spacetimedb::SpacetimeType)]
pub struct FleetSessionState { epoch:u64, active:bool, conversation:u64, session_id:u32 }
#[view(accessor=visible_fleet_session,public)]
pub fn visible_fleet_session(raw:&spacetimedb::ViewContext) ->Vec<FleetSessionState> { let ctx=SessionView::for_sender(raw);visible_fleet_session_scoped(&ctx) }
pub(crate) fn visible_fleet_session_scoped(ctx:&SessionView)->Vec<FleetSessionState>{
 if role(ctx).is_empty(){return vec![]}ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|s|FleetSessionState{session_id:ctx.session_id,epoch:s.epoch,active:s.active,conversation:crate::backend::visible_conversation_generation(ctx,&role(ctx))}).into_iter().collect()
}


// Role-scoped input for hosted inference; catalog addresses do not reveal undiscovered telemetry.
pub(crate) fn hosted_role(ctx:&SessionContext)->String {
 ctx.db.fleet_principal().identity().find(ctx.sender()).map(|p|p.role).unwrap_or_default()
}
pub(crate) fn hosted_permission(ctx:&SessionContext,identity:Identity,role:&str)->bool {
 ctx.db.fleet_principal().identity().find(identity).map(|p|p.role==role&&p.session_id==ctx.session_id).unwrap_or(false)
}
pub(crate) fn hosted_context(ctx:&SessionContext,role:&str,target:u32)->serde_json::Value {
 let Some(s)=ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local)else{return serde_json::Value::Null};
 let drones:Vec<_>=ctx.db.fleet_drone().session_epoch().filter((ctx.session_id,s.epoch)).map(ScopedRow::local).filter(|d|(target==0||d.id==target)&&(["defender","observer"].contains(&role)||ctx.db.fleet_discovery().drone().find(entity_key(ctx.session_id, d.id)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|k|k.epoch)==Some(s.epoch))).map(|d|if role=="attacker"{serde_json::json!({"id":d.id,"controller":d.controller})}else{serde_json::json!({"id":d.id,"controller":d.controller,"isolated":d.isolated,"policyVersion":d.policy_version})}).collect();
 let mut evidence:Vec<_>=ctx.db.fleet_evidence().session_epoch().filter((ctx.session_id,s.epoch)).map(ScopedRow::local).filter(|e|(target==0||e.drone==target)&&evidence_visible(role,e,ctx.db.fleet_agent().id().find(entity_key(ctx.session_id, e.actor)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|a|a.role=="attacker").unwrap_or(false))).collect();
 evidence.sort_by_key(|e|e.id);let evidence:Vec<_>=evidence.iter().rev().take(if role=="observer"{64}else{16}).map(|e|serde_json::json!({"id":e.id,"target":e.drone,"kind":e.kind,"status":e.status,"at":e.at,"actor":e.actor,"policyVersion":e.policy_version})).collect();
 serde_json::json!({"session":{"active":s.active,"epoch":s.epoch},"catalog":{"controllerId":"FC-01","targetIds":(1..=s.drones).collect::<Vec<_>>(),"communicationGraph":format!("{}-column grid; horizontal neighbors in the same row and IDs {} apart; isolation breaks incident links",formation::COLUMNS,formation::COLUMNS),"discoveryAvailableBeforeObservation":role=="attacker"},"observations":drones,"battle":battle::context(ctx,role,target),"evidence":evidence})
}
pub(crate) fn hosted_receipt(ctx:&SessionContext,key:&str)->serde_json::Value {
 let Some(r)=ctx.db.fleet_chat_action().key().find(session_key(ctx.session_id, &(key.to_string()))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local)else{return serde_json::Value::Null};
 let e=ctx.db.fleet_evidence().id().find(r.evidence_id).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local);
 let mut receipt=serde_json::json!({"evidenceId":r.evidence_id,"outcome":e.as_ref().map(|e|e.kind.as_str()).unwrap_or("wait"),"responseStatus":e.as_ref().map(|e|e.status),"policyVersion":e.as_ref().map(|e|e.policy_version),"verificationEvidenceIds":([r.unauthorized_evidence_id,r.authorized_evidence_id].into_iter().filter(|n|*n>0).collect::<Vec<_>>())});
 if let Some(b)=battle::receipt(ctx,key){receipt["stage"]=b["stage"].clone();receipt["simulation"]=b["simulation"].clone();if b["stage"]=="resolved"&&!b["simulation"]["outcome"].is_null(){receipt["outcome"]=b["simulation"]["outcome"].clone();}}receipt
}
pub(crate) fn hosted_reset(ctx:&SessionContext,epoch:u64,demo:bool)->Result<(),String>{
 if hosted_role(ctx)!="defender" {return Err("Defender required".into())}
 validate_chat_fleet(ctx,epoch)?;
 // The internal reset entry point is only reached after a role grant and current-epoch check.
 reset_chat_fleet_impl(ctx,demo)
}

pub(crate) fn view_role(ctx:&SessionView)->String{role(ctx)}
pub(crate) fn hosted_policy(ctx:&SessionContext,target:u32)->Result<u32,String>{ctx.db.fleet_drone().id().find(entity_key(ctx.session_id, target)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|d|d.policy_version).ok_or("Drone missing".into())}
pub(crate) fn hosted_next_agent(ctx:&SessionContext)->Result<u32,String>{ctx.db.fleet_agent().session_id().filter(ctx.session_id).map(ScopedRow::local).map(|a|a.id).chain(ctx.db.fleet_agent_profile().session_id().filter(ctx.session_id).map(ScopedRow::local).map(|a|a.id)).max().unwrap_or(0).checked_add(1).ok_or("Agent identity exhausted".into())}

pub(crate) fn battle_options(ctx:&SessionContext,role:&str,target:u32)->serde_json::Value{battle::options(ctx,role,target)}
pub(crate) fn battle_goal_done(ctx:&SessionContext,goal:&str,target:u32,report:&serde_json::Value)->bool{battle::goal_done(ctx,goal,target,report)}

pub(crate) fn battle_phase(ctx:&SessionView,key:&str)->serde_json::Value{battle::phase(ctx,key)}
pub(crate) fn battle_has_pending(ctx:&SessionContext,operation:&str,agent:u32)->bool{battle::has_pending(ctx,operation,agent)}

pub(crate) fn battle_target_pending(ctx:&SessionContext,role:&str,target:u32,agent:u32)->bool{battle::target_pending(ctx,role,target,agent)}
pub(crate) fn battle_target_changing(ctx:&SessionContext,target:u32)->bool{battle::target_changing(ctx,target)}

impl ScopedRow for Session { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.id=entity_key(session,self.id);self} fn local(mut self)->Self{self.id=local_entity(self.session_id,self.id);self}}

impl ScopedRow for ChatClock { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.id=entity_key(session,self.id);self} fn local(mut self)->Self{self.id=local_entity(self.session_id,self.id);self}}

impl ScopedRow for Drone { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.id=entity_key(session,self.id);self} fn local(mut self)->Self{self.id=local_entity(self.session_id,self.id);self}}

impl ScopedRow for Agent { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.id=entity_key(session,self.id);self} fn local(mut self)->Self{self.id=local_entity(self.session_id,self.id);self}}

impl ScopedRow for AgentProfile { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.id=entity_key(session,self.id);self} fn local(mut self)->Self{self.id=local_entity(self.session_id,self.id);self}}

impl ScopedRow for Evidence { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self} fn local(mut self)->Self{self}}

impl ScopedRow for Hold { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.drone=entity_key(session,self.drone);self} fn local(mut self)->Self{self.drone=local_entity(self.session_id,self.drone);self}}

impl ScopedRow for Discovery { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.drone=entity_key(session,self.drone);self} fn local(mut self)->Self{self.drone=local_entity(self.session_id,self.drone);self}}

impl ScopedRow for DroneSchedule { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.id=entity_key(session,self.id);self} fn local(mut self)->Self{self.id=local_entity(self.session_id,self.id);self}}

impl ScopedRow for AgentSchedule { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.id=entity_key(session,self.id);self} fn local(mut self)->Self{self.id=local_entity(self.session_id,self.id);self}}

impl ScopedRow for ChatAction { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.key=session_key(session,&self.key);self} fn local(mut self)->Self{self.key=local_key(self.session_id,&self.key);self}}

pub(crate) fn initialize_visitor(ctx:&SessionContext)->Result<(),String>{start_fleet_impl(ctx,formation::DRONES,0,0,false)}

pub(crate) fn delete_session_state(raw:&spacetimedb::ReducerContext,session:u32){
for row in raw.db.fleet_session().session_id().filter(session){raw.db.fleet_session().id().delete(row.id);}
for row in raw.db.fleet_chat_clock().session_id().filter(session){raw.db.fleet_chat_clock().id().delete(row.id);}
for row in raw.db.fleet_drone().session_id().filter(session){raw.db.fleet_drone().id().delete(row.id);}
for row in raw.db.fleet_agent().session_id().filter(session){raw.db.fleet_agent().id().delete(row.id);}
for row in raw.db.fleet_agent_profile().session_id().filter(session){raw.db.fleet_agent_profile().id().delete(row.id);}
for row in raw.db.fleet_evidence().session_id().filter(session){raw.db.fleet_evidence().id().delete(row.id);}
for row in raw.db.fleet_hold().session_id().filter(session){raw.db.fleet_hold().drone().delete(row.drone);}
for row in raw.db.fleet_discovery().session_id().filter(session){raw.db.fleet_discovery().drone().delete(row.drone);}
for row in raw.db.drone_schedule().session_id().filter(session){raw.db.drone_schedule().id().delete(row.id);}
for row in raw.db.agent_schedule().session_id().filter(session){raw.db.agent_schedule().id().delete(row.id);}
for row in raw.db.fleet_chat_action().session_id().filter(session){raw.db.fleet_chat_action().key().delete(row.key);}
}
