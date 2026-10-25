//! Visitor admission and trusted scope. No reducer accepts a visitor-selected session.
use spacetimedb::{reducer,table,Identity,ReducerContext,ViewContext,Table,ScheduleAt};
use crate::{publisher, fleet::{fleet_principal,Principal}};
use std::{ops::Deref,time::Duration};

const IDLE_US:i64=15*60*1_000_000;
const LIFETIME_US:i64=2*60*60*1_000_000;
const INVALID_SCOPE:u32=1_048_575;
#[table(accessor=visitor_session)]
pub struct Visitor {
    #[primary_key] #[auto_inc] pub id:u32,
    #[unique] owner:Identity,
    defender:Identity, observer:Identity,
    created:i64, seen:i64, pub closed:bool, cleanup_at:i64,
}
#[table(accessor=visitor_admission)]
pub struct Admission { #[primary_key] id:u32, minute:i64, count:u32 }
#[table(accessor=visitor_sweep_schedule,scheduled(expire_visitor_sessions))]
pub struct Sweep { #[primary_key] id:u64, scheduled_at:ScheduleAt }

pub struct SessionContext<'a>{pub raw:&'a ReducerContext,pub session_id:u32}
impl<'a> Deref for SessionContext<'a>{type Target=ReducerContext;fn deref(&self)->&ReducerContext{self.raw}}
impl<'a> SessionContext<'a>{
    pub fn for_sender(raw:&'a ReducerContext)->Result<Self,String>{
        if raw.db.publisher().id().find(0).map(|p|p.identity)==Some(raw.sender()) {return Ok(Self{raw,session_id:0})}
        let p=raw.db.fleet_principal().identity().find(raw.sender()).ok_or("Visitor session required")?;
        let ctx=Self{raw,session_id:p.session_id};
        if !live(&ctx){return Err("Visitor session expired".into())}Ok(ctx)
    }
    pub fn scheduled(raw:&'a ReducerContext,session_id:u32)->Self{
        assert!(crate::hosted_scheduler(raw),"Scheduler only");Self{raw,session_id}
    }
}
pub struct SessionView<'a>{raw:&'a ViewContext,pub session_id:u32}
impl<'a> Deref for SessionView<'a>{type Target=ViewContext;fn deref(&self)->&ViewContext{self.raw}}
impl<'a> SessionView<'a>{
    pub fn for_sender(raw:&'a ViewContext)->Self{
        use crate::fleet::fleet_principal__view;
        let session_id=raw.db.fleet_principal().identity().find(raw.sender()).filter(|p|p.session_id==0||raw.db.visitor_session().id().find(p.session_id).map(|s|!s.closed).unwrap_or(false)).map(|p|p.session_id).unwrap_or(INVALID_SCOPE);
        Self{raw,session_id}
    }
}
pub fn live(ctx:&SessionContext)->bool{
    if ctx.session_id==0{return true}
    let now=ctx.timestamp.to_micros_since_unix_epoch();
    ctx.db.visitor_session().id().find(ctx.session_id).map(|s|!s.closed&&now<s.seen+IDLE_US&&now<s.created+LIFETIME_US).unwrap_or(false)
}

// Stored keys are session-qualified; all simulation code and public labels use local IDs.
pub trait ScopedRow:Sized {fn stored(self,session:u32)->Self;fn local(self)->Self;}
pub trait EntityKey:Copy {fn pack(self,session:u32)->Self;fn unpack(self,session:u32)->Self;}
impl EntityKey for u32 {
    fn pack(self,session:u32)->Self{assert!(self<4096,"Local entity limit");session.checked_mul(4096).and_then(|n|n.checked_add(self)).expect("Session key exhausted")}
    fn unpack(self,session:u32)->Self{self.checked_sub(session*4096).expect("Foreign entity")}
}
impl EntityKey for u64 {
    fn pack(self,session:u32)->Self{assert!(self<4096,"Local schedule limit");u64::from(session)*4096+self}
    fn unpack(self,session:u32)->Self{self.checked_sub(u64::from(session)*4096).expect("Foreign schedule")}
}
pub fn entity_key<T:EntityKey>(session:u32,id:T)->T{id.pack(session)}
pub fn local_entity<T:EntityKey>(session:u32,id:T)->T{id.unpack(session)}
pub fn session_key(session:u32,key:&str)->String{if session==0{key.into()}else{format!("visitor:{session}:{key}")}}
pub fn local_key(session:u32,key:&str)->String{if session==0{key.into()}else{key.strip_prefix(&format!("visitor:{session}:")).expect("Foreign key").into()}}

#[reducer]
pub fn create_visitor_session(ctx:&ReducerContext,defender:Identity,observer:Identity)->Result<(),String>{
    let owner=ctx.sender();let now=ctx.timestamp.to_micros_since_unix_epoch();
    if let Some(s)=ctx.db.visitor_session().owner().find(owner){
        if s.defender!=defender||s.observer!=observer{return Err("Session identity conflict".into())}
        let scoped=SessionContext{raw:ctx,session_id:s.id};
        return if live(&scoped){Ok(())}else{Err("Visitor session expired".into())}
    }
    if owner==defender||owner==observer||defender==observer{return Err("Distinct role identities required".into())}
    for identity in [owner,defender,observer]{
        if ctx.db.fleet_principal().identity().find(identity).is_some()||ctx.db.publisher().id().find(0).map(|p|p.identity)==Some(identity){return Err("Identity already assigned".into())}
    }
    if ctx.db.visitor_session().iter().filter(|s|!s.closed).count()>=8{return Err("All simulation slots are in use. Please retry shortly.".into())}
    let minute=now/60_000_000;
    let mut admission=ctx.db.visitor_admission().id().find(0).unwrap_or(Admission{id:0,minute,count:0});
    if admission.minute!=minute{admission.minute=minute;admission.count=0;}
    if admission.count>=8{return Err("Session creation limit reached. Please retry in a minute.".into())}
    admission.count+=1;ctx.db.visitor_admission().id().delete(0);ctx.db.visitor_admission().insert(admission);
    let s=ctx.db.visitor_session().insert(Visitor{id:0,owner,defender,observer,created:now,seen:now,closed:false,cleanup_at:0});
    if s.id>=INVALID_SCOPE{return Err("Session identities exhausted".into())}
    for (identity,role) in [(owner,"attacker"),(defender,"defender"),(observer,"observer")]{ctx.db.fleet_principal().insert(Principal{identity,role:role.into(),session_id:s.id});}
    let scoped=SessionContext{raw:ctx,session_id:s.id};
    crate::fleet::initialize_visitor(&scoped)?;
    if ctx.db.visitor_sweep_schedule().id().find(0).is_none(){ctx.db.visitor_sweep_schedule().insert(Sweep{id:0,scheduled_at:Duration::from_secs(30).into()});}
    Ok(())
}
#[reducer]
pub fn heartbeat_visitor_session(raw:&ReducerContext)->Result<(),String>{
    let ctx=SessionContext::for_sender(raw)?;
    if ctx.session_id==0{return Err("Visitor session required".into())}
    let mut s=ctx.db.visitor_session().id().find(ctx.session_id).ok_or("Visitor session expired")?;
    s.seen=ctx.timestamp.to_micros_since_unix_epoch();ctx.db.visitor_session().id().update(s);Ok(())
}

#[cfg(feature="mission-fixtures")]
#[reducer]
pub fn fixture_age_visitor(ctx:&ReducerContext,session_id:u32)->Result<(),String>{
    if ctx.db.publisher().id().find(0).map(|p|p.identity)!=Some(ctx.sender()){return Err("Owner required".into())}
    let mut s=ctx.db.visitor_session().id().find(session_id).ok_or("Session missing")?;
    s.seen=ctx.timestamp.to_micros_since_unix_epoch()-IDLE_US;
    ctx.db.visitor_session().id().update(s);Ok(())
}
#[reducer]
pub fn expire_visitor_sessions(raw:&ReducerContext,_timer:Sweep){
    assert!(crate::hosted_scheduler(raw),"Scheduler only");
    let now=raw.timestamp.to_micros_since_unix_epoch();
    for mut s in raw.db.visitor_session().iter(){
        if !s.closed&&(now>=s.seen+IDLE_US||now>=s.created+LIFETIME_US){
            let ctx=SessionContext::scheduled(raw,s.id);
            crate::fleet::stop_fleet_scoped(&ctx).expect("Session cancellation");
            s.closed=true;s.cleanup_at=now+21_000_000;
            raw.db.visitor_session().id().update(s);
        }else if s.closed&&s.cleanup_at>0&&now>=s.cleanup_at{
            delete_state(raw,s.id);s.cleanup_at=0;raw.db.visitor_session().id().update(s);
        }else if s.closed&&s.cleanup_at==0&&now>=s.created+24*60*60*1_000_000{
            for id in [s.owner,s.defender,s.observer]{raw.db.fleet_principal().identity().delete(id);}
            raw.db.visitor_session().id().delete(s.id);
        }
    }
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]fn session_keys_do_not_alias(){
        assert_ne!(entity_key(1,1u32),entity_key(2,1u32));
        assert_eq!(local_entity(2,entity_key(2,200u32)),200);
        assert_eq!(local_key(2,&session_key(2,"attacker")),"attacker");
        assert_ne!(session_key(1,"attacker"),session_key(2,"attacker"));
    }
}

fn delete_state(raw:&ReducerContext,session:u32){
crate::fleet::delete_session_state(raw,session);
crate::fleet::battle::delete_session_state(raw,session);
crate::fleet::resilience::delete_session_state(raw,session);
crate::backend::delete_session_state(raw,session);
crate::backend::hosted::delete_session_state(raw,session);
crate::backend::workflow::delete_session_state(raw,session);
}
