use crate::sessions::{SessionContext,SessionView,ScopedRow,session_key,entity_key,local_key,local_entity};
// Durable backend control plane. Every mutation is an owner-authorized transaction.
use crate::{publisher, fleet::fleet_session};
use spacetimedb::{reducer, table, view, Identity,  Table};
#[table(accessor=backend_lease)]
pub struct Lease {
    #[primary_key]
    id: u32,
    session: String,
    expires: i64,
    max_active: u32,
    max_total: u32,
}
#[table(accessor=backend_run)]
#[derive(Clone)]
pub struct Run {
    #[primary_key]
    id: String,
    #[unique]
    request_key: String,
    #[index(btree)]
    state: String,
    created: i64,
    updated: i64,
    config: String,
    snapshot: String,
    error: String,
    sequence: u64,
}
#[table(accessor=backend_event)]
#[derive(Clone)]
pub struct Event {
    #[primary_key]
    key: String,
    #[index(btree)]
    run_id: String,
    event_id: u64,
    at: u64,
    kind: String,
    actor: String,
    target: String,
    body: String,
}
#[table(accessor=backend_viewer)]
pub struct Viewer {
    #[primary_key]
    identity: Identity,
}
fn now(ctx: &SessionContext) -> i64 {
    ctx.timestamp.to_micros_since_unix_epoch() / 1000
}
fn owner(ctx: &SessionContext) -> Result<(), String> {
    if crate::hosted_scheduler(ctx) { return Ok(()) }
    if ctx.db.publisher().id().find(0).map(|p| p.identity) != Some(ctx.sender()) {
        return Err("Owner required".into());
    }
    Ok(())
}
fn lease(ctx: &SessionContext, session: &str) -> Result<Lease, String> {
    owner(ctx)?;
    if (crate::hosted_scheduler(ctx) || cfg!(feature="mission-fixtures")) && session == "maincloud" { return Ok(Lease { id:0,session:session.into(),expires:now(ctx)+75000,max_active:2,max_total:4 }); }
    let l = ctx
        .db
        .backend_lease()
        .id()
        .find(0)
        .ok_or("No scheduler lease")?;
    if l.session != session || l.expires <= now(ctx) {
        return Err("Scheduler lease expired".into());
    }
    Ok(l)
}
fn active(s: &str) -> bool {
    ["queued", "running", "stopping"].contains(&s)
}
#[reducer]
pub fn acquire_backend(raw:&spacetimedb::ReducerContext, session: String, max_active: u32, max_queued: u32) -> Result<(), String> { let ctx=SessionContext::for_sender(raw)?;acquire_backend_scoped(&ctx ,session,max_active,max_queued) }
pub(crate) fn acquire_backend_scoped(
    ctx: &SessionContext,
    session: String,
    max_active: u32,
    max_queued: u32,
) -> Result<(), String> {
    owner(ctx)?;
    if session.len() != 36 || !(1..=4).contains(&max_active) || !(1..=32).contains(&max_queued) {
        return Err("Invalid scheduler limits".into());
    }
    if let Some(l) = ctx.db.backend_lease().id().find(0) {
        if l.expires > now(ctx) && l.session != session {
            return Err("Scheduler already active".into());
        }
        if l.session == session && l.expires > now(ctx) {
            return Ok(());
        }
    }
    for mut r in ctx.db.backend_run().iter().filter(|r| active(&r.state)) {
        r.state = "interrupted".into();
        r.updated = now(ctx);
        r.error = "Scheduler restarted; create a new run".into();
        ctx.db.backend_run().id().update(r);
    }
    for mut r in ctx.db.backend_chat().session_state().filter((ctx.session_id,"planning")).map(ScopedRow::local).chain(ctx.db.backend_chat().session_state().filter((ctx.session_id,"running")).map(ScopedRow::local)).filter(|r|!is_hosted_operation(ctx,&r.id)).map(|op|hydrate_operation(ctx,op)) { chat_transition(ctx,&r.id,"interrupted"); if r.epoch==chat_epoch(ctx){append_chat_message(ctx,r.generation,format!("{}:terminal",r.id),&r.role,&r.id,"coordinator","Operation interrupted by backend restart. No automatic resumption.".into(),0)?;} r.state="interrupted".into(); store_operation(ctx,r); }
    for mut t in ctx.db.backend_chat_turn().session_id().filter(ctx.session_id).map(ScopedRow::local).filter(|t|["queued","running"].contains(&t.state.as_str())) {
        if serde_json::from_str::<serde_json::Value>(&t.config).ok().and_then(|v|v["epoch"].as_u64())==Some(chat_epoch(ctx)){append_chat_message(ctx,t.generation,format!("{}:reply",t.id),&t.role,"","coordinator","Conversation interrupted by backend restart. Please retry your request.".into(),0)?;}
        t.state="failed".into();t.updated=now(ctx);ctx.db.backend_chat_turn().id().update(ScopedRow::stored(t,ctx.session_id)).local();
    }
    ctx.db.backend_lease().id().delete(0);
    ctx.db.backend_lease().insert(Lease {
        id: 0,
        session,
        expires: now(ctx) + 20_000,
        max_active,
        max_total: max_active + max_queued,
    });
    Ok(())
}
#[reducer]
pub fn heartbeat_backend(raw:&spacetimedb::ReducerContext, session: String) -> Result<(), String> { let ctx=SessionContext::for_sender(raw)?;heartbeat_backend_scoped(&ctx ,session) }
pub(crate) fn heartbeat_backend_scoped(ctx: &SessionContext, session: String) -> Result<(), String> {
    let mut l = lease(ctx, &session)?;
    l.expires = now(ctx) + 20_000;
    ctx.db.backend_lease().id().update(l);
    Ok(())
}
#[reducer]
pub fn release_backend(raw:&spacetimedb::ReducerContext, session: String) -> Result<(), String> { let ctx=SessionContext::for_sender(raw)?;release_backend_scoped(&ctx ,session) }
pub(crate) fn release_backend_scoped(ctx: &SessionContext, session: String) -> Result<(), String> {
    lease(ctx, &session)?;
    ctx.db.backend_lease().id().delete(0);
    Ok(())
}
#[reducer]
pub fn enqueue_backend_run(raw:&spacetimedb::ReducerContext, session: String, id: String, request_key: String, config: String) -> Result<(), String> { let ctx=SessionContext::for_sender(raw)?;enqueue_backend_run_scoped(&ctx ,session,id,request_key,config) }
pub(crate) fn enqueue_backend_run_scoped(
    ctx: &SessionContext,
    session: String,
    id: String,
    request_key: String,
    config: String,
) -> Result<(), String> {
    let l = lease(ctx, &session)?;
    if id.len() != 36 || request_key.is_empty() || request_key.len() > 100 || config.len() > 8192 {
        return Err("Invalid run".into());
    }
    serde_json::from_str::<serde_json::Value>(&config).map_err(|_| "Invalid config")?;
    if let Some(r) = ctx.db.backend_run().request_key().find(&request_key) {
        return if r.config == config {
            Ok(())
        } else {
            Err("Idempotency conflict".into())
        };
    }
    if ctx
        .db
        .backend_run()
        .iter()
        .filter(|r| active(&r.state))
        .count()
        >= l.max_total as usize
    {
        return Err("Run queue full".into());
    }
    ctx.db.backend_run().insert(Run {
        id,
        request_key,
        state: "queued".into(),
        created: now(ctx),
        updated: now(ctx),
        config,
        snapshot: String::new(),
        error: String::new(),
        sequence: 0,
    });
    Ok(())
}
#[reducer]
pub fn transition_backend_run(raw:&spacetimedb::ReducerContext, session: String, id: String, state: String, error: String) -> Result<(), String> { let ctx=SessionContext::for_sender(raw)?;transition_backend_run_scoped(&ctx ,session,id,state,error) }
pub(crate) fn transition_backend_run_scoped(
    ctx: &SessionContext,
    session: String,
    id: String,
    state: String,
    error: String,
) -> Result<(), String> {
    let l = lease(ctx, &session)?;
    let mut r = ctx.db.backend_run().id().find(&id).ok_or("Unknown run")?;
    if r.state == state {
        return Ok(());
    }
    let valid = match r.state.as_str() {
        "queued" => ["running", "cancelled"].contains(&state.as_str()),
        "running" => ["stopping", "completed", "cancelled", "failed"].contains(&state.as_str()),
        "stopping" => ["cancelled", "failed"].contains(&state.as_str()),
        _ => false,
    };
    if !valid || error.len() > 240 {
        return Err("Invalid run transition".into());
    }
    if state == "running"
        && ctx
            .db
            .backend_run()
            .iter()
            .filter(|r| ["running", "stopping"].contains(&r.state.as_str()))
            .count()
            >= l.max_active as usize
    {
        return Err("Active run limit".into());
    }
    r.state = state;
    r.error = error;
    r.updated = now(ctx);
    ctx.db.backend_run().id().update(r);
    Ok(())
}
#[reducer]
pub fn save_backend_snapshot(raw:&spacetimedb::ReducerContext, session: String, id: String, sequence: u64, payload: String) -> Result<(), String> { let ctx=SessionContext::for_sender(raw)?;save_backend_snapshot_scoped(&ctx ,session,id,sequence,payload) }
pub(crate) fn save_backend_snapshot_scoped(
    ctx: &SessionContext,
    session: String,
    id: String,
    sequence: u64,
    payload: String,
) -> Result<(), String> {
    lease(ctx, &session)?;
    let mut r = ctx.db.backend_run().id().find(&id).ok_or("Unknown run")?;
    if !["running", "stopping"].contains(&r.state.as_str()) || payload.len() > 8_000_000 {
        return Err("Run not writable".into());
    }
    if sequence <= r.sequence {
        return if sequence == r.sequence && payload == r.snapshot {
            Ok(())
        } else {
            Err("Stale snapshot".into())
        };
    }
    let data: serde_json::Value = serde_json::from_str(&payload).map_err(|_| "Invalid snapshot")?;
    if data["projectionVersion"] != 1 {
        return Err("Projection required".into());
    }
    if !r.snapshot.is_empty() {
        let old: serde_json::Value =
            serde_json::from_str(&r.snapshot).map_err(|_| "Invalid prior snapshot")?;
        if old["id"] != data["id"] {
            return Err("Match identity changed".into());
        }
    }
    let events = data["events"].as_array().ok_or("Events required")?;
    if events.len() > 6002 {
        return Err("Event limit".into());
    }
    for e in events {
        if e["matchId"] != data["id"] {
            return Err("Event match mismatch".into());
        }
        let event_id = e["id"].as_u64().ok_or("Invalid event id")?;
        let key = format!("{}:{}", id, event_id);
        let body = e.to_string();
        if let Some(old) = ctx.db.backend_event().key().find(&key) {
            if old.body != body {
                return Err("Event conflict".into());
            }
        } else {
            ctx.db.backend_event().insert(Event {
                key,
                run_id: id.clone(),
                event_id,
                at: e["at"].as_u64().unwrap_or(0),
                kind: e["kind"].as_str().unwrap_or("").into(),
                actor: e["actor"].as_str().unwrap_or("").into(),
                target: e["target"].as_str().unwrap_or("").into(),
                body,
            });
        }
    }
    r.snapshot = payload;
    r.sequence = sequence;
    r.updated = now(ctx);
    ctx.db.backend_run().id().update(r);
    Ok(())
}
#[reducer]
pub fn grant_backend_viewer(raw:&spacetimedb::ReducerContext, identity: String) -> Result<(), String> { let ctx=SessionContext::for_sender(raw)?;grant_backend_viewer_scoped(&ctx ,identity) }
pub(crate) fn grant_backend_viewer_scoped(ctx: &SessionContext, identity: String) -> Result<(), String> {
    owner(ctx)?;
    let identity = Identity::from_hex(identity).map_err(|_| "Invalid identity")?;
    if ctx.db.backend_viewer().identity().find(identity).is_none() {
        ctx.db.backend_viewer().insert(Viewer { identity });
    }
    Ok(())
}
#[view(accessor=visible_backend_runs,public)]
pub fn visible_backend_runs(raw:&spacetimedb::ViewContext) -> Vec<Run> { let ctx=SessionView::for_sender(raw);visible_backend_runs_scoped(&ctx) }
pub(crate) fn visible_backend_runs_scoped(ctx: &SessionView) -> Vec<Run> {
    if ctx
        .db
        .backend_viewer()
        .identity()
        .find(ctx.sender())
        .is_none()
    {
        return vec![];
    }
    ctx.db.backend_run().state().filter(""..).collect()
}
#[view(accessor=visible_backend_events,public)]
pub fn visible_backend_events(raw:&spacetimedb::ViewContext) -> Vec<Event> { let ctx=SessionView::for_sender(raw);visible_backend_events_scoped(&ctx) }
pub(crate) fn visible_backend_events_scoped(ctx: &SessionView) -> Vec<Event> {
    if ctx
        .db
        .backend_viewer()
        .identity()
        .find(ctx.sender())
        .is_none()
    {
        return vec![];
    }
    ctx.db.backend_event().run_id().filter(""..).collect()
}

#[table(accessor=backend_chat, index(accessor=scope, btree(columns=[role,epoch,generation])), index(accessor=conversation, btree(columns=[role,generation])) ,index(accessor=session_role, btree(columns=[session_id,role])),index(accessor=session_state, btree(columns=[session_id,state])),index(accessor=session_scope, btree(columns=[session_id,role,epoch,generation])),index(accessor=session_conversation, btree(columns=[session_id,role,generation])))]
#[derive(Clone)]
pub struct ChatOperation {
    #[primary_key] pub id: String,
    #[unique] pub request_key: String,
    #[index(btree)] pub role: String,
    pub epoch: u64,
    #[index(btree)] pub state: String,
    pub config: String,
    pub result: String,
    #[default(0)] pub generation:u64, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
#[table(accessor=backend_chat_transition ,index(accessor=session_operation, btree(columns=[session_id,operation])))]
pub struct ChatTransition {
    #[primary_key] #[auto_inc] id:u64,
    #[index(btree)] operation:String,
    state:String,
    at:i64, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
#[table(accessor=backend_chat_session)]
pub struct ChatSession { #[primary_key] role:String, generation:u64, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
pub(crate) fn conversation_generation(ctx:&SessionContext,role:&str)->u64 {
    ctx.db.backend_chat_session().role().find(session_key(ctx.session_id, &(role.to_string()))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|s|s.generation).unwrap_or(1)
}
pub(crate) fn visible_conversation_generation(ctx:&SessionView,role:&str)->u64 {
    ctx.db.backend_chat_session().role().find(session_key(ctx.session_id, &(role.to_string()))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|s|s.generation).unwrap_or(1)
}
fn config_generation(config:&str)->u64 {
    serde_json::from_str::<serde_json::Value>(config).ok().and_then(|v|v["conversation"].as_u64()).unwrap_or(1)
}
fn check_conversation(ctx:&SessionContext,role:&str,generation:u64)->Result<(),String>{
    if generation!=conversation_generation(ctx,role){return Err("Stale conversation".into())}Ok(())
}
fn clear_conversation(ctx:&SessionContext,role:&str) {
    let generation=conversation_generation(ctx,role)+1;
    ctx.db.backend_chat_session().role().delete(session_key(ctx.session_id, &(role.to_string())));
    ctx.db.backend_chat_session().insert(ScopedRow::stored(ChatSession{session_id:ctx.session_id,role:role.into(),generation},ctx.session_id)).local();
    for mut r in ctx.db.backend_chat().session_state().filter((ctx.session_id,"planning")).map(ScopedRow::local).filter(|r|r.role==role).map(|op|hydrate_operation(ctx,op)) {
        chat_transition(ctx,&r.id,"cancelled");r.state="cancelled".into();store_operation(ctx,r);
    }
    for mut t in ctx.db.backend_chat_turn().session_role().filter((ctx.session_id,role)).map(ScopedRow::local).filter(|t|["queued","running"].contains(&t.state.as_str())) {
        t.state="cancelled".into();t.updated=now(ctx);ctx.db.backend_chat_turn().id().update(ScopedRow::stored(t,ctx.session_id)).local();
    }
}
#[reducer]
pub fn new_chat(raw:&spacetimedb::ReducerContext, session:String, role:String, epoch:u64, generation:u64) ->Result<(),String> { let ctx=SessionContext::for_sender(raw)?;new_chat_scoped(&ctx ,session,role,epoch,generation) }
pub(crate) fn new_chat_scoped(ctx:&SessionContext,session:String,role:String,epoch:u64,generation:u64)->Result<(),String>{
    lease(ctx,&session)?;
    if !["attacker","defender"].contains(&role.as_str()){return Err("Invalid role".into())}
    check_chat_epoch(ctx,epoch)?;check_conversation(ctx,&role,generation)?;
    clear_conversation(ctx,&role);Ok(())
}
#[reducer]
pub fn reset_chat_fleet(raw:&spacetimedb::ReducerContext, session:String, epoch:u64, demo:bool) ->Result<(),String> { let ctx=SessionContext::for_sender(raw)?;reset_chat_fleet_scoped(&ctx ,session,epoch,demo) }
pub(crate) fn reset_chat_fleet_scoped(ctx:&SessionContext,session:String,epoch:u64,demo:bool)->Result<(),String>{
    lease(ctx,&session)?;check_chat_epoch(ctx,epoch)?;
    crate::fleet::reset_chat_fleet_scoped(ctx,demo)?;
    clear_conversation(ctx,"attacker");clear_conversation(ctx,"defender");
    Ok(())
}
// Fleet epoch and conversation generation fence deferred effects.
fn chat_epoch(ctx:&SessionContext)->u64 {
    ctx.db.fleet_session().id().find(entity_key(ctx.session_id, 0)).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|s|s.epoch).unwrap_or(0)
}
fn check_chat_epoch(ctx:&SessionContext,epoch:u64)->Result<(),String>{
    if epoch==0||epoch!=chat_epoch(ctx){return Err("Stale fleet session".into())}Ok(())
}
pub(crate) fn cancel_chat_session(ctx:&SessionContext) {
    hosted::clear_jobs(ctx);
    for mut r in ctx.db.backend_chat().session_state().filter((ctx.session_id,"planning")).map(ScopedRow::local).chain(ctx.db.backend_chat().session_state().filter((ctx.session_id,"running")).map(ScopedRow::local)).map(|op|hydrate_operation(ctx,op)) {
        if is_hosted_operation(ctx,&r.id){hosted::cancel_operation(ctx,r);continue}
        chat_transition(ctx,&r.id,"cancelled");r.state="cancelled".into();store_operation(ctx,r);
    }
    for mut t in ctx.db.backend_chat_turn().session_id().filter(ctx.session_id).map(ScopedRow::local).filter(|t|["queued","running"].contains(&t.state.as_str())) {
        t.state="cancelled".into();t.updated=now(ctx);ctx.db.backend_chat_turn().id().update(ScopedRow::stored(t,ctx.session_id)).local();
    }
}
fn chat_transition(ctx:&SessionContext, operation:&str, state:&str) {
    ctx.db.backend_chat_transition().insert(ScopedRow::stored(ChatTransition{session_id:ctx.session_id,id:0,operation:operation.into(),state:state.into(),at:now(ctx)},ctx.session_id)).local();
}
#[reducer]
pub fn create_chat_operation(raw:&spacetimedb::ReducerContext, session: String, id: String, key: String, role: String, epoch: u64, config: String) -> Result<(), String> { let ctx=SessionContext::for_sender(raw)?;create_chat_operation_scoped(&ctx ,session,id,key,role,epoch,config) }
pub(crate) fn create_chat_operation_scoped(ctx: &SessionContext, session: String, id: String, key: String, role: String, epoch: u64, config: String) -> Result<(), String> {
    lease(ctx, &session)?;
    if !["attacker", "defender"].contains(&role.as_str()) || config.len()>16000 || id.len()!=36 || key.len()>160 { return Err("Invalid chat operation".into()); }
    crate::fleet::validate_chat_fleet(ctx,epoch)?;
    check_conversation(ctx,&role,config_generation(&config))?;
    if let Some(old)=ctx.db.backend_chat().request_key().find(session_key(ctx.session_id, &(&key))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|op|hydrate_operation(ctx,op)) {
        return if old.epoch==epoch && old.config==config && old.role==role {Ok(())}else{Err("Idempotency conflict".into())};
    }
    if ctx.db.backend_chat().session_scope().filter((ctx.session_id,role.as_str(),epoch,config_generation(&config))).map(ScopedRow::local).any(|r|["planning","running"].contains(&r.state.as_str())) {return Err("Role operation already active".into())}
    let v:serde_json::Value=serde_json::from_str(&config).map_err(|_|"Invalid config")?;
    let deadline=v["deadline"].as_i64().ok_or("Missing deadline")?;
    if deadline<=now(ctx)||deadline>now(ctx)+75000||v["maxDecisionsPerAgent"].as_u64()!=Some(8)||v["maxModelCalls"].as_u64()!=Some(33) {return Err("Invalid operation budget".into())}
    let target=v["target"].as_u64().unwrap_or(0);
    if !v["target"].is_null() && (target==0||target>u32::MAX as u64){return Err("Invalid selected target".into())}
    if target>0 {crate::fleet::validate_chat_target(ctx,&role,target as u32)?;}
    let message=v["message"].as_str().ok_or("Missing objective")?;
    if let Some(turn_id)=v["turnId"].as_str(){
        let turn=ctx.db.backend_chat_turn().id().find(session_key(ctx.session_id, &(turn_id.to_string()))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).ok_or("Turn missing")?;
        if turn.epoch!=epoch||turn.role!=role||turn.state!="running"{return Err("Turn outside role or inactive".into())}
    }else{append_chat_message(ctx,config_generation(&config),format!("{}:user",key),&role,&id,"operator",message.into(),target as u32)?;}
    append_chat_message(ctx,config_generation(&config),format!("{}:planning",id),&role,&id,"coordinator","Planning a bounded operation. No action has executed yet.".into(),target as u32)?;
    crate::fleet::enable_fleet_chat_scoped(ctx)?;
    chat_transition(ctx,&id,"planning");
    let hosted=crate::hosted_scheduler(ctx)||cfg!(feature="mission-fixtures")&&session=="maincloud";
    let op=ctx.db.backend_chat().insert(ScopedRow::stored(ChatOperation{session_id:ctx.session_id,generation:config_generation(&config),id,request_key:key,role,epoch,state:"planning".into(),config,result:"[]".into()},ctx.session_id)).local();
    if hosted{normalize_operation(ctx,op)?;} Ok(())
}
#[reducer]
pub fn plan_chat_operation(raw:&spacetimedb::ReducerContext, session:String, id:String, tasks:String) ->Result<(),String> { let ctx=SessionContext::for_sender(raw)?;plan_chat_operation_scoped(&ctx ,session,id,tasks) }
pub(crate) fn plan_chat_operation_scoped(ctx:&SessionContext,session:String,id:String,tasks:String)->Result<(),String>{
    lease(ctx,&session)?;
    let mut r=ctx.db.backend_chat().id().find(session_key(ctx.session_id, &(&id))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|op|hydrate_operation(ctx,op)).ok_or("Operation missing")?;
    if r.state!="planning" {return Err("Operation not planning".into())}
    let mut v:serde_json::Value=serde_json::from_str(&r.config).map_err(|_|"Invalid config")?;
    if now(ctx)>=v["deadline"].as_i64().ok_or("Missing deadline")? {return Err("Operation expired".into())}
    crate::fleet::validate_chat_fleet(ctx,r.epoch)?;
    let assignments:serde_json::Value=serde_json::from_str(&tasks).map_err(|_|"Invalid assignments")?;
    let entries=assignments.as_array().ok_or("Invalid assignments")?;
    if !(1..=4).contains(&entries.len()) {return Err("Require 1..4 specialists".into())}
    let mut used=std::collections::HashSet::new();
    let mut names=std::collections::HashSet::new();
    for t in entries {
        let a=t["agentId"].as_u64().filter(|n|*n<=u32::MAX as u64).ok_or("Invalid agent")? as u32;
        let d=t["target"].as_u64().filter(|n|*n<=u32::MAX as u64).ok_or("Invalid target")? as u32;
        if !used.insert(a)||!matches!(t.as_object().map(|o|o.len()),Some(5)|Some(6))||!goal_valid(&r.role,if t.get("goal").is_some(){t["goal"].as_str().unwrap_or("")}else{task_goal(t,&r.role)})||t.as_object().unwrap().keys().any(|k|!["agentId","name","specialty","target","objective","goal"].contains(&k.as_str()))||t["objective"].as_str().map(|s|s.trim().is_empty()||s.len()>1200).unwrap_or(true) {return Err("Invalid assignment".into())}
        if let Some(target)=v["target"].as_u64(){if target!=d as u64{return Err("Outside selected target".into())}}
        let name=t["name"].as_str().ok_or("Missing name")?;
        let specialty=t["specialty"].as_str().ok_or("Missing specialty")?;
        if name.is_empty()||name.chars().count()>32||name.trim()!=name||!name.chars().all(|c|c.is_ascii_alphanumeric()||c==' '||c=='-')||!names.insert(name.to_ascii_lowercase())||specialty.is_empty()||specialty.len()>48||!specialty.chars().all(|c|c.is_ascii_alphanumeric()||c==' '||c=='-'){return Err("Invalid specialist name or specialty".into())}
        crate::fleet::deploy_chat_agent(ctx,&r.role,r.epoch,a,d,name,specialty,&id)?;
    }
    let detail=entries.iter().map(|t|format!("{} ({}) → DR-{:03}: {}",t["name"].as_str().unwrap(),t["specialty"].as_str().unwrap(),t["target"].as_u64().unwrap(),t["objective"].as_str().unwrap())).collect::<Vec<_>>().join("\n");
    append_chat_message(ctx,r.generation,format!("{}:plan",id),&r.role,&id,"coordinator",format!("Validated assignments (instructions, not results):\n{}",detail),v["target"].as_u64().unwrap_or(0) as u32)?;
    v["tasks"]=assignments;r.config=v.to_string();r.state="running".into();
    chat_transition(ctx,&id,"running");store_operation(ctx,r);Ok(())
}
#[reducer]
pub fn update_chat_operation(raw:&spacetimedb::ReducerContext, session: String, id: String, state: String, result: String) -> Result<(),String> { let ctx=SessionContext::for_sender(raw)?;update_chat_operation_scoped(&ctx ,session,id,state,result) }
pub(crate) fn update_chat_operation_scoped(ctx: &SessionContext, session: String, id: String, state: String, result: String) -> Result<(),String> {
    lease(ctx,&session)?;
    if !["planning","running","completed","partial","blocked","exhausted","cancelled","failed"].contains(&state.as_str()) || result.len()>200000 {return Err("Invalid operation result".into())}
    let mut r=ctx.db.backend_chat().id().find(session_key(ctx.session_id, &(&id))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|op|hydrate_operation(ctx,op)).ok_or("Operation missing")?;
    check_chat_epoch(ctx,r.epoch)?;
    if !["planning","running"].contains(&r.state.as_str()) {return Err("Operation already terminal".into())}
    if (state=="running"&&r.state!="running") || (state=="planning"&&r.state!="planning") || (state=="completed"&&r.state!="running") {return Err("Invalid transition".into())}
    serde_json::from_str::<Vec<serde_json::Value>>(&result).map_err(|_|"Invalid result")?;
    if r.state!=state {
      chat_transition(ctx,&id,&state);
      if !["planning","running"].contains(&state.as_str()){append_chat_message(ctx,r.generation,format!("{}:terminal",id),&r.role,&id,"coordinator",chat_summary(&state,&result),0)?;}
    }
    if !["planning","running"].contains(&state.as_str()){hosted::cleanup_operation(ctx,&id);}
    r.state=state;r.result=result;store_operation(ctx,r);Ok(())
}
pub(crate) fn chat_authority(ctx:&SessionContext, session:&str, id:&str, agent:u32, target:u32, epoch:u64)->Result<String,String>{
    lease(ctx,session)?;
    let r=ctx.db.backend_chat().id().find(session_key(ctx.session_id, &(id.to_string()))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|op|hydrate_operation(ctx,op)).ok_or("Operation missing")?;
    if r.state!="running" || r.epoch!=epoch {return Err("Operation inactive".into())}
    let v:serde_json::Value=serde_json::from_str(&r.config).map_err(|_|"Invalid config")?;
    if now(ctx)>=v["deadline"].as_i64().ok_or("Missing deadline")? {return Err("Operation expired".into())}
    if !v["tasks"].as_array().ok_or("Missing tasks")?.iter().any(|t| t["agentId"].as_u64()==Some(agent as u64)&&t["target"].as_u64()==Some(target as u64)){return Err("Outside assignment".into())}
    Ok(r.role)
}

pub(crate) fn check_goal_action(ctx:&SessionContext,id:&str,agent:u32,kind:&str)->Result<(),String>{
 let op=ctx.db.backend_chat().id().find(session_key(ctx.session_id, &(id.to_string()))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|op|hydrate_operation(ctx,op)).ok_or("Operation missing")?;
 let config:serde_json::Value=serde_json::from_str(&op.config).map_err(|_|"Invalid assignment")?;
 let task=config["tasks"].as_array().unwrap().iter().find(|t|t["agentId"]==agent).ok_or("Assignment missing")?;
 if let Some(goal)=task["goal"].as_str(){let goals:serde_json::Value=serde_json::from_str(include_str!("../../shared/fleet-goals.json")).unwrap();if kind!="wait"&&!goals[goal]["actions"].as_array().map(|a|a.iter().any(|a|a==kind)).unwrap_or(false){return Err("Outside assignment objective".into())}}
 Ok(())
}

#[table(accessor=backend_chat_message, index(accessor=scope, btree(columns=[role,epoch,generation])), index(accessor=conversation, btree(columns=[role,generation])) ,index(accessor=session_role, btree(columns=[session_id,role])),index(accessor=session_scope, btree(columns=[session_id,role,epoch,generation])),index(accessor=session_conversation, btree(columns=[session_id,role,generation])))]
pub struct ChatMessage {
    #[primary_key] #[auto_inc] id:u64,
    #[unique] key:String,
    #[index(btree)] role:String,
    operation:String,
    speaker:String,
    text:String,
    target:u32,
    at:i64,
    #[default(0)] epoch:u64,
    #[default(0)] generation:u64, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
fn append_chat_message(ctx:&SessionContext,generation:u64,key:String,role:&str,operation:&str,speaker:&str,text:String,target:u32)->Result<(),String>{
    if generation!=conversation_generation(ctx,role){return Ok(())}
    let key=format!("epoch:{}:chat:{}:{}",chat_epoch(ctx),generation,key);
    if let Some(old)=ctx.db.backend_chat_message().key().find(session_key(ctx.session_id, &(&key))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local) {
        return if old.role==role&&old.text==text&&old.target==target {Ok(())}else{Err("Idempotency conflict".into())};
    }
    ctx.db.backend_chat_message().insert(ScopedRow::stored(ChatMessage{session_id:ctx.session_id,epoch:chat_epoch(ctx),generation,id:0,key,role:role.into(),operation:operation.into(),speaker:speaker.into(),text,target,at:now(ctx)},ctx.session_id)).local();Ok(())
}
#[reducer]
pub fn record_chat_exchange(raw:&spacetimedb::ReducerContext, session:String, key:String, role:String, message:String, target:u32, operation:String, reply:String) ->Result<(),String> { let ctx=SessionContext::for_sender(raw)?;record_chat_exchange_scoped(&ctx ,session,key,role,message,target,operation,reply) }
pub(crate) fn record_chat_exchange_scoped(ctx:&SessionContext,session:String,key:String,role:String,message:String,target:u32,operation:String,reply:String)->Result<(),String>{
    lease(ctx,&session)?;
    if !["attacker","defender"].contains(&role.as_str())||key.len()>160||message.trim().is_empty()||message.len()>8000||reply.len()>8000{return Err("Invalid conversation message".into())}
    let generation=key.split(':').nth(2).and_then(|s|s.parse::<u64>().ok()).unwrap_or(1);
    check_conversation(ctx,&role,generation)?;
    if !key.starts_with(&format!("{}:{}:",chat_epoch(ctx),role)){return Err("Stale fleet session".into())}
    if !operation.is_empty() && ctx.db.backend_chat().id().find(session_key(ctx.session_id, &(&operation))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|op|hydrate_operation(ctx,op)).map(|r|(r.role,r.epoch))!=Some((role.clone(),chat_epoch(ctx))){return Err("Operation outside role".into())}
    if target>0 {crate::fleet::validate_chat_target(ctx,&role,target)?;}
    append_chat_message(ctx,generation,format!("{}:user",key),&role,&operation,"operator",message,target)?;
    append_chat_message(ctx,generation,format!("{}:reply",key),&role,&operation,"coordinator",reply,target)
}
fn chat_summary(state:&str,result:&str)->String {
    let rows:Vec<serde_json::Value>=serde_json::from_str(result).unwrap_or_default();
    let simulations:Vec<_>=rows.iter().filter(|r|r["status"]=="executed"&&r["simulation"].is_object()).collect();
    if let Some(mission)=rows.iter().rev().find(|r|r["type"]=="mission") {
        let evidence:Vec<_>=simulations.iter().rev().take(3).filter_map(|r|r["evidenceId"].as_u64()).filter(|id|*id>0).map(|id|format!("#{}",id)).collect();
        let mut agents=std::collections::HashSet::new();
        let unresolved=rows.iter().rev().filter(|r|r["type"]=="worker"&&agents.insert(r["agentId"].as_u64())).filter(|r|["blocked","failed","exhausted"].contains(&r["state"].as_str().unwrap_or(""))).take(2).filter_map(|r|r["reason"].as_str().or_else(||r["error"].as_str())).collect::<std::collections::BTreeSet<_>>().into_iter().collect::<Vec<_>>();
        let verified=mission["conditions"].as_array().into_iter().flatten().filter(|c|c["verified"]==true).map(|c|format!("{} DR-{:03}",c["goal"].as_str().unwrap_or("objective"),c["target"].as_u64().unwrap_or(0))).collect::<Vec<_>>();
        return format!("Mission {}: {} of {} objectives verified in the synthetic simulation.{}{}{}",mission["outcome"].as_str().unwrap_or(state).replace('_'," "),mission["completed"],mission["total"],if verified.is_empty(){String::new()}else{format!(" Verified assignments: {}.",verified.join(", "))},if evidence.is_empty(){String::new()}else{format!(" Evidence: {}.",evidence.join(", "))},if unresolved.is_empty(){String::new()}else{format!(" Unresolved: {}",unresolved.join(" ").replace('_'," "))});
    }
    if !simulations.is_empty(){return format!("Operation {}. Simulated outcomes: {}",state,simulations.iter().rev().take(3).filter_map(|r|r["simulation"]["summary"].as_str()).collect::<Vec<_>>().join(" "))}
    let count=|kind:&str|rows.iter().filter(|r|r["status"]=="executed"&&r["outcome"]==kind).count();
    let errors:Vec<&str>=rows.iter().filter_map(|r|r["error"].as_str()).collect();
    format!("Operation {}. {} accepted unauthorized commands, {} blocked commands, {} verified recoveries.{}",state,count("unauthorized_command_accepted"),count("unauthorized_command_blocked"),count("recovery_verified"),if errors.is_empty(){String::new()}else{format!(" Recorded failures: {}. No fixture fallback was used.",errors.join(", "))})
}

#[reducer]
pub fn activate_chat_fleet(raw:&spacetimedb::ReducerContext, session:String, role:String) ->Result<(),String> { let ctx=SessionContext::for_sender(raw)?;activate_chat_fleet_scoped(&ctx ,session,role) }
pub(crate) fn activate_chat_fleet_scoped(ctx:&SessionContext,session:String,role:String)->Result<(),String>{
 lease(ctx,&session)?;
 if !["attacker","defender"].contains(&role.as_str()){return Err("Invalid role".into())}
 crate::fleet::activate_chat_fleet_scoped(ctx,&role)
}


pub(crate) fn has_agent_assignment(ctx:&SessionContext,epoch:u64,id:u32)->bool {
    if hosted_has_assignment(ctx,epoch,id){return true}
    ctx.db.backend_chat().session_role().filter((ctx.session_id,"attacker")).map(ScopedRow::local).chain(ctx.db.backend_chat().session_role().filter((ctx.session_id,"defender")).map(ScopedRow::local)).filter(|r|r.epoch==epoch&&!is_hosted_operation(ctx,&r.id)).any(|r| {
        serde_json::from_str::<serde_json::Value>(&r.config).ok().and_then(|v|v["tasks"].as_array().cloned()).map(|tasks|tasks.iter().any(|t|t["agentId"].as_u64()==Some(id as u64))).unwrap_or(false)
    })
}

// Conversation inference is durable and role-private; it is not a deployed operation.
#[table(accessor=backend_chat_turn, index(accessor=scope, btree(columns=[role,epoch,generation])), index(accessor=conversation, btree(columns=[role,generation])) ,index(accessor=session_role, btree(columns=[session_id,role])),index(accessor=session_scope, btree(columns=[session_id,role,epoch,generation])),index(accessor=session_conversation, btree(columns=[session_id,role,generation])))]
pub struct ChatTurn {
    #[primary_key] id:String,
    #[unique] request_key:String,
    #[index(btree)] role:String,
    state:String,
    config:String,
    result:String,
    created:i64,
    updated:i64,
    #[default(0)] epoch:u64,
    #[default(0)] generation:u64, #[default(0)] #[index(btree)] pub(crate) session_id:u32 }
#[reducer]
pub fn create_chat_turn(raw:&spacetimedb::ReducerContext, session:String, id:String, key:String, role:String, config:String) ->Result<(),String> { let ctx=SessionContext::for_sender(raw)?;create_chat_turn_scoped(&ctx ,session,id,key,role,config) }
pub(crate) fn create_chat_turn_scoped(ctx:&SessionContext,session:String,id:String,key:String,role:String,config:String)->Result<(),String>{
    lease(ctx,&session)?;
    if id.len()!=36||key.len()>160||!["attacker","defender"].contains(&role.as_str())||config.len()>12000{return Err("Invalid conversation turn".into())}
    let v:serde_json::Value=serde_json::from_str(&config).map_err(|_|"Invalid turn config")?;
    check_chat_epoch(ctx,v["epoch"].as_u64().ok_or("Missing fleet epoch")?)?;
    check_conversation(ctx,&role,config_generation(&config))?;
    if let Some(old)=ctx.db.backend_chat_turn().request_key().find(session_key(ctx.session_id, &(&key))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local){return if old.role==role&&old.config==config{Ok(())}else{Err("Idempotency conflict".into())}}
    if ctx.db.backend_chat_turn().session_role().filter((ctx.session_id,role.as_str())).map(ScopedRow::local).any(|t|["queued","running"].contains(&t.state.as_str())){return Err("Conversation already pending".into())}
    let message=v["message"].as_str().filter(|m|!m.trim().is_empty()&&m.len()<=8000).ok_or("Invalid message")?;
    let target=v["target"].as_u64().unwrap_or(0);
    let deadline=v["deadline"].as_i64().ok_or("Missing turn deadline")?;
    if deadline<=now(ctx)||deadline>now(ctx)+30000||target>u64::from(crate::formation::MAX_DRONES){return Err("Invalid turn budget".into())}
    if target>0{crate::fleet::validate_chat_target(ctx,&role,target as u32)?;}
    append_chat_message(ctx,config_generation(&config),format!("{}:user",key),&role,"","operator",message.into(),target as u32)?;
    append_chat_message(ctx,config_generation(&config),format!("{}:accepted",id),&role,"","coordinator","Message accepted. Considering your request…".into(),target as u32)?;
    ctx.db.backend_chat_turn().insert(ScopedRow::stored(ChatTurn{session_id:ctx.session_id,epoch:chat_epoch(ctx),generation:conversation_generation(ctx,&role),id,request_key:key,role,state:"queued".into(),config,result:"{}".into(),created:now(ctx),updated:now(ctx)},ctx.session_id)).local();Ok(())
}
#[reducer]
pub fn update_chat_turn(raw:&spacetimedb::ReducerContext, session:String, id:String, state:String, result:String, reply:String) ->Result<(),String> { let ctx=SessionContext::for_sender(raw)?;update_chat_turn_scoped(&ctx ,session,id,state,result,reply) }
pub(crate) fn update_chat_turn_scoped(ctx:&SessionContext,session:String,id:String,state:String,result:String,reply:String)->Result<(),String>{
    lease(ctx,&session)?;
    let mut t=ctx.db.backend_chat_turn().id().find(session_key(ctx.session_id, &(&id))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).ok_or("Turn missing")?;
    check_chat_epoch(ctx,t.epoch)?;
    check_conversation(ctx,&t.role,t.generation)?;
    if !["queued","running"].contains(&t.state.as_str())||!["queued","running","completed","failed","cancelled"].contains(&state.as_str())||result.len()>20000||reply.len()>8000{return Err("Invalid turn transition".into())}
    serde_json::from_str::<serde_json::Value>(&result).map_err(|_|"Invalid turn result")?;
    if !["queued","running"].contains(&state.as_str()){
        append_chat_message(ctx,t.generation,format!("{}:reply",id),&t.role,"","coordinator",reply,0)?;
    }
    t.state=state;t.result=result;t.updated=now(ctx);ctx.db.backend_chat_turn().id().update(ScopedRow::stored(t,ctx.session_id)).local();Ok(())
}

#[path="maincloud.rs"]
pub(crate) mod hosted;

// The scheduler rechecks authority before every deferred effect, including after a restart.
pub(crate) fn battle_operation_active(ctx:&SessionContext,id:&str,epoch:u64,agent:u32,target:u32)->bool {
 ctx.db.backend_chat().id().find(session_key(ctx.session_id, &(id.to_string()))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|op|hydrate_operation(ctx,op)).map(|r|r.epoch==epoch&&r.state=="running"&&hosted::battle_authorized(ctx,id,agent,target)&&serde_json::from_str::<serde_json::Value>(&r.config).ok().and_then(|v|v["deadline"].as_i64()).map(|d|now(ctx)<d).unwrap_or(false)).unwrap_or(false)
}
pub(crate) fn battle_message(ctx:&SessionContext,operation:&str,key:&str,stage:&str,report:&str){
 if let Some(mut r)=ctx.db.backend_chat().id().find(session_key(ctx.session_id, &(operation.to_string()))).filter(|row|row.session_id==ctx.session_id).map(ScopedRow::local).map(|op|hydrate_operation(ctx,op)) {
  if r.epoch!=chat_epoch(ctx){return}
  let report:serde_json::Value=serde_json::from_str(report).unwrap_or_default();
  if stage=="resolved"{
   let mut records:Vec<serde_json::Value>=serde_json::from_str(&r.result).unwrap_or_default();
   if let Some(record)=records.iter_mut().find(|v|v["actionId"]==key){record["stage"]=serde_json::json!(stage);record["simulation"]=report.clone();record["status"]=serde_json::json!("executed");if let Some(outcome)=report["outcome"].as_str(){record["outcome"]=serde_json::json!(outcome);}}
   r.result=serde_json::json!(records).to_string();store_operation(ctx,r);
  }
 }
}

#[path="activity.rs"]
mod activity;

pub(crate) fn task_goal<'a>(task:&'a serde_json::Value,role:&str)->&'a str{task["goal"].as_str().unwrap_or(if role=="attacker"{"capture"}else{"recover"})}
pub(crate) fn goal_valid(role:&str,goal:&str)->bool{let goals:serde_json::Value=serde_json::from_str(include_str!("../../shared/fleet-goals.json")).unwrap();goals[goal]["role"].as_str()==Some(role)}
pub(crate) fn goal_options(ctx:&SessionContext,role:&str,target:u32,goal:&str)->serde_json::Value{
 let mut options=crate::fleet::battle_options(ctx,role,target);
 let goals:serde_json::Value=serde_json::from_str(include_str!("../../shared/fleet-goals.json")).unwrap();
 let permitted=goals[goal]["actions"].as_array().cloned().unwrap_or_default();
 if let Some(actions)=options["actions"].as_array_mut(){actions.retain(|a|permitted.contains(a));}
 if options["actions"].as_array().map(|a|a.is_empty()).unwrap_or(true)&&options["blocker"].as_str().unwrap_or("").is_empty(){options["blocker"]=serde_json::json!("No useful action remains within this assignment's objective.");}
 options
}
pub(crate) fn expire_chat_operations(ctx:&SessionContext){
 let epoch=chat_epoch(ctx);
 for mut op in ctx.db.backend_chat().session_state().filter((ctx.session_id,"running")).map(ScopedRow::local).chain(ctx.db.backend_chat().session_state().filter((ctx.session_id,"planning")).map(ScopedRow::local)).map(|op|hydrate_operation(ctx,op)).filter(|r|r.epoch==epoch){
  let config:serde_json::Value=serde_json::from_str(&op.config).unwrap_or_default();
  if config["deadline"].as_i64().map(|d|now(ctx)>=d).unwrap_or(false){
   if hosted::expire_operation(ctx,&op.id){continue}
   let mut records:Vec<serde_json::Value>=serde_json::from_str(&op.result).unwrap_or_default();
   for task in config["tasks"].as_array().unwrap_or(&vec![]){let agent=task["agentId"].clone();let last=records.iter().rev().find(|r|r["type"]=="worker"&&r["agentId"]==agent);if last.map(|r|["working","running","queued"].contains(&r["state"].as_str().unwrap_or(""))).unwrap_or(true){records.push(serde_json::json!({"type":"worker","agentId":agent,"target":task["target"],"state":"failed","reason":"Operation time budget exhausted.","at":now(ctx)}));}}
   op.state="failed".into();op.result=serde_json::json!(records).to_string();chat_transition(ctx,&op.id,"failed");
   let _=append_chat_message(ctx,op.generation,format!("{}:terminal",op.id),&op.role,&op.id,"coordinator","Operation stopped: time budget exhausted.".into(),0);
   hosted::cleanup_operation(ctx,&op.id);store_operation(ctx,op);
  }
 }
}

#[path="workflow.rs"]
pub(crate) mod workflow;
use workflow::*;

impl ScopedRow for ChatOperation { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.id=session_key(session,&self.id);self.request_key=session_key(session,&self.request_key);self} fn local(mut self)->Self{self.id=local_key(self.session_id,&self.id);self.request_key=local_key(self.session_id,&self.request_key);self}}

impl ScopedRow for ChatTransition { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self} fn local(mut self)->Self{self}}

impl ScopedRow for ChatSession { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.role=session_key(session,&self.role);self} fn local(mut self)->Self{self.role=local_key(self.session_id,&self.role);self}}

impl ScopedRow for ChatMessage { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.key=session_key(session,&self.key);self} fn local(mut self)->Self{self.key=local_key(self.session_id,&self.key);self}}

impl ScopedRow for ChatTurn { fn stored(mut self,session:u32)->Self{assert_eq!(self.session_id,session,"Session ownership");self.id=session_key(session,&self.id);self.request_key=session_key(session,&self.request_key);self} fn local(mut self)->Self{self.id=local_key(self.session_id,&self.id);self.request_key=local_key(self.session_id,&self.request_key);self}}

pub(crate) fn delete_session_state(raw:&spacetimedb::ReducerContext,session:u32){
for row in raw.db.backend_chat().session_id().filter(session){raw.db.backend_chat().id().delete(row.id);}
for row in raw.db.backend_chat_transition().session_id().filter(session){raw.db.backend_chat_transition().id().delete(row.id);}
for row in raw.db.backend_chat_session().session_id().filter(session){raw.db.backend_chat_session().role().delete(row.role);}
for row in raw.db.backend_chat_message().session_id().filter(session){raw.db.backend_chat_message().id().delete(row.id);}
for row in raw.db.backend_chat_turn().session_id().filter(session){raw.db.backend_chat_turn().id().delete(row.id);}
}
