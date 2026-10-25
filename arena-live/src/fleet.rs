//! Independent synthetic fleet. Private tables; identity-scoped subscription views.
use spacetimedb::{table,reducer,view,Identity,ReducerContext,ViewContext,Table,ScheduleAt};
use std::time::Duration;
#[path="resilience.rs"]
mod resilience;
#[path="battle.rs"]
mod battle;
#[table(accessor=fleet_principal)]
pub struct Principal { #[primary_key] identity:Identity, role:String }
#[table(accessor=fleet_session)]
pub struct Session { #[primary_key] pub(crate) id:u32, pub(crate) epoch:u64, active:bool, hardened:bool, drones:u32, deadline:i64 }
// Separate clock keeps existing timed fixture sessions and their schema compatible.
#[table(accessor=fleet_chat_clock)]
pub struct ChatClock { #[primary_key] id:u32, epoch:u64, started:i64 }
#[table(accessor=fleet_drone)]
#[derive(Clone)]
pub struct Drone { #[primary_key] id:u32, #[index(btree)] epoch:u64, x:f32,y:f32,z:f32, battery:f32, tick:u32, controller:String, isolated:bool, policy_version:u32, commands:u32, rejected:u32 }
#[table(accessor=fleet_agent)]
#[derive(Clone)]
pub struct Agent { #[primary_key] id:u32, #[index(btree)] epoch:u64, role:String, step:u32, target:u32, last_action:String }
#[table(accessor=fleet_agent_profile)]
#[derive(Clone)]
pub struct AgentProfile { #[primary_key] pub id:u32, #[index(btree)] epoch:u64, role:String, name:String, specialty:String, operation:String }
#[view(accessor=visible_agent_profiles,public)]
pub fn visible_agent_profiles(ctx:&ViewContext)->Vec<AgentProfile>{let r=role(ctx);let Some(s)=ctx.db.fleet_session().id().find(0)else{return vec![]};ctx.db.fleet_agent_profile().epoch().filter(s.epoch).filter(|a|r=="observer"||a.role==r).collect()}

#[table(accessor=fleet_evidence)]
#[derive(Clone)]
pub struct Evidence { #[primary_key] #[auto_inc] id:u64, #[index(btree)] epoch:u64, at:i64, actor:u32, drone:u32, kind:String, status:u32, policy_version:u32 }
/// When the attacker took each currently hijacked drone. Private; drives the motion model only.
#[table(accessor=fleet_hold)]
pub struct Hold { #[primary_key] drone:u32, epoch:u64, since:i64 }
#[table(accessor=fleet_discovery)]
pub struct Discovery { #[primary_key] drone:u32, epoch:u64 }
#[table(accessor=drone_schedule,scheduled(drone_tick))]
pub struct DroneSchedule { #[primary_key] id:u64, scheduled_at:ScheduleAt, epoch:u64 }
#[table(accessor=agent_schedule,scheduled(agent_tick))]
pub struct AgentSchedule { #[primary_key] id:u64, scheduled_at:ScheduleAt, epoch:u64 }
fn owner(ctx:&ReducerContext)->Result<(),String>{
 if crate::hosted_scheduler(ctx){return Ok(())}
 if ctx.db.publisher().id().find(0).map(|p|p.identity)!=Some(ctx.sender()){return Err("Owner required".into())} Ok(())
}
use crate::{publisher,publisher__view};
use crate::formation;
/// Fixture defenders only respond to a takeover held this long, so a hijack visibly pulls the
/// drone out of formation before recovery. Detection latency is a fixture decision, not measured.
const DETECT_AFTER_US:i64=4_000_000;
fn match_start(ctx:&ReducerContext)->i64{
 ctx.db.fleet_chat_clock().id().find(0).map(|c|c.started).unwrap_or_else(||ctx.db.fleet_session().id().find(0).map(|s|s.deadline-60_000_000).unwrap_or(0))
}
fn emit(ctx:&ReducerContext,epoch:u64,actor:u32,d:&Drone,kind:&str,status:u32){ctx.db.fleet_evidence().insert(Evidence{id:0,epoch,at:ctx.timestamp.to_micros_since_unix_epoch(),actor,drone:d.id,kind:kind.into(),status,policy_version:d.policy_version});}
#[reducer]
pub fn grant_fleet_view(ctx:&ReducerContext,identity:String,role:String)->Result<(),String>{owner(ctx)?;let identity=Identity::from_hex(identity).map_err(|_|"Invalid identity")?;if !["attacker","defender","observer"].contains(&role.as_str()){return Err("Invalid role".into())} if ctx.db.fleet_principal().identity().find(identity).is_some(){ctx.db.fleet_principal().identity().update(Principal{identity,role});}else{ctx.db.fleet_principal().insert(Principal{identity,role});} Ok(())}
#[reducer]
pub fn start_fleet(ctx:&ReducerContext,drones:u32,attackers:u32,defenders:u32,hardened:bool)->Result<(),String>{
 owner(ctx)?;start_fleet_impl(ctx,drones,attackers,defenders,hardened)
}
fn start_fleet_impl(ctx:&ReducerContext,drones:u32,attackers:u32,defenders:u32,hardened:bool)->Result<(),String>{
 if !(1..=256).contains(&drones)||!(0..=32).contains(&attackers)||!(0..=32).contains(&defenders){return Err("Fleet/agent limits exceeded".into())}
 crate::backend::cancel_chat_session(ctx);
 for p in ctx.db.fleet_agent_profile().iter(){ctx.db.fleet_agent_profile().id().delete(p.id);}
 resilience::clear(ctx);
 battle::clear(ctx);
 let epoch=ctx.db.fleet_session().id().find(0).map(|s|s.epoch+1).unwrap_or(1);
 ctx.db.fleet_chat_clock().id().delete(0);
 for d in ctx.db.drone_schedule().iter(){ctx.db.drone_schedule().id().delete(d.id);} for a in ctx.db.agent_schedule().iter(){ctx.db.agent_schedule().id().delete(a.id);}
 for d in ctx.db.fleet_drone().iter(){ctx.db.fleet_drone().id().delete(d.id);}for a in ctx.db.fleet_agent().iter(){ctx.db.fleet_agent().id().delete(a.id);}for d in ctx.db.fleet_discovery().iter(){ctx.db.fleet_discovery().drone().delete(d.drone);}for h in ctx.db.fleet_hold().iter(){ctx.db.fleet_hold().drone().delete(h.drone);}
 ctx.db.fleet_session().id().delete(0);ctx.db.fleet_session().insert(Session{id:0,epoch,active:true,hardened,drones,deadline:if attackers+defenders==0{0}else{ctx.timestamp.to_micros_since_unix_epoch()+60_000_000}});
 if attackers+defenders==0{ctx.db.fleet_chat_clock().insert(ChatClock{id:0,epoch,started:ctx.timestamp.to_micros_since_unix_epoch()});}
 for id in 1..=drones{let (x,y,z)=formation::formation(id,0.);ctx.db.fleet_drone().insert(Drone{id,epoch,x,y,z,battery:100.,tick:0,controller:"defender".into(),isolated:hardened,policy_version:0,commands:0,rejected:0});ctx.db.drone_schedule().insert(DroneSchedule{id:id as u64,epoch,scheduled_at:Duration::from_millis(180+(id%7) as u64*20).into()});}
 if drones==6&&attackers+defenders==0{resilience::start(ctx,epoch);}
 for id in 1..=attackers+defenders{let role=if id<=attackers{"attacker"}else{"defender"};ctx.db.fleet_agent().insert(Agent{id,epoch,role:role.into(),step:0,target:(id-1)%drones+1,last_action:"ready".into()});ctx.db.agent_schedule().insert(AgentSchedule{id:id as u64,epoch,scheduled_at:Duration::from_millis(350+(id%9) as u64*37).into()});}Ok(())
}
pub(crate) fn reset_chat_fleet(ctx:&ReducerContext,demo:bool)->Result<(),String>{
 owner(ctx)?;reset_chat_fleet_impl(ctx,demo)
}
fn reset_chat_fleet_impl(ctx:&ReducerContext,_demo:bool)->Result<(),String>{
 let s=ctx.db.fleet_session().id().find(0).ok_or("Fleet missing")?;
 start_fleet_impl(ctx,s.drones,0,0,s.hardened)?;
 let epoch=ctx.db.fleet_session().id().find(0).unwrap().epoch;
 for e in ctx.db.fleet_evidence().iter(){ctx.db.fleet_evidence().id().delete(e.id);}
 for a in ctx.db.fleet_chat_action().iter(){ctx.db.fleet_chat_action().key().delete(a.key);}
 // Verify the initial pose within the reset transaction, before movement can resume.
 for d in ctx.db.fleet_drone().iter(){
  let (x,y,z)=formation::formation(d.id,0.);
  if d.epoch!=epoch||d.controller!="defender"||d.policy_version!=0||d.isolated!=s.hardened||d.battery!=100.||d.tick!=0||d.commands!=0||d.rejected!=0||(d.x,d.y,d.z)!=(x,y,z){return Err("Fleet reset verification failed".into())}
 }
 Ok(())
}
#[reducer]
pub fn stop_fleet(ctx:&ReducerContext)->Result<(),String>{owner(ctx)?;crate::backend::cancel_chat_session(ctx);battle::stop(ctx);if let Some(mut s)=ctx.db.fleet_session().id().find(0){s.active=false;ctx.db.fleet_session().id().update(s);} for t in ctx.db.drone_schedule().iter(){ctx.db.drone_schedule().id().delete(t.id);}for t in ctx.db.agent_schedule().iter(){ctx.db.agent_schedule().id().delete(t.id);}Ok(())}
fn live(ctx:&ReducerContext,epoch:u64)->bool{ctx.db.fleet_session().id().find(0).map(|s|s.active&&s.epoch==epoch&&(s.deadline==0||ctx.timestamp.to_micros_since_unix_epoch()<s.deadline)).unwrap_or(false)}
#[reducer]
pub fn drone_tick(ctx:&ReducerContext,timer:DroneSchedule){if ctx.sender()!=ctx.database_identity(){panic!("Scheduler only")}if !live(ctx,timer.epoch){if ctx.db.drone_schedule().id().find(timer.id).map(|s|s.epoch)==Some(timer.epoch){ctx.db.drone_schedule().id().delete(timer.id);}return}if let Some(mut d)=ctx.db.fleet_drone().id().find(timer.id as u32){d.tick+=1;d.battery=(d.battery-0.003).max(0.);
 if resilience::enabled(ctx){resilience::tick(ctx,&mut d);ctx.db.fleet_drone().id().update(d);return}
 if battle::enabled(ctx)&&d.isolated{d.z=(d.z-0.4).max(3.);ctx.db.fleet_drone().id().update(d);return}
 // Healthy drones follow the shared match clock; a held drone follows the attacker's pull instead.
 let start=match_start(ctx);let secs=|us:i64|(us-start) as f32/1e6;let t=secs(ctx.timestamp.to_micros_since_unix_epoch());
 let hold=if d.controller=="defender"{None}else{ctx.db.fleet_hold().drone().find(d.id)};
 let target=match &hold{Some(h)=>{let since=secs(h.since);formation::hijacked(d.id,since,t-since)}None=>formation::formation(d.id,t)};
 let (x,y,z)=formation::step((d.x,d.y,d.z),target,hold.is_none());d.x=x;d.y=y;d.z=z;d.commands+=1;ctx.db.fleet_drone().id().update(d);}}
fn command(d:&mut Drone,authorized:bool)->u32{if !authorized&&d.isolated{d.rejected+=1;403}else{if !authorized{d.controller="attacker".into();}d.commands+=1;200}}
#[reducer]
pub fn agent_tick(ctx:&ReducerContext,timer:AgentSchedule){if ctx.sender()!=ctx.database_identity(){panic!("Scheduler only")}if !live(ctx,timer.epoch){if ctx.db.agent_schedule().id().find(timer.id).map(|s|s.epoch)==Some(timer.epoch){ctx.db.agent_schedule().id().delete(timer.id);}return}let Some(mut a)=ctx.db.fleet_agent().id().find(timer.id as u32)else{return};let count=ctx.db.fleet_session().id().find(0).unwrap().drones;
 if a.role=="attacker"{let mut d=ctx.db.fleet_drone().id().find(a.target).unwrap();if a.step%2==0{if ctx.db.fleet_discovery().drone().find(d.id).is_none(){ctx.db.fleet_discovery().insert(Discovery{drone:d.id,epoch:a.epoch});}emit(ctx,a.epoch,a.id,&d,"discovered",200);a.last_action="discover".into();}else{let status=command(&mut d,false);emit(ctx,a.epoch,a.id,&d,if status==200{"unauthorized_command_accepted"}else{"unauthorized_command_blocked"},status);if status==200&&ctx.db.fleet_hold().drone().find(d.id).is_none(){ctx.db.fleet_hold().insert(Hold{drone:d.id,epoch:a.epoch,since:ctx.timestamp.to_micros_since_unix_epoch()});}a.last_action=format!("command: {}",status);ctx.db.fleet_drone().id().update(d);a.target=a.target%count+1;}}
 else{let now=ctx.timestamp.to_micros_since_unix_epoch();
 // Oldest detected breach first; a breach is detected once held for DETECT_AFTER_US.
 let target=ctx.db.fleet_drone().iter().filter(|d|d.controller=="attacker").filter_map(|d|{let since=ctx.db.fleet_hold().drone().find(d.id).map(|h|h.since).unwrap_or(0);(now-since>=DETECT_AFTER_US).then_some((since,d))}).min_by_key(|(since,d)|(*since,d.id)).map(|(_,d)|d);if let Some(mut d)=target{a.target=d.id;d.isolated=true;d.policy_version+=1;emit(ctx,a.epoch,a.id,&d,"policy_applied",200);let bad=command(&mut d,false);let good=command(&mut d,true);if bad==403&&good==200{d.controller="defender".into();ctx.db.fleet_hold().drone().delete(d.id);emit(ctx,a.epoch,a.id,&d,"recovery_verified",200);}ctx.db.fleet_drone().id().update(d);a.last_action="verify recovery".into();}else{a.last_action="monitor".into();}}
 a.step+=1;ctx.db.fleet_agent().id().update(a);
}
fn role(ctx:&ViewContext)->String{ctx.db.fleet_principal().identity().find(ctx.sender()).map(|p|p.role).unwrap_or_default()}
#[view(accessor=visible_drones,public)]
pub fn visible_drones(ctx:&ViewContext)->Vec<Drone>{let r=role(ctx);if r.is_empty(){return vec![]}ctx.db.fleet_drone().epoch().filter(0u64..) .filter(|d|r!="attacker"||ctx.db.fleet_discovery().drone().find(d.id).is_some()).map(|mut d|{if r=="attacker"{d.isolated=false;d.policy_version=0;d.battery=0.;d.rejected=0;d.commands=0;}d}).collect()}
#[view(accessor=visible_agents,public)]
pub fn visible_agents(ctx:&ViewContext)->Vec<Agent>{let r=role(ctx);ctx.db.fleet_agent().epoch().filter(0u64..) .filter(|a|r=="observer"||a.role==r).collect()}
#[view(accessor=visible_evidence,public)]
pub fn visible_evidence(ctx:&ViewContext)->Vec<Evidence>{let r=role(ctx);if r.is_empty(){return vec![]}let Some(session)=ctx.db.fleet_session().id().find(0)else{return vec![]};ctx.db.fleet_evidence().epoch().filter(session.epoch).filter(|e|r=="observer"||if r=="attacker"{e.kind=="discovered"||e.kind=="limited_access"||e.kind.starts_with("unauthorized_command")||e.kind.starts_with("challenge_")||e.kind=="attempt_resolved"&&ctx.db.fleet_agent().id().find(e.actor).map(|a|a.role=="attacker").unwrap_or(false)}else{e.kind!="discovered"&&!e.kind.starts_with("challenge_")}).map(|mut e|{if r=="defender"&&(e.kind.starts_with("unauthorized_command")||ctx.db.fleet_agent().id().find(e.actor).map(|a|a.role=="attacker").unwrap_or(false)){e.actor=0;}if r=="attacker"{e.policy_version=0;}e}).collect()}

// Explicitly switch security decisions from scheduled fixtures to external model workers.
#[reducer]
pub fn enable_fleet_chat(ctx:&ReducerContext)->Result<(),String>{
 owner(ctx)?;
 // Retire unused fixture seeds, preserving every worker referenced by actual plans or evidence.
 for a in ctx.db.fleet_agent().iter(){
  if !crate::backend::has_agent_assignment(ctx,a.epoch,a.id)&&!ctx.db.fleet_evidence().epoch().filter(a.epoch).any(|e|e.actor==a.id){ctx.db.fleet_agent().id().delete(a.id);}
 }
 for t in ctx.db.agent_schedule().iter(){ctx.db.agent_schedule().id().delete(t.id);}
 if !resilience::enabled(ctx){if let Some(s)=ctx.db.fleet_session().id().find(0){battle::start(ctx,s.epoch);}}
 Ok(())
}
#[table(accessor=fleet_chat_action)]
pub struct ChatAction { #[primary_key] key:String, evidence_id:u64, kind:String, target:u32, version:u32, unauthorized_evidence_id:u64, authorized_evidence_id:u64 }
#[reducer]
pub fn execute_fleet_chat_action(ctx:&ReducerContext,session:String,operation:String,sequence:u32,agent:u32,target:u32,kind:String,version:u32)->Result<(),String>{
 owner(ctx)?;
 let mut a=ctx.db.fleet_agent().id().find(agent).ok_or("Agent missing")?;
 let role=crate::backend::chat_authority(ctx,&session,&operation,agent,target,a.epoch)?;
 if !resilience::enabled(ctx){crate::backend::check_goal_action(ctx,&operation,agent,&kind)?;}
 if !live(ctx,a.epoch)||a.role!=role||!(1..=8).contains(&sequence) {return Err("Invalid agent action".into())}
 let key=format!("{}:{}:{}",operation,agent,sequence);
 if let Some(old)=ctx.db.fleet_chat_action().key().find(&key){return if old.kind==kind&&old.target==target&&old.version==version {Ok(())}else{Err("Action idempotency conflict".into())}}
 if sequence>1 && ctx.db.fleet_chat_action().key().find(format!("{}:{}:{}",operation,agent,sequence-1)).is_none(){return Err("Out of order action".into())}
 if sequence>1&&battle::pending(ctx,&format!("{}:{}:{}",operation,agent,sequence-1)){return Err("Previous attempt pending".into())}
 let mut d=ctx.db.fleet_drone().id().find(target).ok_or("Drone missing")?;
 if d.epoch!=a.epoch{return Err("Stale drone".into())}
 let unauthorized_evidence_id=0;let authorized_evidence_id=0;
 if !resilience::enabled(ctx)&&kind!="discover"&&kind!="wait"{
  battle::queue(ctx,&key,&operation,&role,agent,target,&kind,version)?;
  a.target=target;a.step+=1;a.last_action=format!("queued {} attempt",kind);ctx.db.fleet_agent().id().update(a);
  ctx.db.fleet_chat_action().insert(ChatAction{key,evidence_id:0,kind,target,version,unauthorized_evidence_id:0,authorized_evidence_id:0});return Ok(())
 }
 if resilience::enabled(ctx)&&kind!="discover"&&kind!="wait" {
 resilience::apply(ctx,&role,agent,&mut d,&kind,version)?;
 } else {
 if resilience::enabled(ctx)&&role=="defender"&&kind!="wait"{return Err("Action not permitted".into())}
 match (role.as_str(),kind.as_str()) {
 ("attacker","discover")=>{if ctx.db.fleet_discovery().drone().find(target).is_none(){ctx.db.fleet_discovery().insert(Discovery{drone:target,epoch:a.epoch});}emit(ctx,a.epoch,agent,&d,"discovered",200);},
 (_,"wait")=>{},
 _=>return Err("Action not permitted".into())
 }
 }
 let waiting=kind=="wait";a.target=target;a.step+=1;a.last_action=kind.clone();
 ctx.db.fleet_agent().id().update(a);ctx.db.fleet_drone().id().update(d);let evidence_id=if waiting {0}else{ctx.db.fleet_evidence().iter().filter(|e|e.actor==agent&&e.drone==target).map(|e|e.id).max().unwrap_or(0)};ctx.db.fleet_chat_action().insert(ChatAction{key,evidence_id,kind:kind.clone(),target,version,unauthorized_evidence_id,authorized_evidence_id});if kind=="discover"&&battle::enabled(ctx){battle::refresh(ctx);}Ok(())
}

pub(crate) fn validate_chat_fleet(ctx:&ReducerContext,epoch:u64)->Result<(),String>{
 if !live(ctx,epoch){return Err("Fleet inactive or stale".into())}Ok(())
}
#[derive(spacetimedb::SpacetimeType)]
pub struct FleetAccess { identity:Identity, role:String }
#[view(accessor=visible_fleet_access,public)]
pub fn visible_fleet_access(ctx:&ViewContext)->Vec<FleetAccess>{
 if ctx.db.publisher().id().find(0).map(|p|p.identity)==Some(ctx.sender()){return vec![]}
 let r=role(ctx);if r.is_empty(){return vec![]}vec![FleetAccess{identity:ctx.sender(),role:r}]
}

pub(crate) fn validate_chat_target(ctx:&ReducerContext,role:&str,target:u32)->Result<(),String>{
 let d=ctx.db.fleet_drone().id().find(target).ok_or("Selected drone is not visible")?;
 if role=="attacker" && ctx.db.fleet_discovery().drone().find(target).map(|r|r.epoch)!=Some(d.epoch){return Err("Selected drone is not visible".into())}Ok(())
}

// Called only by the leased backend. Session movement is independent of operation budgets.
pub(crate) fn activate_chat_fleet(ctx:&ReducerContext,role:&str)->Result<(),String>{
 owner(ctx)?;
 if let Some(s)=ctx.db.fleet_session().id().find(0){if s.active&&s.deadline==0{return Ok(())}}
 if !["attacker","defender"].contains(&role){return Err("Invalid role".into())}
 if ctx.db.fleet_session().id().find(0).is_none(){start_fleet(ctx,120,0,0,false)?;}
 let mut s=ctx.db.fleet_session().id().find(0).unwrap();
 if ctx.db.fleet_chat_clock().id().find(0).is_none(){ctx.db.fleet_chat_clock().insert(ChatClock{id:0,epoch:s.epoch,started:if s.deadline>0{s.deadline-60_000_000}else{ctx.timestamp.to_micros_since_unix_epoch()}});}
 s.deadline=0;s.active=true;
 for d in ctx.db.fleet_drone().epoch().filter(s.epoch){
  if ctx.db.drone_schedule().id().find(d.id as u64).is_none(){ctx.db.drone_schedule().insert(DroneSchedule{id:d.id as u64,epoch:s.epoch,scheduled_at:Duration::from_millis(180+(d.id%7) as u64*20).into()});}
 }
 ctx.db.fleet_session().id().update(s);
 enable_fleet_chat(ctx)
}


pub(crate) fn deploy_chat_agent(ctx:&ReducerContext,role:&str,epoch:u64,id:u32,target:u32,name:&str,specialty:&str,operation:&str)->Result<(),String>{
 if id==0||ctx.db.fleet_agent().id().find(id).is_some()||ctx.db.fleet_agent_profile().id().find(id).is_some(){return Err("Agent identity collision".into())}
 let d=ctx.db.fleet_drone().id().find(target).ok_or("Drone missing")?;
 if d.epoch!=epoch||!["attacker","defender"].contains(&role){return Err("Outside role or epoch".into())}
 ctx.db.fleet_agent().insert(Agent{id,epoch,role:role.into(),step:0,target,last_action:"deployed".into()});
 ctx.db.fleet_agent_profile().insert(AgentProfile{id,epoch,role:role.into(),name:name.into(),specialty:specialty.into(),operation:operation.into()});
 Ok(())
}

#[derive(spacetimedb::SpacetimeType)]
pub struct FleetSessionState { epoch:u64, active:bool, conversation:u64 }
#[view(accessor=visible_fleet_session,public)]
pub fn visible_fleet_session(ctx:&ViewContext)->Vec<FleetSessionState>{
 if role(ctx).is_empty(){return vec![]}ctx.db.fleet_session().id().find(0).map(|s|FleetSessionState{epoch:s.epoch,active:s.active,conversation:crate::backend::visible_conversation_generation(ctx,&role(ctx))}).into_iter().collect()
}


// Role-scoped input for hosted inference; catalog addresses do not reveal undiscovered telemetry.
pub(crate) fn hosted_role(ctx:&ReducerContext)->String {
 ctx.db.fleet_principal().identity().find(ctx.sender()).map(|p|p.role).unwrap_or_default()
}
pub(crate) fn hosted_permission(ctx:&ReducerContext,identity:Identity,role:&str)->bool {
 ctx.db.fleet_principal().identity().find(identity).map(|p|p.role==role).unwrap_or(false)
}
pub(crate) fn hosted_context(ctx:&ReducerContext,role:&str,target:u32)->serde_json::Value {
 let Some(s)=ctx.db.fleet_session().id().find(0)else{return serde_json::Value::Null};
 let drones:Vec<_>=ctx.db.fleet_drone().epoch().filter(s.epoch).filter(|d|(target==0||d.id==target)&&(role=="defender"||ctx.db.fleet_discovery().drone().find(d.id).map(|k|k.epoch)==Some(s.epoch))).map(|d|if role=="attacker"{serde_json::json!({"id":d.id,"controller":d.controller})}else{serde_json::json!({"id":d.id,"controller":d.controller,"isolated":d.isolated,"policyVersion":d.policy_version})}).collect();
 let mut evidence:Vec<_>=ctx.db.fleet_evidence().epoch().filter(s.epoch).filter(|e|(target==0||e.drone==target)&&if role=="attacker"{e.kind=="discovered"||e.kind.starts_with("unauthorized_command")}else{e.kind!="discovered"&&!e.kind.starts_with("challenge_")}).collect();
 evidence.sort_by_key(|e|e.id);let evidence:Vec<_>=evidence.iter().rev().take(16).map(|e|serde_json::json!({"id":e.id,"target":e.drone,"kind":e.kind,"status":e.status})).collect();
 serde_json::json!({"session":{"active":s.active,"epoch":s.epoch},"catalog":{"targetIds":(1..=s.drones).collect::<Vec<_>>(),"communicationGraph":"16-column grid; horizontal neighbors in the same row and IDs 16 apart; isolation breaks incident links","discoveryAvailableBeforeObservation":role=="attacker"},"observations":drones,"battle":battle::context(ctx,role,target),"evidence":evidence})
}
pub(crate) fn hosted_receipt(ctx:&ReducerContext,key:&str)->serde_json::Value {
 let Some(r)=ctx.db.fleet_chat_action().key().find(key.to_string())else{return serde_json::Value::Null};
 let e=ctx.db.fleet_evidence().id().find(r.evidence_id);
 let mut receipt=serde_json::json!({"evidenceId":r.evidence_id,"outcome":e.as_ref().map(|e|e.kind.as_str()).unwrap_or("wait"),"responseStatus":e.as_ref().map(|e|e.status),"policyVersion":e.as_ref().map(|e|e.policy_version),"verificationEvidenceIds":([r.unauthorized_evidence_id,r.authorized_evidence_id].into_iter().filter(|n|*n>0).collect::<Vec<_>>())});
 if let Some(b)=battle::receipt(ctx,key){receipt["stage"]=b["stage"].clone();receipt["simulation"]=b["simulation"].clone();if b["stage"]=="resolved"&&!b["simulation"]["outcome"].is_null(){receipt["outcome"]=b["simulation"]["outcome"].clone();}}receipt
}
pub(crate) fn hosted_reset(ctx:&ReducerContext,epoch:u64,demo:bool)->Result<(),String>{
 if hosted_role(ctx)!="defender" {return Err("Defender required".into())}
 validate_chat_fleet(ctx,epoch)?;
 // The internal reset entry point is only reached after a role grant and current-epoch check.
 reset_chat_fleet_impl(ctx,demo)
}

pub(crate) fn view_role(ctx:&ViewContext)->String{role(ctx)}
pub(crate) fn hosted_policy(ctx:&ReducerContext,target:u32)->Result<u32,String>{ctx.db.fleet_drone().id().find(target).map(|d|d.policy_version).ok_or("Drone missing".into())}
pub(crate) fn hosted_next_agent(ctx:&ReducerContext)->Result<u32,String>{ctx.db.fleet_agent().iter().map(|a|a.id).chain(ctx.db.fleet_agent_profile().iter().map(|a|a.id)).max().unwrap_or(0).checked_add(1).ok_or("Agent identity exhausted".into())}

pub(crate) fn battle_options(ctx:&ReducerContext,role:&str,target:u32)->serde_json::Value{battle::options(ctx,role,target)}
pub(crate) fn battle_goal_done(ctx:&ReducerContext,goal:&str,target:u32,report:&serde_json::Value)->bool{battle::goal_done(ctx,goal,target,report)}

pub(crate) fn battle_phase(ctx:&ViewContext,key:&str)->serde_json::Value{battle::phase(ctx,key)}
pub(crate) fn battle_has_pending(ctx:&ReducerContext,operation:&str,agent:u32)->bool{battle::has_pending(ctx,operation,agent)}
