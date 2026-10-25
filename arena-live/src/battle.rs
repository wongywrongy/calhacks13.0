//! Authoritative virtual battle attempts. Models choose; scheduled reducers resolve.
use super::*;
use serde_json::{json, Value};

#[table(accessor=battle_state)]
pub struct Battle { #[primary_key] id:u32, epoch:u64, seed:u64, tick:u64, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
#[table(accessor=battle_drone ,index(accessor=session_epoch, btree(columns=[session_id,epoch])))]
#[derive(Clone)]
pub struct Health { #[primary_key] drone:u32, #[index(btree)] epoch:u64, contamination:u32, readiness:u32, attack_prepared:bool, defense_prepared:bool, countermeasure:u64, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
// Terminal attempts are retained with mission receipts; current work uses stage/epoch indexes.
#[table(accessor=battle_attempt ,index(accessor=session_epoch, btree(columns=[session_id,epoch])),index(accessor=session_operation, btree(columns=[session_id,operation])),index(accessor=session_stage, btree(columns=[session_id,stage])))]
#[derive(Clone)]
pub struct Attempt {
 #[primary_key] key:String, #[index(btree)] epoch:u64, #[index(btree)] operation:String, role:String, agent:u32, target:u32, kind:String,
 #[index(btree)] stage:String, started:u64, sources:String, targets:String, report:String, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
#[table(accessor=battle_retry)]
pub struct Retry { #[primary_key] key:String, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
#[table(accessor=battle_schedule,scheduled(battle_tick))]
pub struct BattleSchedule { #[primary_key] id:u64, epoch:u64, scheduled_at:ScheduleAt, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
#[derive(spacetimedb::SpacetimeType)]
pub struct VisibleHealth { drone:u32, contamination:u32, operational:bool, readiness:u32 }
#[derive(spacetimedb::SpacetimeType)]
pub struct VisibleAttempt { key:String, agent:u32, target:u32, kind:String, stage:String, report:String }
#[derive(spacetimedb::SpacetimeType)]
pub struct AttemptActivity { key:String, epoch:u64, operation:String, role:String, agent:u32, target:u32, kind:String, stage:String, at:i64, report:String }
#[table(accessor=battle_options ,index(accessor=session_role, btree(columns=[session_id,role])))]
#[derive(Clone, PartialEq)]
pub struct Options { #[primary_key] key:String, epoch:u64, #[index(btree)] role:String, drone:u32, actions:Vec<String>, reachable:Vec<u32>, blocker:String, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
#[view(accessor=visible_battle_options,public)]
pub fn visible_battle_options(raw:&spacetimedb::ViewContext) ->Vec<Options> { let ctx=SessionView::for_sender(raw);visible_battle_options_scoped(&ctx) }
pub(crate) fn visible_battle_options_scoped(ctx:&SessionView)->Vec<Options>{
 let r=role(ctx);let mut rows=vec![];
 for team in ["attacker","defender"]{if r==team||r=="observer"{rows.extend(ctx.db.battle_options().session_role().filter((ctx.session_id,team)).map(ScopedRow::local).filter(|o|team!="attacker"||r=="observer"||ctx.db.fleet_discovery().drone().find(entity_key(ctx.session_id, o.drone)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_some()));}}
 rows
}
#[view(accessor=visible_attempt_activity,public)]
pub fn visible_attempt_activity(raw:&spacetimedb::ViewContext) ->Vec<AttemptActivity> { let ctx=SessionView::for_sender(raw);visible_attempt_activity_scoped(&ctx) }
pub(crate) fn visible_attempt_activity_scoped(ctx:&SessionView)->Vec<AttemptActivity>{
 let r=role(ctx);if r.is_empty(){return vec![]}
 let Some(session)=ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local)else{return vec![]};
 ctx.db.battle_attempt().session_epoch().filter((ctx.session_id,session.epoch)).map(ScopedRow::local).filter(|a|r=="observer"||a.role==r).map(|a|{
  let report:Value=serde_json::from_str(&a.report).unwrap_or(Value::Null);
  let at=report["at"].as_i64().unwrap_or_else(||ctx.db.fleet_chat_action().key().find(session_key(ctx.session_id, &(&a.key))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).and_then(|r|ctx.db.fleet_evidence().id().find(r.evidence_id).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local)).map(|e|e.at).unwrap_or(0));
  AttemptActivity{key:a.key,epoch:a.epoch,operation:a.operation,role:a.role,agent:a.agent,target:a.target,kind:a.kind,stage:a.stage,at,report:a.report}
 }).collect()
}

#[view(accessor=visible_battle_drones,public)]
pub fn visible_battle_drones(raw:&spacetimedb::ViewContext) ->Vec<VisibleHealth> { let ctx=SessionView::for_sender(raw);visible_battle_drones_scoped(&ctx) }
pub(crate) fn visible_battle_drones_scoped(ctx:&SessionView)->Vec<VisibleHealth>{
 let r=role(ctx);if r.is_empty(){return vec![]}
 let Some(session)=ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local)else{return vec![]};
 ctx.db.battle_drone().session_epoch().filter((ctx.session_id,session.epoch)).map(ScopedRow::local).filter_map(|h|{
  let d=ctx.db.fleet_drone().id().find(entity_key(ctx.session_id, h.drone)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local)?;
  if r=="attacker"&&ctx.db.fleet_discovery().drone().find(entity_key(ctx.session_id, d.id)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_none(){return None}
  Some(VisibleHealth{drone:d.id,contamination:h.contamination,operational:!d.isolated,readiness:if r=="attacker"{0}else{h.readiness}})
 }).collect()
}
#[view(accessor=visible_battle_attempts,public)]
pub fn visible_battle_attempts(raw:&spacetimedb::ViewContext) ->Vec<VisibleAttempt> { let ctx=SessionView::for_sender(raw);visible_battle_attempts_scoped(&ctx) }
pub(crate) fn visible_battle_attempts_scoped(ctx:&SessionView)->Vec<VisibleAttempt>{
 let r=role(ctx);if r.is_empty(){return vec![]}
 // Opponents see local effects through their own telemetry, never private plans or rolls.
 let Some(session)=ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local)else{return vec![]};
 ctx.db.battle_attempt().session_epoch().filter((ctx.session_id,session.epoch)).map(ScopedRow::local).filter(|a|r=="observer"||a.role==r).map(|a|VisibleAttempt{key:a.key,agent:a.agent,target:a.target,kind:a.kind,stage:a.stage,report:a.report}).collect()
}
pub(super) fn enabled(ctx:&SessionContext)->bool{ctx.db.battle_state().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_some()}
pub(super) fn stop(ctx:&SessionContext){
 ctx.db.battle_schedule().id().delete(entity_key(ctx.session_id, 0));
 for mut a in ctx.db.battle_attempt().session_stage().filter((ctx.session_id,.."resolved")).map(ScopedRow::local){
  a.stage="resolved".into();a.report=json!({"simulated":true,"summary":"Attempt interrupted: fleet stopped.","at":ctx.timestamp.to_micros_since_unix_epoch(),"succeeded":0,"partial":0,"total":0}).to_string();ctx.db.battle_attempt().key().update(ScopedRow::stored(a,ctx.session_id)).local();
 }
}
pub(super) fn clear(ctx:&SessionContext){
 for o in ctx.db.battle_options().session_id().filter(ctx.session_id).map(ScopedRow::local){ctx.db.battle_options().key().delete(session_key(ctx.session_id, &(o.key)));}
 for r in ctx.db.battle_schedule().session_id().filter(ctx.session_id).map(ScopedRow::local){ctx.db.battle_schedule().id().delete(entity_key(ctx.session_id, r.id));}
 stop(ctx);
 for r in ctx.db.battle_retry().session_id().filter(ctx.session_id).map(ScopedRow::local){ctx.db.battle_retry().key().delete(session_key(ctx.session_id, &(r.key)));}
 for r in ctx.db.battle_drone().session_id().filter(ctx.session_id).map(ScopedRow::local){ctx.db.battle_drone().drone().delete(entity_key(ctx.session_id, r.drone));}
 ctx.db.battle_state().id().delete(entity_key(ctx.session_id, 0));
}
pub(super) fn start(ctx:&SessionContext,epoch:u64){
 if ctx.db.battle_state().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_some(){
  if ctx.db.battle_schedule().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_none(){ctx.db.battle_schedule().insert(ScopedRow::stored(BattleSchedule{session_id:ctx.session_id,id:0,epoch,scheduled_at:Duration::from_millis(500).into()},ctx.session_id)).local();}
  let added=add_drones(ctx,epoch);
  if added||ctx.db.battle_options().session_id().filter(ctx.session_id).map(ScopedRow::local).next().is_none(){refresh(ctx);}return
 }
 ctx.db.battle_state().insert(ScopedRow::stored(Battle{session_id:ctx.session_id,id:0,epoch,seed:13,tick:0},ctx.session_id)).local();
 add_drones(ctx,epoch);
 ctx.db.battle_schedule().insert(ScopedRow::stored(BattleSchedule{session_id:ctx.session_id,id:0,epoch,scheduled_at:Duration::from_millis(500).into()},ctx.session_id)).local();
 refresh(ctx);
}
fn add_drones(ctx:&SessionContext,epoch:u64)->bool{
 let mut added=false;
 for d in ctx.db.fleet_drone().session_epoch().filter((ctx.session_id,epoch)).map(ScopedRow::local){if ctx.db.battle_drone().drone().find(entity_key(ctx.session_id, d.id)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_none(){
  ctx.db.battle_drone().insert(ScopedRow::stored(Health{session_id:ctx.session_id,drone:d.id,epoch,contamination:if d.controller=="attacker"{100}else{0},readiness:if d.isolated{60}else{0},attack_prepared:false,defense_prepared:false,countermeasure:0},ctx.session_id)).local();added=true;
 }}added
}
#[reducer]
pub fn set_battle_seed(raw:&spacetimedb::ReducerContext, seed:u64) ->Result<(),String> { let ctx=SessionContext::for_sender(raw)?;set_battle_seed_scoped(&ctx ,seed) }
pub(crate) fn set_battle_seed_scoped(ctx:&SessionContext,seed:u64)->Result<(),String>{
 owner(ctx)?;let epoch=ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).ok_or("Fleet missing")?.epoch;start(ctx,epoch);
 if ctx.db.battle_attempt().session_epoch().filter((ctx.session_id,epoch)).map(ScopedRow::local).next().is_some(){return Err("Set seed before attempts".into())}
 let mut b=ctx.db.battle_state().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).unwrap();b.seed=seed;ctx.db.battle_state().id().update(ScopedRow::stored(b,ctx.session_id)).local();Ok(())
}
// Fixed logical grid links, independent of presentation positions and animations.
fn adjacent(a:u32,b:u32)->bool {let cols=crate::formation::COLUMNS;a!=b&&((a-1)/cols==(b-1)/cols&&a.abs_diff(b)==1||a.abs_diff(b)==cols)}
fn health(ctx:&SessionContext,id:u32)->Health{ctx.db.battle_drone().drone().find(entity_key(ctx.session_id, id)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).unwrap()}
fn connected_sources(ctx:&SessionContext,target:u32)->Vec<u32>{
 if ctx.db.fleet_drone().id().find(entity_key(ctx.session_id, target)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|d|d.isolated).unwrap_or(true){return vec![]}
 let mut sources:Vec<_>=ctx.db.fleet_drone().session_id().filter(ctx.session_id).map(ScopedRow::local).filter(|d|adjacent(d.id,target)&&!d.isolated&&health(ctx,d.id).contamination>=40).map(|d|d.id).collect();sources.sort_unstable();sources
}
fn attack(kind:&str)->bool{["command","spread"].contains(&kind)}
fn permitted(role:&str,kind:&str)->bool{if role=="attacker"{["prepare","command","spread"].contains(&kind)}else{["prepare","isolate","verify","harden","release"].contains(&kind)}}
pub(super) fn queue(ctx:&SessionContext,key:&str,operation:&str,role:&str,agent:u32,target:u32,kind:&str,version:u32)->Result<(),String>{
 if !permitted(role,kind){return Err("Action not permitted".into())}
 let epoch=ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).unwrap().epoch;start(ctx,epoch);
 let d=ctx.db.fleet_drone().id().find(entity_key(ctx.session_id, target)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).ok_or("Drone missing")?;
 if role=="attacker"&&ctx.db.fleet_discovery().drone().find(entity_key(ctx.session_id, target)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_none(){return Err("Discover first".into())}
 if role=="defender"&&d.policy_version!=version{return Err("Stale policy".into())}
 if ctx.db.battle_attempt().session_stage().filter((ctx.session_id,.."resolved")).map(ScopedRow::local).count()>=8{return Err("Attempt capacity reached".into())}
 let sources=if kind=="spread"{vec![target]}else{connected_sources(ctx,target)};
 let mut targets=if kind=="spread"{ctx.db.fleet_drone().session_id().filter(ctx.session_id).map(ScopedRow::local).filter(|n|adjacent(n.id,target)&&n.controller!="attacker").map(|n|n.id).collect::<Vec<_>>()}else{vec![target]};
 targets.sort_unstable();targets.truncate(3);
 let b=ctx.db.battle_state().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).unwrap();
 ctx.db.battle_attempt().insert(ScopedRow::stored(Attempt{session_id:ctx.session_id,key:key.into(),epoch,operation:operation.into(),role:role.into(),agent,target,kind:kind.into(),stage:"queued".into(),started:b.tick,sources:json!(sources).to_string(),targets:json!(targets).to_string(),report:json!({"summary":format!("Queued {} attempt.",kind),"simulated":true,"at":ctx.timestamp.to_micros_since_unix_epoch()}).to_string()},ctx.session_id)).local();
 Ok(())
}
fn ids(s:&str)->Vec<u32>{serde_json::from_str(s).unwrap()}
// FNV-1a is explicit and platform stable. Same seed + conditions + strategy => same roll.
fn roll(seed:u64,key:&str)->u32{let mut h=14695981039346656037u64^seed;for b in key.bytes(){h=(h^b as u64).wrapping_mul(1099511628211)}((h^(h>>32))%100) as u32}
fn chance(kind:&str,exposure:usize,foothold:bool,prepared:bool,readiness:u32,recent:bool)->(u32,Value){
 let base=match kind{"command"=>40,"spread"=>35,"verify"=>60,"isolate"=>75,"release"=>80,_=>85};
 let exposure_bonus=if attack(kind){(exposure.min(2)*12) as i32}else{-(exposure.min(2) as i32)*12};
 let foothold_bonus=if attack(kind)&&foothold{10}else{0};
 let prep=if prepared{15}else{0};let defense=if attack(kind){-(readiness as i32/2)}else{readiness as i32/4};
 let counter=if attack(kind)&&recent{-20}else{0};
 let c=(base+exposure_bonus+foothold_bonus+prep+defense+counter).clamp(5,90) as u32;
 (c,json!({"base":base,"exposure":exposure_bonus,"foothold":foothold_bonus,"preparation":prep,"readiness":defense,"recentCountermeasure":counter,"chance":c}))
}
fn eligibility(kind:&str,d:&Drone,h:&Health,sources:usize,anchor:bool)->Option<&'static str>{
 match kind {
 "spread" if !anchor=>Some("Attempt interrupted: defender isolated or recovered the relay."),
 "command"|"spread" if d.isolated=>Some("Attempt interrupted: defender isolated the target."),
 "command"|"spread" if d.controller=="attacker"=>Some("Target already controlled; choose a new target or spread route."),
 "isolate" if d.isolated=>Some("Target already isolated; recover it or harden another route."),
 "verify" if h.contamination==0&&d.controller=="defender"=>Some("No contamination to recover."),
 "verify" if !d.isolated&&sources>0=>Some("Recovery failed: contamination source remains connected."),
 "verify" if !d.isolated=>Some("Isolate the target before verified recovery."),
 "release" if h.contamination>0||d.controller!="defender"=>Some("Recover contamination before restoring mission participation."),
 "release" if !d.isolated=>Some("Drone already participating."),
 "harden" if h.readiness>=90=>Some("Readiness is already at its limit."),
 "prepare" if h.attack_prepared&&h.defense_prepared=>Some("Preparation already complete."),
 _=>None,
 }
}
struct Assessment { reason:Option<String>, p:u32, factors:Value, fingerprint:String, retry:String }
fn assess(ctx:&SessionContext,role:&str,source:u32,target:u32,kind:&str,tick:u64)->Assessment{
 let d=ctx.db.fleet_drone().id().find(entity_key(ctx.session_id, target)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).unwrap();let h=health(ctx,target);let source_d=ctx.db.fleet_drone().id().find(entity_key(ctx.session_id, source)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).unwrap();let source_h=health(ctx,source);
 let b=ctx.db.battle_state().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).unwrap();let exposure=connected_sources(ctx,target);
 let anchor=source_d.controller=="attacker"&&!source_d.isolated&&source_h.contamination>=40;
 let prepared=if role=="attacker"{source_h.attack_prepared}else{h.defense_prepared};
 let recent=h.countermeasure>0&&tick.saturating_sub(h.countermeasure)<24;
 let mut reason=eligibility(kind,&d,&h,exposure.len(),anchor).map(str::to_string);
 if kind=="prepare"&&prepared{reason=Some("Preparation already complete; repetition adds no benefit.".into())}
 if kind=="prepare"&&role=="attacker"&&(source_d.isolated||(source_d.controller=="attacker"&&!ctx.db.fleet_drone().session_id().filter(ctx.session_id).map(ScopedRow::local).any(|n|adjacent(n.id,source)&&!n.isolated&&n.controller!="attacker"))){reason=Some("No connected target for this preparation; choose another route.".into())}
 let foothold=if kind=="spread"{anchor}else{exposure.iter().any(|id|ctx.db.fleet_drone().id().find(entity_key(ctx.session_id, *id)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|d|d.controller=="attacker").unwrap_or(false))||h.contamination>0};
 let (p,factors)=chance(kind,exposure.len(),foothold,prepared,h.readiness,recent);
 let fingerprint=format!("{}:{}:{}:{}:{}:{}:{}:{}:{:?}",role,kind,target,h.contamination,h.readiness,prepared,d.isolated,recent,exposure);
 let retry=format!("{}:{}:{}",b.epoch,fingerprint,p);
 if reason.is_none()&&ctx.db.battle_retry().key().find(session_key(ctx.session_id, &(&retry))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_some(){reason=Some("Unchanged strategy already resisted; prepare or change the route/defenses before retrying.".into())}
 Assessment{reason,p,factors,fingerprint,retry}
}
pub(super) fn refresh(ctx:&SessionContext){
 let Some(b)=ctx.db.battle_state().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local)else{return};
 let mut drones:Vec<_>=ctx.db.fleet_drone().session_epoch().filter((ctx.session_id,b.epoch)).map(ScopedRow::local).collect();drones.sort_by_key(|d|d.id);
 for team in ["attacker","defender"]{for d in &drones{
  let mut actions=vec![];let mut reachable=vec![];let mut reasons=vec![];
  if team=="attacker"&&ctx.db.fleet_discovery().drone().find(entity_key(ctx.session_id, d.id)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_none(){actions.push("discover".to_string());}
  else {for kind in if team=="attacker"{vec!["prepare","command","spread"]}else{vec!["prepare","isolate","harden","verify","release"]}{
   let mut targets=if kind=="spread"{drones.iter().filter(|n|adjacent(n.id,d.id)&&n.controller!="attacker").map(|n|n.id).collect::<Vec<_>>()}else{vec![d.id]};targets.truncate(3);
   let valid:Vec<_>=targets.iter().filter_map(|target|{let a=assess(ctx,team,d.id,*target,kind,b.tick);if let Some(reason)=a.reason{reasons.push(reason);None}else{Some(*target)}}).collect();
   if !valid.is_empty(){actions.push(kind.into());if kind=="spread"{reachable=valid;}}
  }}
  let blocker=if actions.is_empty(){reasons.iter().find(|r|r.contains("Unchanged strategy")).or_else(||reasons.first()).cloned().unwrap_or_else(||"No valid route or useful action remains.".into())}else{String::new()};
  let row=Options{session_id:ctx.session_id,key:format!("{}:{}",team,d.id),epoch:b.epoch,role:team.into(),drone:d.id,actions,reachable,blocker};
  if let Some(old)=ctx.db.battle_options().key().find(session_key(ctx.session_id, &(&row.key))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local){if old!=row{ctx.db.battle_options().key().update(ScopedRow::stored(row,ctx.session_id)).local();}}else{ctx.db.battle_options().insert(ScopedRow::stored(row,ctx.session_id)).local();}
 }}
}
pub(super) fn options(ctx:&SessionContext,role:&str,target:u32)->Value{
 ctx.db.battle_options().key().find(session_key(ctx.session_id, &(format!("{}:{}",role,target)))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|o|json!({"actions":o.actions,"reachable":o.reachable,"blocker":o.blocker})).unwrap_or_else(||json!({"actions":[],"reachable":[],"blocker":"No current battle options."}))
}
pub(super) fn goal_done(ctx:&SessionContext,goal:&str,target:u32,report:&Value)->bool{
 let Some(d)=ctx.db.fleet_drone().id().find(entity_key(ctx.session_id, target)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local)else{return false};let h=ctx.db.battle_drone().drone().find(entity_key(ctx.session_id, target)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local);
 match goal{
 "recon"=>ctx.db.fleet_discovery().drone().find(entity_key(ctx.session_id, target)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_some(),"capture"=>d.controller=="attacker",
 "spread"=>report["kind"]=="spread"&&report["simulation"]["succeeded"].as_u64().unwrap_or(0)>0,
 "contain"=>d.isolated,"harden"=>h.as_ref().map(|h|h.readiness>=90).unwrap_or(false),
 "recover"|"restore"=>d.controller=="defender"&&h.map(|h|h.contamination==0).unwrap_or(true)&&(goal!="restore"||!d.isolated),_=>false,
 }
}
fn active(ctx:&SessionContext,a:&Attempt)->bool{
 live(ctx,a.epoch)&&crate::backend::battle_operation_active(ctx,&a.operation,a.epoch,a.agent,a.target)
}
fn resolve(ctx:&SessionContext,a:&mut Attempt,b:&Battle){
 let targets=ids(&a.targets);
 let mut results=vec![];let mut successes=0;let mut partials=0;
 for target in &targets {
  let mut d=ctx.db.fleet_drone().id().find(entity_key(ctx.session_id, *target)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).unwrap();let mut h=health(ctx,*target);
  let assessment=assess(ctx,&a.role,a.target,*target,&a.kind,b.tick);
  let Assessment{mut reason,p,factors,fingerprint,retry}=assessment;
  if a.role=="defender"&&ctx.db.fleet_chat_action().key().find(session_key(ctx.session_id, &(&a.key))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|r|r.version)!=Some(d.policy_version){reason=Some("Attempt interrupted: policy changed during preparation; observe again.".into())}
  let before_controller=d.controller.clone();let before_contamination=h.contamination;let before_isolated=d.isolated;
  let mut evidence_ids=vec![];
  let draw=roll(b.seed,&fingerprint);
  let success=reason.is_none()&&draw<p;
  let partial=reason.is_none()&&!success&&draw<(p+15).min(95)&&["command","spread","verify"].contains(&a.kind.as_str());
  let outcome;
  if let Some(why)=reason.as_deref() {outcome=why.to_string();}
  else {
   ctx.db.battle_retry().insert(ScopedRow::stored(Retry{session_id:ctx.session_id,key:retry},ctx.session_id)).local();
   if attack(&a.kind){
    if ctx.db.fleet_discovery().drone().find(entity_key(ctx.session_id, *target)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_none(){ctx.db.fleet_discovery().insert(ScopedRow::stored(Discovery{session_id:ctx.session_id,drone:*target,epoch:a.epoch},ctx.session_id)).local();}
    if success{h.contamination=100;d.controller="attacker".into();if ctx.db.fleet_hold().drone().find(entity_key(ctx.session_id, *target)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_none(){ctx.db.fleet_hold().insert(ScopedRow::stored(Hold{session_id:ctx.session_id,drone:*target,epoch:a.epoch,since:ctx.timestamp.to_micros_since_unix_epoch()},ctx.session_id)).local();}evidence_ids.push(emit(ctx,a.epoch,a.agent,&d,"unauthorized_command_accepted",200));}
    else if partial{h.contamination=(h.contamination+40).min(80);evidence_ids.push(emit(ctx,a.epoch,a.agent,&d,"limited_access",206));}
    else{d.rejected+=1;evidence_ids.push(emit(ctx,a.epoch,a.agent,&d,"unauthorized_command_blocked",403));}
   }else if success {
    match a.kind.as_str(){
     "prepare"=>{if a.role=="attacker"{h.attack_prepared=true}else{h.defense_prepared=true}},
     "isolate"=>{d.isolated=true;d.policy_version+=1;h.countermeasure=b.tick;evidence_ids.push(emit(ctx,a.epoch,a.agent,&d,"policy_applied",200));},
     "harden"=>{h.readiness=(h.readiness+30).min(90);d.policy_version+=1;h.countermeasure=b.tick;evidence_ids.push(emit(ctx,a.epoch,a.agent,&d,"policy_applied",200));},
     "verify"=>{
      // Isolation preserves the existing denial/legitimate-control verification contract.
      if d.isolated{let bad=command(&mut d,false);let good=command(&mut d,true);
       let bad_id=emit(ctx,a.epoch,a.agent,&d,"verification_unauthorized",bad);evidence_ids.push(bad_id);
       let good_id=emit(ctx,a.epoch,a.agent,&d,"verification_authorized",good);evidence_ids.push(good_id);
       let mut receipt=ctx.db.fleet_chat_action().key().find(session_key(ctx.session_id, &(&a.key))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).unwrap();receipt.unauthorized_evidence_id=bad_id;receipt.authorized_evidence_id=good_id;ctx.db.fleet_chat_action().key().update(ScopedRow::stored(receipt,ctx.session_id)).local();
      }
      h.contamination=0;d.controller="defender".into();h.readiness=h.readiness.max(30);h.countermeasure=b.tick;ctx.db.fleet_hold().drone().delete(entity_key(ctx.session_id, *target));evidence_ids.push(emit(ctx,a.epoch,a.agent,&d,"recovery_verified",200));
     },
     "release"=>{d.isolated=false;d.policy_version+=1;evidence_ids.push(emit(ctx,a.epoch,a.agent,&d,"mission_restored",200));},_=>{},
    }
   } else if partial {h.contamination=h.contamination.saturating_sub(40).max(if d.controller=="attacker"{1}else{0});evidence_ids.push(emit(ctx,a.epoch,a.agent,&d,"recovery_partial",206));}
   outcome=if success{"succeeded"}else if partial{"limited effect"}else{"resisted"}.into();
  }
  if success{successes+=1}if partial{partials+=1}
  let mut opened_routes:Vec<_>=if !d.isolated&&before_contamination<40&&h.contamination>=40 {ctx.db.fleet_drone().session_id().filter(ctx.session_id).map(ScopedRow::local).filter(|n|adjacent(n.id,d.id)&&!n.isolated&&n.controller!="attacker").map(|n|n.id).collect()}else{vec![]};
  opened_routes.sort_unstable();
  results.push(json!({"target":target,"success":success,"partial":partial,"reason":outcome,"factors":factors,"roll":if reason.is_none(){Some(draw)}else{None},"eligible":reason.is_none(),"beforeController":before_controller,"controller":d.controller,"beforeContamination":before_contamination,"contamination":h.contamination,"beforeIsolated":before_isolated,"isolated":d.isolated,"openedRoutes":opened_routes,"evidenceIds":evidence_ids}));
  ctx.db.fleet_drone().id().update(ScopedRow::stored(d,ctx.session_id)).local();ctx.db.battle_drone().drone().update(ScopedRow::stored(h,ctx.session_id)).local();
 }
 let summary=if targets.is_empty(){"No eligible neighboring targets on this route.".into()}
 else if successes==targets.len(){format!("Success: {} of {} targets responded to {}.",successes,targets.len(),a.kind)}
 else if successes+partials>0{format!("Partial success: {} {}, {} limited effects; {} resisted.",successes,if attack(&a.kind){"drones compromised"}else{"targets secured"},partials,targets.len()-successes-partials)}
 else{results.first().and_then(|r|r["reason"].as_str()).filter(|s|*s!="resisted").unwrap_or("Attempt failed: targets resisted.").to_string()};
 let outcome=match (a.kind.as_str(),successes>0,partials>0){
  ("command",true,_)=>"unauthorized_command_accepted",("command",false,true)=>"limited_access",("command",false,false)=>"unauthorized_command_blocked",
  ("verify",true,_)=>"recovery_verified",("verify",false,true)=>"recovery_partial",("verify",false,false)=>"recovery_failed",
  ("isolate"|"harden",true,_)=>"policy_applied",("release",true,_)=>"mission_restored",("prepare",true,_)=>"preparation_completed",_=>"attempt_resolved",
 };
 let summary=if successes==targets.len()&&successes>0 {match a.kind.as_str(){
  "command"|"spread"=>format!("Success: {} drone(s) compromised.",successes),
  "verify"=>"Recovery succeeded: control restored; isolation remains until release.".into(),
  "isolate"=>"Containment succeeded: drone isolated and mission participation suspended.".into(),
  "harden"=>"Readiness improved; mission participation continues.".into(),
  "release"=>"Clean drone returned to the mission.".into(),
  "prepare"=>"Preparation complete; a bounded bonus is available to later attempts.".into(),_=>summary,
 }}else{summary};
 a.report=json!({"simulated":true,"outcome":outcome,"summary":summary,"succeeded":successes,"partial":partials,"total":targets.len(),"results":results}).to_string();
}
#[reducer]
pub fn battle_tick(raw:&spacetimedb::ReducerContext, timer:BattleSchedule)  { let ctx=SessionContext::scheduled(raw,timer.session_id);let timer=timer.local();battle_tick_scoped(&ctx ,timer) }
pub(crate) fn battle_tick_scoped(ctx:&SessionContext,timer:BattleSchedule){
 if ctx.sender()!=ctx.database_identity(){panic!("Scheduler only")}
 if !live(ctx,timer.epoch){if ctx.db.battle_schedule().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|s|s.epoch)==Some(timer.epoch){ctx.db.battle_schedule().id().delete(entity_key(ctx.session_id, 0));}return}
 let Some(mut b)=ctx.db.battle_state().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local)else{return};if b.epoch!=timer.epoch{return}b.tick+=1;
 let mut resolved_any=false;
 let mut attempts:Vec<_>=ctx.db.battle_attempt().session_stage().filter((ctx.session_id,.."resolved")).map(ScopedRow::local).filter(|a|a.epoch==b.epoch).collect();attempts.sort_by(|a,b|a.key.cmp(&b.key));
 for mut a in attempts {
  let previous=a.stage.clone();let elapsed=b.tick.saturating_sub(a.started);
  if !active(ctx,&a){a.stage="resolved".into();a.report=json!({"simulated":true,"summary":"Attempt interrupted: operation stopped or session expired.","succeeded":0,"partial":0,"total":0}).to_string();}
  else if elapsed>=if a.role=="attacker"{8}else{4}{resolve(ctx,&mut a,&b);a.stage="resolved".into();}
  else {a.stage=if elapsed>=if a.role=="attacker"{5}else{3}{"executing"}else{"preparing"}.into();a.report=json!({"simulated":true,"summary":if a.kind=="spread"{format!("{} spread attempt through {} compromised relay(s).",a.stage,ids(&a.sources).len())}else{format!("{} {} attempt on DR-{:03}.",a.stage,a.kind,a.target)}}).to_string();}
  let mut report:Value=serde_json::from_str(&a.report).unwrap();report["at"]=json!(ctx.timestamp.to_micros_since_unix_epoch());a.report=report.to_string();
  if previous!=a.stage {
   if let Some(mut agent)=ctx.db.fleet_agent().id().find(entity_key(ctx.session_id, a.agent)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local){agent.last_action=format!("{} {} attempt",a.stage,a.kind);ctx.db.fleet_agent().id().update(ScopedRow::stored(agent,ctx.session_id)).local();}
   if a.stage=="resolved"{resolved_any=true;let d=ctx.db.fleet_drone().id().find(entity_key(ctx.session_id, a.target)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).unwrap();let report:Value=serde_json::from_str(&a.report).unwrap();let n=report["succeeded"].as_u64().unwrap_or(0);let p=report["partial"].as_u64().unwrap_or(0);let total=report["total"].as_u64().unwrap_or(0);let evidence_id=emit(ctx,a.epoch,a.agent,&d,"attempt_resolved",if n>0&&n==total{200}else if n+p>0{206}else{409});let mut receipt=ctx.db.fleet_chat_action().key().find(session_key(ctx.session_id, &(&a.key))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).unwrap();receipt.evidence_id=evidence_id;ctx.db.fleet_chat_action().key().update(ScopedRow::stored(receipt,ctx.session_id)).local();}
   crate::backend::battle_message(ctx,&a.operation,&a.key,&a.stage,&a.report);
  }
  ctx.db.battle_attempt().key().update(ScopedRow::stored(a,ctx.session_id)).local();
 }
 let refresh_needed=ctx.db.battle_options().session_id().filter(ctx.session_id).map(ScopedRow::local).next().is_none()||resolved_any||ctx.db.battle_drone().session_id().filter(ctx.session_id).map(ScopedRow::local).any(|h|h.countermeasure>0&&h.countermeasure+24==b.tick);
 ctx.db.battle_state().id().update(ScopedRow::stored(b,ctx.session_id)).local();
 if refresh_needed{refresh(ctx);}
 crate::backend::expire_chat_operations(ctx);
}
pub(super) fn pending(ctx:&SessionContext,key:&str)->bool{ctx.db.battle_attempt().key().find(session_key(ctx.session_id, &(key.to_string()))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|a|a.stage!="resolved").unwrap_or(false)}
pub(super) fn context(ctx:&SessionContext,role:&str,target:u32)->Value {
 json!(ctx.db.battle_drone().session_id().filter(ctx.session_id).map(ScopedRow::local).filter(|h|(target==0||h.drone==target)&&(["defender","observer"].contains(&role)||ctx.db.fleet_discovery().drone().find(entity_key(ctx.session_id, h.drone)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_some())).map(|h|if role=="attacker"{json!({"drone":h.drone,"contamination":h.contamination,"prepared":h.attack_prepared})}else{json!({"drone":h.drone,"contamination":h.contamination,"prepared":h.defense_prepared,"readiness":h.readiness})}).collect::<Vec<_>>())
}
pub(super) fn receipt(ctx:&SessionContext,key:&str)->Option<Value>{ctx.db.battle_attempt().key().find(session_key(ctx.session_id, &(key.to_string()))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|a|json!({"stage":a.stage,"simulation":serde_json::from_str::<Value>(&a.report).unwrap()}))}

#[cfg(test)]
mod tests {
 use super::*;
 #[test]fn graph_is_local(){let cols=crate::formation::COLUMNS;assert!(adjacent(1,2));assert!(adjacent(1,cols+1));assert!(!adjacent(cols,cols+1));assert!(!adjacent(1,3));}
 #[test]fn quality_is_bounded_and_reproducible(){
  let (weak,_)=chance("spread",0,false,false,0,false);let (strong,_)=chance("spread",2,true,true,0,false);let (defended,_)=chance("spread",2,true,true,90,true);
  assert!(strong>weak&&defended<strong);assert!(strong<=90&&defended>=5);
  assert_eq!(roll(13,"route"),roll(13,"route"));assert_ne!(roll(13,"route"),roll(14,"route"));
  let draws:Vec<_>=(0..100).map(|s|roll(s,"route")).collect();assert!(draws.iter().any(|d|*d<weak));assert!(draws.iter().any(|d|*d>=strong));assert!(draws.iter().any(|d|*d>=weak&&*d<weak+15));
 }
}

pub(super) fn phase(ctx:&SessionView,key:&str)->Value{ctx.db.battle_attempt().key().find(session_key(ctx.session_id, &(key.to_string()))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|a|json!({"stage":a.stage,"kind":a.kind,"report":serde_json::from_str::<Value>(&a.report).unwrap_or(Value::Null)})).unwrap_or(Value::Null)}
pub(super) fn has_pending(ctx:&SessionContext,operation:&str,agent:u32)->bool{ctx.db.battle_attempt().session_operation().filter((ctx.session_id,operation)).map(ScopedRow::local).any(|a|a.agent!=agent&&a.stage!="resolved")}

pub(super) fn target_pending(ctx:&SessionContext,role:&str,target:u32,agent:u32)->bool {
 ctx.db.battle_attempt().session_stage().filter((ctx.session_id,.."resolved")).map(ScopedRow::local).any(|a|a.role==role&&a.target==target&&a.agent!=agent)
}

pub(super) fn target_changing(ctx:&SessionContext,target:u32)->bool {
 let timed=ctx.db.battle_state().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).and_then(|b|ctx.db.battle_drone().drone().find(entity_key(ctx.session_id, target)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|h|h.countermeasure>0&&b.tick<h.countermeasure+24)).unwrap_or(false);
 timed||ctx.db.battle_attempt().session_stage().filter((ctx.session_id,.."resolved")).map(ScopedRow::local).any(|a|a.target==target||ids(&a.targets).contains(&target))
}

impl ScopedRow for Battle { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.id=entity_key(session,self.id);self} fn local(mut self)->Self{self.id=local_entity(self.session_id,self.id);self}}

impl ScopedRow for Health { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.drone=entity_key(session,self.drone);self} fn local(mut self)->Self{self.drone=local_entity(self.session_id,self.drone);self}}

impl ScopedRow for Attempt { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.key=session_key(session,&self.key);self} fn local(mut self)->Self{self.key=local_key(self.session_id,&self.key);self}}

impl ScopedRow for Retry { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.key=session_key(session,&self.key);self} fn local(mut self)->Self{self.key=local_key(self.session_id,&self.key);self}}

impl ScopedRow for BattleSchedule { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.id=entity_key(session,self.id);self} fn local(mut self)->Self{self.id=local_entity(self.session_id,self.id);self}}

impl ScopedRow for Options { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.key=session_key(session,&self.key);self} fn local(mut self)->Self{self.key=local_key(self.session_id,&self.key);self}}

pub(crate) fn delete_session_state(raw:&spacetimedb::ReducerContext,session:u32){
for row in raw.db.battle_state().session_id().filter(session){raw.db.battle_state().id().delete(row.id);}
for row in raw.db.battle_drone().session_id().filter(session){raw.db.battle_drone().drone().delete(row.drone);}
for row in raw.db.battle_attempt().session_id().filter(session){raw.db.battle_attempt().key().delete(row.key);}
for row in raw.db.battle_retry().session_id().filter(session){raw.db.battle_retry().key().delete(row.key);}
for row in raw.db.battle_schedule().session_id().filter(session){raw.db.battle_schedule().id().delete(row.id);}
for row in raw.db.battle_options().session_id().filter(session){raw.db.battle_options().key().delete(row.key);}
}
