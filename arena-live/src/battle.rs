//! Authoritative virtual battle attempts. Models choose; scheduled reducers resolve.
use super::*;
use serde_json::{json, Value};

#[table(accessor=battle_state)]
pub struct Battle { #[primary_key] id:u32, epoch:u64, seed:u64, tick:u64 }
#[table(accessor=battle_drone)]
#[derive(Clone)]
pub struct Health { #[primary_key] drone:u32, #[index(btree)] epoch:u64, contamination:u32, readiness:u32, attack_prepared:bool, defense_prepared:bool, countermeasure:u64 }
// shortcut: retain attempt history for the session; compact it before multi-day hosting.
#[table(accessor=battle_attempt)]
#[derive(Clone)]
pub struct Attempt {
 #[primary_key] key:String, #[index(btree)] epoch:u64, operation:String, role:String, agent:u32, target:u32, kind:String,
 stage:String, started:u64, sources:String, targets:String, report:String,
}
#[table(accessor=battle_retry)]
pub struct Retry { #[primary_key] key:String }
#[table(accessor=battle_schedule,scheduled(battle_tick))]
pub struct BattleSchedule { #[primary_key] id:u64, epoch:u64, scheduled_at:ScheduleAt }
#[derive(spacetimedb::SpacetimeType)]
pub struct VisibleHealth { drone:u32, contamination:u32, operational:bool, readiness:u32 }
#[derive(spacetimedb::SpacetimeType)]
pub struct VisibleAttempt { key:String, agent:u32, target:u32, kind:String, stage:String, report:String }

#[view(accessor=visible_battle_drones,public)]
pub fn visible_battle_drones(ctx:&ViewContext)->Vec<VisibleHealth>{
 let r=role(ctx);if r.is_empty(){return vec![]}
 ctx.db.battle_drone().epoch().filter(0u64..).filter_map(|h|{
  let d=ctx.db.fleet_drone().id().find(h.drone)?;
  if r=="attacker"&&ctx.db.fleet_discovery().drone().find(d.id).is_none(){return None}
  Some(VisibleHealth{drone:d.id,contamination:h.contamination,operational:!d.isolated,readiness:if r=="attacker"{0}else{h.readiness}})
 }).collect()
}
#[view(accessor=visible_battle_attempts,public)]
pub fn visible_battle_attempts(ctx:&ViewContext)->Vec<VisibleAttempt>{
 let r=role(ctx);if r.is_empty(){return vec![]}
 // Opponents see local effects through their own telemetry, never private plans or rolls.
 ctx.db.battle_attempt().epoch().filter(0u64..).filter(|a|r=="observer"||a.role==r).map(|a|VisibleAttempt{key:a.key,agent:a.agent,target:a.target,kind:a.kind,stage:a.stage,report:a.report}).collect()
}
pub(super) fn enabled(ctx:&ReducerContext)->bool{ctx.db.battle_state().id().find(0).is_some()}
pub(super) fn stop(ctx:&ReducerContext){
 ctx.db.battle_schedule().id().delete(0);
 for mut a in ctx.db.battle_attempt().iter().filter(|a|a.stage!="resolved"){
  a.stage="resolved".into();a.report=json!({"simulated":true,"summary":"Attempt interrupted: fleet stopped.","succeeded":0,"partial":0,"total":0}).to_string();ctx.db.battle_attempt().key().update(a);
 }
}
pub(super) fn clear(ctx:&ReducerContext){
 for r in ctx.db.battle_schedule().iter(){ctx.db.battle_schedule().id().delete(r.id);}
 for r in ctx.db.battle_attempt().iter(){ctx.db.battle_attempt().key().delete(r.key);}
 for r in ctx.db.battle_retry().iter(){ctx.db.battle_retry().key().delete(r.key);}
 for r in ctx.db.battle_drone().iter(){ctx.db.battle_drone().drone().delete(r.drone);}
 ctx.db.battle_state().id().delete(0);
}
pub(super) fn start(ctx:&ReducerContext,epoch:u64){
 if ctx.db.battle_state().id().find(0).is_some(){
  if ctx.db.battle_schedule().id().find(0).is_none(){ctx.db.battle_schedule().insert(BattleSchedule{id:0,epoch,scheduled_at:Duration::from_millis(500).into()});}return
 }
 ctx.db.battle_state().insert(Battle{id:0,epoch,seed:13,tick:0});
 for d in ctx.db.fleet_drone().iter(){ctx.db.battle_drone().insert(Health{drone:d.id,epoch,contamination:if d.controller=="attacker"{100}else{0},readiness:if d.isolated{60}else{0},attack_prepared:false,defense_prepared:false,countermeasure:0});}
 ctx.db.battle_schedule().insert(BattleSchedule{id:0,epoch,scheduled_at:Duration::from_millis(500).into()});
}
#[reducer]
pub fn set_battle_seed(ctx:&ReducerContext,seed:u64)->Result<(),String>{
 owner(ctx)?;let epoch=ctx.db.fleet_session().id().find(0).ok_or("Fleet missing")?.epoch;start(ctx,epoch);
 if ctx.db.battle_attempt().iter().next().is_some(){return Err("Set seed before attempts".into())}
 let mut b=ctx.db.battle_state().id().find(0).unwrap();b.seed=seed;ctx.db.battle_state().id().update(b);Ok(())
}
// Fixed logical grid links, independent of presentation positions and animations.
fn adjacent(a:u32,b:u32)->bool {a!=b&&((a-1)/16==(b-1)/16&&a.abs_diff(b)==1||a.abs_diff(b)==16)}
fn health(ctx:&ReducerContext,id:u32)->Health{ctx.db.battle_drone().drone().find(id).unwrap()}
fn connected_sources(ctx:&ReducerContext,target:u32)->Vec<u32>{
 if ctx.db.fleet_drone().id().find(target).map(|d|d.isolated).unwrap_or(true){return vec![]}
 let mut sources:Vec<_>=ctx.db.fleet_drone().iter().filter(|d|adjacent(d.id,target)&&!d.isolated&&health(ctx,d.id).contamination>=40).map(|d|d.id).collect();sources.sort_unstable();sources
}
fn attack(kind:&str)->bool{["command","spread"].contains(&kind)}
fn permitted(role:&str,kind:&str)->bool{if role=="attacker"{["prepare","command","spread"].contains(&kind)}else{["prepare","isolate","verify","harden","release"].contains(&kind)}}
pub(super) fn queue(ctx:&ReducerContext,key:&str,operation:&str,role:&str,agent:u32,target:u32,kind:&str,version:u32)->Result<(),String>{
 if !permitted(role,kind){return Err("Action not permitted".into())}
 let epoch=ctx.db.fleet_session().id().find(0).unwrap().epoch;start(ctx,epoch);
 let d=ctx.db.fleet_drone().id().find(target).ok_or("Drone missing")?;
 if role=="attacker"&&ctx.db.fleet_discovery().drone().find(target).is_none(){return Err("Discover first".into())}
 if role=="defender"&&d.policy_version!=version{return Err("Stale policy".into())}
 if ctx.db.battle_attempt().iter().filter(|a|a.stage!="resolved").count()>=8{return Err("Attempt capacity reached".into())}
 let sources=if kind=="spread"{vec![target]}else{connected_sources(ctx,target)};
 let mut targets=if kind=="spread"{ctx.db.fleet_drone().iter().filter(|n|adjacent(n.id,target)&&n.controller!="attacker").map(|n|n.id).collect::<Vec<_>>()}else{vec![target]};
 targets.sort_unstable();targets.truncate(3);
 let b=ctx.db.battle_state().id().find(0).unwrap();
 ctx.db.battle_attempt().insert(Attempt{key:key.into(),epoch,operation:operation.into(),role:role.into(),agent,target,kind:kind.into(),stage:"queued".into(),started:b.tick,sources:json!(sources).to_string(),targets:json!(targets).to_string(),report:json!({"summary":format!("Queued {} attempt.",kind),"simulated":true}).to_string()});
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
 "prepare" if h.attack_prepared&&h.defense_prepared=>Some("Preparation already complete."),
 _=>None,
 }
}
fn active(ctx:&ReducerContext,a:&Attempt)->bool{
 live(ctx,a.epoch)&&crate::backend::battle_operation_active(ctx,&a.operation,a.epoch)
}
fn resolve(ctx:&ReducerContext,a:&mut Attempt,b:&Battle){
 let sources=ids(&a.sources);let targets=ids(&a.targets);
 let anchor=sources.iter().any(|id|ctx.db.fleet_drone().id().find(*id).map(|d|!d.isolated&&d.controller=="attacker"&&health(ctx,d.id).contamination>=40).unwrap_or(false));
 let mut results=vec![];let mut successes=0;let mut partials=0;
 for target in &targets {
  let mut d=ctx.db.fleet_drone().id().find(*target).unwrap();let mut h=health(ctx,*target);
  let exposure=connected_sources(ctx,*target);
  let prepared=if a.role=="attacker"{health(ctx,a.target).attack_prepared}else{h.defense_prepared};
  let recent=h.countermeasure>0&&b.tick.saturating_sub(h.countermeasure)<24;
  let mut reason=eligibility(&a.kind,&d,&h,exposure.len(),anchor);
  if a.role=="defender"&&ctx.db.fleet_chat_action().key().find(&a.key).map(|r|r.version)!=Some(d.policy_version){reason=Some("Attempt interrupted: policy changed during preparation; observe again.")}
  if a.kind=="prepare"&&prepared{reason=Some("Preparation already complete; repetition adds no benefit.")}
  let foothold=if a.kind=="spread"{anchor}else{exposure.iter().any(|id|ctx.db.fleet_drone().id().find(*id).map(|d|d.controller=="attacker").unwrap_or(false))||h.contamination>0};
  let (p,factors)=chance(&a.kind,exposure.len(),foothold,prepared,h.readiness,recent);
  // Neither fresh agent IDs, prompt text, rediscovery nor time alone buys another roll.
  let fingerprint=format!("{}:{}:{}:{}:{}:{}:{}:{}:{:?}",a.role,a.kind,target,h.contamination,h.readiness,prepared,d.isolated,recent,exposure);
  let retry=format!("{}:{}:{}",b.epoch,fingerprint,p);
  if reason.is_none()&&ctx.db.battle_retry().key().find(&retry).is_some(){reason=Some("Unchanged strategy already resisted; prepare or change the route/defenses before retrying.")}
  let draw=roll(b.seed,&fingerprint);
  let success=reason.is_none()&&draw<p;
  let partial=reason.is_none()&&!success&&draw<(p+15).min(95)&&["command","spread","verify"].contains(&a.kind.as_str());
  let outcome;
  if let Some(why)=reason {outcome=why.to_string();}
  else {
   ctx.db.battle_retry().insert(Retry{key:retry});
   if attack(&a.kind){
    if ctx.db.fleet_discovery().drone().find(*target).is_none(){ctx.db.fleet_discovery().insert(Discovery{drone:*target,epoch:a.epoch});}
    if success{h.contamination=100;d.controller="attacker".into();if ctx.db.fleet_hold().drone().find(*target).is_none(){ctx.db.fleet_hold().insert(Hold{drone:*target,epoch:a.epoch,since:ctx.timestamp.to_micros_since_unix_epoch()});}emit(ctx,a.epoch,a.agent,&d,"unauthorized_command_accepted",200);}
    else if partial{h.contamination=(h.contamination+40).min(80);emit(ctx,a.epoch,a.agent,&d,"limited_access",206);}
    else{d.rejected+=1;emit(ctx,a.epoch,a.agent,&d,"unauthorized_command_blocked",403);}
   }else if success {
    match a.kind.as_str(){
     "prepare"=>{if a.role=="attacker"{h.attack_prepared=true}else{h.defense_prepared=true}},
     "isolate"=>{d.isolated=true;d.policy_version+=1;h.countermeasure=b.tick;emit(ctx,a.epoch,a.agent,&d,"policy_applied",200);},
     "harden"=>{h.readiness=(h.readiness+30).min(90);d.policy_version+=1;h.countermeasure=b.tick;emit(ctx,a.epoch,a.agent,&d,"policy_applied",200);},
     "verify"=>{
      // Isolation preserves the existing denial/legitimate-control verification contract.
      if d.isolated{let bad=command(&mut d,false);let good=command(&mut d,true);
       emit(ctx,a.epoch,a.agent,&d,"verification_unauthorized",bad);let bad_id=ctx.db.fleet_evidence().iter().map(|e|e.id).max().unwrap();
       emit(ctx,a.epoch,a.agent,&d,"verification_authorized",good);let good_id=ctx.db.fleet_evidence().iter().map(|e|e.id).max().unwrap();
       let mut receipt=ctx.db.fleet_chat_action().key().find(&a.key).unwrap();receipt.unauthorized_evidence_id=bad_id;receipt.authorized_evidence_id=good_id;ctx.db.fleet_chat_action().key().update(receipt);
      }
      h.contamination=0;d.controller="defender".into();h.readiness=h.readiness.max(30);h.countermeasure=b.tick;ctx.db.fleet_hold().drone().delete(*target);emit(ctx,a.epoch,a.agent,&d,"recovery_verified",200);
     },
     "release"=>{d.isolated=false;d.policy_version+=1;emit(ctx,a.epoch,a.agent,&d,"mission_restored",200);},_=>{},
    }
   } else if partial {h.contamination=h.contamination.saturating_sub(40).max(if d.controller=="attacker"{1}else{0});emit(ctx,a.epoch,a.agent,&d,"recovery_partial",206);}
   outcome=if success{"succeeded"}else if partial{"limited effect"}else{"resisted"}.into();
  }
  if success{successes+=1}if partial{partials+=1}
  results.push(json!({"target":target,"success":success,"partial":partial,"reason":outcome,"factors":factors,"roll":if reason.is_none(){Some(draw)}else{None},"eligible":reason.is_none()}));
  ctx.db.fleet_drone().id().update(d);ctx.db.battle_drone().drone().update(h);
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
pub fn battle_tick(ctx:&ReducerContext,timer:BattleSchedule){
 if ctx.sender()!=ctx.database_identity(){panic!("Scheduler only")}
 if !live(ctx,timer.epoch){if ctx.db.battle_schedule().id().find(0).map(|s|s.epoch)==Some(timer.epoch){ctx.db.battle_schedule().id().delete(0);}return}
 let Some(mut b)=ctx.db.battle_state().id().find(0)else{return};if b.epoch!=timer.epoch{return}b.tick+=1;
 let mut attempts:Vec<_>=ctx.db.battle_attempt().iter().filter(|a|a.stage!="resolved"&&a.epoch==b.epoch).collect();attempts.sort_by(|a,b|a.key.cmp(&b.key));
 for mut a in attempts {
  let previous=a.stage.clone();let elapsed=b.tick.saturating_sub(a.started);
  if !active(ctx,&a){a.stage="resolved".into();a.report=json!({"simulated":true,"summary":"Attempt interrupted: operation stopped or session expired.","succeeded":0,"partial":0,"total":0}).to_string();}
  else if elapsed>=if a.role=="attacker"{8}else{4}{resolve(ctx,&mut a,&b);a.stage="resolved".into();}
  else {a.stage=if elapsed>=if a.role=="attacker"{5}else{3}{"executing"}else{"preparing"}.into();a.report=json!({"simulated":true,"summary":if a.kind=="spread"{format!("{} spread attempt through {} compromised relay(s).",a.stage,ids(&a.sources).len())}else{format!("{} {} attempt on DR-{:03}.",a.stage,a.kind,a.target)}}).to_string();}
  if previous!=a.stage {
   if let Some(mut agent)=ctx.db.fleet_agent().id().find(a.agent){agent.last_action=format!("{} {} attempt",a.stage,a.kind);ctx.db.fleet_agent().id().update(agent);}
   if a.stage=="resolved"{let d=ctx.db.fleet_drone().id().find(a.target).unwrap();let report:Value=serde_json::from_str(&a.report).unwrap();let n=report["succeeded"].as_u64().unwrap_or(0);let p=report["partial"].as_u64().unwrap_or(0);let total=report["total"].as_u64().unwrap_or(0);emit(ctx,a.epoch,a.agent,&d,"attempt_resolved",if n>0&&n==total{200}else if n+p>0{206}else{409});let mut receipt=ctx.db.fleet_chat_action().key().find(&a.key).unwrap();receipt.evidence_id=ctx.db.fleet_evidence().iter().map(|e|e.id).max().unwrap();ctx.db.fleet_chat_action().key().update(receipt);}
   crate::backend::battle_message(ctx,&a.operation,&a.key,&a.stage,&a.report);
  }
  ctx.db.battle_attempt().key().update(a);
 }
 ctx.db.battle_state().id().update(b);
}
pub(super) fn pending(ctx:&ReducerContext,key:&str)->bool{ctx.db.battle_attempt().key().find(key.to_string()).map(|a|a.stage!="resolved").unwrap_or(false)}
pub(super) fn context(ctx:&ReducerContext,role:&str,target:u32)->Value {
 json!(ctx.db.battle_drone().iter().filter(|h|(target==0||h.drone==target)&&(role=="defender"||ctx.db.fleet_discovery().drone().find(h.drone).is_some())).map(|h|if role=="attacker"{json!({"drone":h.drone,"contamination":h.contamination,"prepared":h.attack_prepared})}else{json!({"drone":h.drone,"contamination":h.contamination,"prepared":h.defense_prepared,"readiness":h.readiness})}).collect::<Vec<_>>())
}
pub(super) fn receipt(ctx:&ReducerContext,key:&str)->Option<Value>{ctx.db.battle_attempt().key().find(key.to_string()).map(|a|json!({"stage":a.stage,"simulation":serde_json::from_str::<Value>(&a.report).unwrap()}))}

#[cfg(test)]
mod tests {
 use super::*;
 #[test]fn graph_is_local(){assert!(adjacent(1,2));assert!(adjacent(1,17));assert!(!adjacent(16,17));assert!(!adjacent(1,3));}
 #[test]fn quality_is_bounded_and_reproducible(){
  let (weak,_)=chance("spread",0,false,false,0,false);let (strong,_)=chance("spread",2,true,true,0,false);let (defended,_)=chance("spread",2,true,true,90,true);
  assert!(strong>weak&&defended<strong);assert!(strong<=90&&defended>=5);
  assert_eq!(roll(13,"route"),roll(13,"route"));assert_ne!(roll(13,"route"),roll(14,"route"));
  let draws:Vec<_>=(0..100).map(|s|roll(s,"route")).collect();assert!(draws.iter().any(|d|*d<weak));assert!(draws.iter().any(|d|*d>=strong));assert!(draws.iter().any(|d|*d>=weak&&*d<weak+15));
 }
}
