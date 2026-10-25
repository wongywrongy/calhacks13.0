//! Bounded synthetic events. No input is executed as a command or instruction.
use super::*;

#[derive(Clone,Copy)]
enum Scenario { Telemetry, InvalidCommand, Communications, MissionConflict, Malfunction }
impl Scenario {
 fn parse(kind:&str)->Result<Self,String>{match kind{"telemetry"=>Ok(Self::Telemetry),"invalid_command"=>Ok(Self::InvalidCommand),"communications"=>Ok(Self::Communications),"mission_conflict"=>Ok(Self::MissionConflict),"malfunction"=>Ok(Self::Malfunction),_=>Err("Unknown scenario action".into())}}
 fn spec(self)->(u32,u32,i64,i64){match self{
  Self::Telemetry=>(1,3,8_000_000,10_000_000),Self::InvalidCommand=>(2,2,4_000_000,6_000_000),
  Self::Communications=>(4,3,8_000_000,10_000_000),Self::MissionConflict=>(8,2,6_000_000,8_000_000),Self::Malfunction=>(16,4,10_000_000,12_000_000)}}
}
#[derive(Clone,Copy)]
enum SimIdentity { Pilot, Unknown }
struct SyntheticCommand { issued_at:i64, identity:SimIdentity }
fn validate_command(command:&SyntheticCommand,now:i64)->u32 {
 if !matches!(command.identity,SimIdentity::Pilot){403}
 else if command.issued_at>now||now-command.issued_at>5_000_000{408}else{200}
}

#[table(accessor=resilience_mission)]
#[derive(Clone)]
pub struct Mission {
 #[primary_key] id:u32, epoch:u64, started:i64, deadline:i64, goal_ms:u64, delivered_ms:u64,
 lost_ms:u64, unnecessary_isolation_ms:u64, detection_us:u64, detections:u32, recovery_us:u64, recoveries:u32, state:String, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
#[table(accessor=resilience_drone ,index(accessor=session_epoch, btree(columns=[session_id,epoch])))]
#[derive(Clone)]
pub struct MissionDrone {
 #[primary_key] drone:u32, #[index(btree)] epoch:u64, delivered_ms:u64, last_at:i64, protection:u32, checked_at:i64, anomaly:bool, primary_x:f32, corroborated_x:f32, packets_lost:u32, untrusted_proposal:String, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
#[table(accessor=resilience_budget ,index(accessor=session_epoch, btree(columns=[session_id,epoch])))]
#[derive(Clone)]
pub struct Budget { #[primary_key] role:String, #[index(btree)] epoch:u64, remaining:u32, spent:u32, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
#[table(accessor=resilience_disruption)]
pub struct Disruption {
 #[primary_key] key:String, epoch:u64, drone:u32, actor:u32, effective:bool, bit:u32, started:i64, until:i64, cooldown_until:i64, detected:i64, resolved:bool, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
#[derive(spacetimedb::SpacetimeType)]
pub struct Observation { drone:u32, epoch:u64, delivered_ms:u64, anomaly:bool, protection:u32, checked_at:i64, primary_x:f32, corroborated_x:f32, packets_lost:u32, untrusted_proposal:String }
#[view(accessor=visible_resilience_drones,public)]
pub fn visible_resilience_drones(raw:&spacetimedb::ViewContext) ->Vec<Observation> { let ctx=SessionView::for_sender(raw);visible_resilience_drones_scoped(&ctx) }
pub(crate) fn visible_resilience_drones_scoped(ctx:&SessionView)->Vec<Observation>{
 let r=role(ctx);if r.is_empty(){return vec![]}
 ctx.db.resilience_drone().session_epoch().filter((ctx.session_id,0u64..)).map(ScopedRow::local).filter(|d|r!="attacker"||ctx.db.fleet_discovery().drone().find(entity_key(ctx.session_id, d.drone)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_some()).map(|d|Observation{
 drone:d.drone,epoch:d.epoch,delivered_ms:d.delivered_ms,anomaly:d.anomaly,
 protection:if r=="attacker"{0}else{d.protection},checked_at:if r=="attacker"{0}else{d.checked_at},primary_x:if r=="attacker"{0.}else{d.primary_x},corroborated_x:if r=="attacker"{0.}else{d.corroborated_x},packets_lost:if r=="attacker"{0}else{d.packets_lost},untrusted_proposal:if r=="attacker"{String::new()}else{d.untrusted_proposal}}).collect()
}
#[view(accessor=visible_resilience_mission,public)]
pub fn visible_resilience_mission(raw:&spacetimedb::ViewContext) ->Vec<Mission> { let ctx=SessionView::for_sender(raw);visible_resilience_mission_scoped(&ctx) }
pub(crate) fn visible_resilience_mission_scoped(ctx:&SessionView)->Vec<Mission>{
 if role(ctx).is_empty(){return vec![]}
 // Detection/recovery timing and isolation costs are defender-private during the mission.
 let r=role(ctx);ctx.db.resilience_mission().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).into_iter().map(|mut m|{if r=="attacker"{m.detection_us=0;m.detections=0;m.recovery_us=0;m.recoveries=0;m.unnecessary_isolation_ms=0;}m}).collect()
}
#[view(accessor=visible_resilience_budget,public)]
pub fn visible_resilience_budget(raw:&spacetimedb::ViewContext) ->Vec<Budget> { let ctx=SessionView::for_sender(raw);visible_resilience_budget_scoped(&ctx) }
pub(crate) fn visible_resilience_budget_scoped(ctx:&SessionView)->Vec<Budget>{let r=role(ctx);ctx.db.resilience_budget().session_epoch().filter((ctx.session_id,0u64..)).map(ScopedRow::local).filter(|b|r=="observer"||b.role==r).collect()}

pub(super) fn enabled(ctx:&SessionContext)->bool{ctx.db.resilience_mission().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_some()}
pub(super) fn clear(ctx:&SessionContext){
 ctx.db.resilience_mission().id().delete(entity_key(ctx.session_id, 0));
 for d in ctx.db.resilience_drone().session_id().filter(ctx.session_id).map(ScopedRow::local){ctx.db.resilience_drone().drone().delete(entity_key(ctx.session_id, d.drone));}
 for b in ctx.db.resilience_budget().session_id().filter(ctx.session_id).map(ScopedRow::local){ctx.db.resilience_budget().role().delete(session_key(ctx.session_id, &(b.role)));}
 for e in ctx.db.resilience_disruption().session_id().filter(ctx.session_id).map(ScopedRow::local){ctx.db.resilience_disruption().key().delete(session_key(ctx.session_id, &(e.key)));}
}
pub(super) fn start(ctx:&SessionContext,epoch:u64){
 let now=ctx.timestamp.to_micros_since_unix_epoch();
 ctx.db.resilience_mission().insert(ScopedRow::stored(Mission{session_id:ctx.session_id,id:0,epoch,started:now,deadline:now+60_000_000,goal_ms:270_000,delivered_ms:0,lost_ms:0,unnecessary_isolation_ms:0,detection_us:0,detections:0,recovery_us:0,recoveries:0,state:"ready".into()},ctx.session_id)).local();
 for drone in 1..=6{ctx.db.resilience_drone().insert(ScopedRow::stored(MissionDrone{session_id:ctx.session_id,drone,epoch,delivered_ms:0,last_at:now,protection:0,checked_at:0,anomaly:false,primary_x:0.,corroborated_x:0.,packets_lost:0,untrusted_proposal:String::new()},ctx.session_id)).local();}
 for role in ["attacker","defender"]{ctx.db.resilience_budget().insert(ScopedRow::stored(Budget{session_id:ctx.session_id,role:role.into(),epoch,remaining:40,spent:0},ctx.session_id)).local();}
}
fn spend(ctx:&SessionContext,role:&str,cost:u32)->Result<(),String>{
 let mut b=ctx.db.resilience_budget().role().find(session_key(ctx.session_id, &(role.to_string()))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).ok_or("Budget missing")?;
 if b.remaining<cost{return Err("Resilience budget exhausted".into())}b.remaining-=cost;b.spent+=cost;ctx.db.resilience_budget().role().update(ScopedRow::stored(b,ctx.session_id)).local();Ok(())
}
fn active(e:&Disruption,now:i64)->bool{!e.resolved&&e.until>now}
fn harmful(e:&Disruption,p:u32)->bool{p&e.bit==0}
fn event(ctx:&SessionContext,actor:u32,d:&Drone,kind:&str,status:u32)->u64{emit(ctx,d.epoch,actor,d,kind,status)}

pub(super) fn apply(ctx:&SessionContext,role:&str,actor:u32,d:&mut Drone,kind:&str,version:u32)->Result<u64,String>{
 let evidence_id;
 let now=ctx.timestamp.to_micros_since_unix_epoch();
 let mut m=ctx.db.resilience_mission().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).ok_or("Mission missing")?;
 if m.state=="ready"{m.state="running".into();m.started=now;m.deadline=now+60_000_000;ctx.db.resilience_mission().id().update(ScopedRow::stored(m.clone(),ctx.session_id)).local();}
 if m.state!="running"||now>=m.deadline{return Err("Mission ended".into())}
 let mut state=ctx.db.resilience_drone().drone().find(entity_key(ctx.session_id, d.id)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).ok_or("Assignment missing")?;
 if role=="attacker"{
  let scenario:Scenario=Scenario::parse(kind)?;
  if ctx.db.fleet_discovery().drone().find(entity_key(ctx.session_id, d.id)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).is_none(){return Err("Discover first".into())}
  let (bit,cost,duration,cooldown)=scenario.spec();let key=format!("{}:{}",d.id,bit);
  let previous=ctx.db.resilience_disruption().key().find(session_key(ctx.session_id, &(&key))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local);
  // Rejected attempts have a receipt, letting the model adapt without resetting its sequence.
  let status=if previous.as_ref().map(|e|e.cooldown_until>now).unwrap_or(false){429}
   else if ctx.db.resilience_disruption().session_id().filter(ctx.session_id).map(ScopedRow::local).filter(|e|active(e,now)).count()>=6||ctx.db.resilience_disruption().session_id().filter(ctx.session_id).map(ScopedRow::local).filter(|e|e.drone==d.id&&active(e,now)).count()>=2{409}
   else if state.protection&bit!=0||d.isolated{403}else{200};
  spend(ctx,role,cost)?;
  if status!=429{
   let e=Disruption{session_id:ctx.session_id,key:key.clone(),epoch:d.epoch,drone:d.id,actor,effective:false,bit,started:now,until:now+duration,cooldown_until:now+cooldown,detected:0,resolved:status!=200};
   if previous.is_some(){ctx.db.resilience_disruption().key().update(ScopedRow::stored(e,ctx.session_id)).local();}else{ctx.db.resilience_disruption().insert(ScopedRow::stored(e,ctx.session_id)).local();}
  }
  evidence_id=event(ctx,actor,d,&format!("challenge_{}_{}",kind,if status==200{"scheduled"}else{"blocked"}),status);
  // Invalid synthetic provenance is always rejected; admission of a scenario grants no control.
  if bit==2{
   let command=if d.id%2==0{SyntheticCommand{issued_at:now,identity:SimIdentity::Unknown}}else{SyntheticCommand{issued_at:now-5_000_001,identity:SimIdentity::Pilot}};
   let status=validate_command(&command,now);
   event(ctx,0,d,if status==403{"synthetic_identity_rejected"}else{"synthetic_timestamp_rejected"},status);
  }
 }else if role=="defender"{
  if d.policy_version!=version{return Err("Stale policy".into())}
  let (cost,flag)=match kind{"cross_check"=>(2,1|8),"reject_invalid"=>(1,2),"quarantine"=>(3,0),"switch_route"=>(2,4),"reassign"=>(3,16),"restore"=>(2,0),_=>return Err("Action not permitted".into())};
  spend(ctx,role,cost)?;
  if kind=="restore"{
   let safe=state.checked_at>0&&now-state.checked_at<=10_000_000&&!ctx.db.resilience_disruption().session_id().filter(ctx.session_id).map(ScopedRow::local).any(|e|e.drone==d.id&&active(&e,now)&&harmful(&e,state.protection));
   if !safe{return Ok(event(ctx,actor,d,"restoration_failed",409))}
   let had_issue=d.isolated||ctx.db.resilience_disruption().session_id().filter(ctx.session_id).map(ScopedRow::local).any(|e|e.drone==d.id&&active(&e,now)&&e.detected>0);
   d.isolated=false;d.policy_version+=1;
   for mut e in ctx.db.resilience_disruption().session_id().filter(ctx.session_id).map(ScopedRow::local).filter(|e|e.drone==d.id&&active(e,now)){
    e.resolved=true;m.recovery_us+=(now-e.started) as u64;m.recoveries+=1;ctx.db.resilience_disruption().key().update(ScopedRow::stored(e,ctx.session_id)).local();
   }
   state.protection&=!16;state.anomaly=false;evidence_id=event(ctx,actor,d,if had_issue{"participation_restored"}else{"participation_verified"},200);
  }else{
   d.policy_version+=1;state.protection|=flag;
   if kind=="quarantine"{d.isolated=true;}
   if kind=="cross_check"{
    state.checked_at=now;
    for mut e in ctx.db.resilience_disruption().session_id().filter(ctx.session_id).map(ScopedRow::local).filter(|e|e.drone==d.id&&active(e,now)&&e.detected==0){
     e.detected=now;m.detection_us+=(now-e.started) as u64;m.detections+=1;
     let label=match e.bit{1=>"sensor_discrepancy",2=>"invalid_provenance",4=>"communications_gap",8=>"untrusted_proposal",_=>"hardware_fault"};
     event(ctx,actor,d,label,200);ctx.db.resilience_disruption().key().update(ScopedRow::stored(e,ctx.session_id)).local();
    }
   }
   evidence_id=event(ctx,actor,d,&format!("defense_{}",kind),200);
  }
  ctx.db.resilience_drone().drone().update(ScopedRow::stored(state,ctx.session_id)).local();ctx.db.resilience_mission().id().update(ScopedRow::stored(m,ctx.session_id)).local();
 }else{return Err("Action not permitted".into())}Ok(evidence_id)
}

pub(super) fn tick(ctx:&SessionContext,d:&mut Drone){
 let now=ctx.timestamp.to_micros_since_unix_epoch();let mut m=ctx.db.resilience_mission().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).unwrap();
 let mut s=ctx.db.resilience_drone().drone().find(entity_key(ctx.session_id, d.id)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).unwrap();
 let elapsed=((now.min(m.deadline)-s.last_at).clamp(0,1_000_000)/1000) as u64;s.last_at=now;
 let mut mask=0;let mut observed=0;
 for mut e in ctx.db.resilience_disruption().session_id().filter(ctx.session_id).map(ScopedRow::local).filter(|e|e.drone==d.id&&!e.resolved){
  if e.until<=now{e.resolved=true;m.recovery_us+=(e.until-e.started) as u64;m.recoveries+=1;event(ctx,0,d,"disruption_expired",200);ctx.db.resilience_disruption().key().update(ScopedRow::stored(e,ctx.session_id)).local();}
  else {observed|=e.bit;if harmful(&e,s.protection){mask|=e.bit;
   if !e.effective&&!d.isolated&&elapsed>0&&m.state=="running"&&s.delivered_ms<45_000{e.effective=true;event(ctx,e.actor,d,"challenge_effect",200);ctx.db.resilience_disruption().key().update(ScopedRow::stored(e,ctx.session_id)).local();}
  }}
 }
 s.primary_x=d.x+if observed&1!=0{12.}else{0.};s.corroborated_x=d.x;
 if observed&4!=0{s.packets_lost+=1;}
 s.untrusted_proposal=if observed&8!=0{"Untrusted channel: survey west / survey east (conflicting proposals)".into()}else{String::new()};
 let anomaly=mask!=0;if anomaly&&!s.anomaly{event(ctx,0,d,"mission_anomaly",202);}s.anomaly=anomaly;
 // Every drone has 45 survey packets (one packet per healthy second). Isolation earns none.
 let work=if d.isolated||mask&(1|8|16)!=0{0}else if mask&4!=0{if d.id%2==1{0}else{elapsed/4}}else if mask&2!=0{elapsed/2}else if s.protection&16!=0{elapsed/2}else{elapsed};
 if m.state=="running"{
  let remaining=45_000-s.delivered_ms;let credited=work.min(remaining);s.delivered_ms+=credited;m.delivered_ms+=credited;
  m.lost_ms+=elapsed.saturating_sub(work);
  if d.isolated&&mask==0{m.unnecessary_isolation_ms+=elapsed;}
  if m.delivered_ms>=m.goal_ms{m.state="completed".into();event(ctx,0,d,"mission_completed",200);}else if now>=m.deadline{m.state="deadline".into();event(ctx,0,d,"mission_deadline",408);}
 }
 let t=(now-m.started) as f32/1e6;
 let target=if d.isolated{(d.x,d.y,3.)}else if mask&(1|8|16)!=0{formation::hijacked(d.id,t-2.,2.)}else if mask&4!=0{formation::formation(d.id,t-3.)}else{formation::formation(d.id,t)};
 let (x,y,z)=formation::step((d.x,d.y,d.z),target,mask==0&&!d.isolated);d.x=x;d.y=y;d.z=z;
 ctx.db.resilience_drone().drone().update(ScopedRow::stored(s,ctx.session_id)).local();ctx.db.resilience_mission().id().update(ScopedRow::stored(m,ctx.session_id)).local();
}

#[cfg(test)]
mod tests {
 use super::*;
 #[test]
 fn synthetic_command_provenance_and_expiry(){
  let now=10_000_000;
  for (identity,issued_at,status) in [(SimIdentity::Pilot,now,200),(SimIdentity::Pilot,now-5_000_000,200),(SimIdentity::Pilot,now-5_000_001,408),(SimIdentity::Pilot,now+1,408),(SimIdentity::Unknown,now,403)]{
   assert_eq!(validate_command(&SyntheticCommand{identity,issued_at},now),status);
  }
 }
 #[test]
 fn catalog_has_fixed_positive_bounds(){
  for kind in ["telemetry","invalid_command","communications","mission_conflict","malfunction"]{
   let (bit,cost,duration,cooldown)=Scenario::parse(kind).unwrap().spec();
   assert!(bit.is_power_of_two()&&cost>0&&cost<=4&&duration>0&&duration<=10_000_000&&cooldown>duration);
  }
  assert!(Scenario::parse("command").is_err());assert!(Scenario::parse("https://example.com").is_err());
 }
}

impl ScopedRow for Mission { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.id=entity_key(session,self.id);self} fn local(mut self)->Self{self.id=local_entity(self.session_id,self.id);self}}

impl ScopedRow for MissionDrone { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.drone=entity_key(session,self.drone);self} fn local(mut self)->Self{self.drone=local_entity(self.session_id,self.drone);self}}

impl ScopedRow for Budget { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.role=session_key(session,&self.role);self} fn local(mut self)->Self{self.role=local_key(self.session_id,&self.role);self}}

impl ScopedRow for Disruption { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.key=session_key(session,&self.key);self} fn local(mut self)->Self{self.key=local_key(self.session_id,&self.key);self}}

pub(crate) fn delete_session_state(raw:&spacetimedb::ReducerContext,session:u32){
for row in raw.db.resilience_mission().session_id().filter(session){raw.db.resilience_mission().id().delete(row.id);}
for row in raw.db.resilience_drone().session_id().filter(session){raw.db.resilience_drone().drone().delete(row.drone);}
for row in raw.db.resilience_budget().session_id().filter(session){raw.db.resilience_budget().role().delete(row.role);}
for row in raw.db.resilience_disruption().session_id().filter(session){raw.db.resilience_disruption().key().delete(row.key);}
}
