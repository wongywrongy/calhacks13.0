//! Durable backend control plane. Every mutation is an owner-authorized transaction.
use crate::publisher;
use spacetimedb::{reducer, table, view, Identity, ReducerContext, Table, ViewContext};
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
fn now(ctx: &ReducerContext) -> i64 {
    ctx.timestamp.to_micros_since_unix_epoch() / 1000
}
fn owner(ctx: &ReducerContext) -> Result<(), String> {
    if ctx.db.publisher().id().find(0).map(|p| p.identity) != Some(ctx.sender()) {
        return Err("Owner required".into());
    }
    Ok(())
}
fn lease(ctx: &ReducerContext, session: &str) -> Result<Lease, String> {
    owner(ctx)?;
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
pub fn acquire_backend(
    ctx: &ReducerContext,
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
    for mut r in ctx.db.backend_chat().iter().filter(|r|["planning","running"].contains(&r.state.as_str())) { chat_transition(ctx,&r.id,"interrupted"); append_chat_message(ctx,format!("{}:terminal",r.id),&r.role,&r.id,"coordinator","Operation interrupted by backend restart. No automatic resumption.".into(),0)?; r.state="interrupted".into(); ctx.db.backend_chat().id().update(r); }
    for mut t in ctx.db.backend_chat_turn().iter().filter(|t|["queued","running"].contains(&t.state.as_str())) {
        append_chat_message(ctx,format!("{}:reply",t.id),&t.role,"","coordinator","Conversation interrupted by backend restart. Please retry your request.".into(),0)?;
        t.state="failed".into();t.updated=now(ctx);ctx.db.backend_chat_turn().id().update(t);
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
pub fn heartbeat_backend(ctx: &ReducerContext, session: String) -> Result<(), String> {
    let mut l = lease(ctx, &session)?;
    l.expires = now(ctx) + 20_000;
    ctx.db.backend_lease().id().update(l);
    Ok(())
}
#[reducer]
pub fn release_backend(ctx: &ReducerContext, session: String) -> Result<(), String> {
    lease(ctx, &session)?;
    ctx.db.backend_lease().id().delete(0);
    Ok(())
}
#[reducer]
pub fn enqueue_backend_run(
    ctx: &ReducerContext,
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
pub fn transition_backend_run(
    ctx: &ReducerContext,
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
pub fn save_backend_snapshot(
    ctx: &ReducerContext,
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
pub fn grant_backend_viewer(ctx: &ReducerContext, identity: String) -> Result<(), String> {
    owner(ctx)?;
    let identity = Identity::from_hex(identity).map_err(|_| "Invalid identity")?;
    if ctx.db.backend_viewer().identity().find(identity).is_none() {
        ctx.db.backend_viewer().insert(Viewer { identity });
    }
    Ok(())
}
#[view(accessor=visible_backend_runs,public)]
pub fn visible_backend_runs(ctx: &ViewContext) -> Vec<Run> {
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
pub fn visible_backend_events(ctx: &ViewContext) -> Vec<Event> {
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

#[table(accessor=backend_chat)]
#[derive(Clone)]
pub struct ChatOperation {
    #[primary_key] pub id: String,
    #[unique] pub request_key: String,
    pub role: String,
    pub epoch: u64,
    pub state: String,
    pub config: String,
    pub result: String,
}
#[table(accessor=backend_chat_transition)]
pub struct ChatTransition {
    #[primary_key] #[auto_inc] id:u64,
    #[index(btree)] operation:String,
    state:String,
    at:i64,
}
fn chat_transition(ctx:&ReducerContext, operation:&str, state:&str) {
    ctx.db.backend_chat_transition().insert(ChatTransition{id:0,operation:operation.into(),state:state.into(),at:now(ctx)});
}
#[reducer]
pub fn create_chat_operation(ctx: &ReducerContext, session: String, id: String, key: String, role: String, epoch: u64, config: String) -> Result<(), String> {
    lease(ctx, &session)?;
    if !["attacker", "defender"].contains(&role.as_str()) || config.len()>16000 || id.len()!=36 || key.len()>120 { return Err("Invalid chat operation".into()); }
    if let Some(old)=ctx.db.backend_chat().request_key().find(&key) {
        return if old.config==config && old.role==role {Ok(())}else{Err("Idempotency conflict".into())};
    }
    if ctx.db.backend_chat().iter().any(|r|r.role==role && ["planning","running"].contains(&r.state.as_str())) {return Err("Role operation already active".into())}
    let v:serde_json::Value=serde_json::from_str(&config).map_err(|_|"Invalid config")?;
    let deadline=v["deadline"].as_i64().ok_or("Missing deadline")?;
    if deadline<=now(ctx)||deadline>now(ctx)+75000||v["maxDecisionsPerAgent"].as_u64()!=Some(8)||v["maxModelCalls"].as_u64()!=Some(33) {return Err("Invalid operation budget".into())}
    crate::fleet::validate_chat_fleet(ctx,epoch)?;
    let target=v["target"].as_u64().unwrap_or(0);
    if !v["target"].is_null() && (target==0||target>u32::MAX as u64){return Err("Invalid selected target".into())}
    if target>0 {crate::fleet::validate_chat_target(ctx,&role,target as u32)?;}
    let message=v["message"].as_str().ok_or("Missing objective")?;
    if let Some(turn_id)=v["turnId"].as_str(){
        let turn=ctx.db.backend_chat_turn().id().find(turn_id.to_string()).ok_or("Turn missing")?;
        if turn.role!=role||turn.state!="running"{return Err("Turn outside role or inactive".into())}
    }else{append_chat_message(ctx,format!("{}:user",key),&role,&id,"operator",message.into(),target as u32)?;}
    append_chat_message(ctx,format!("{}:planning",id),&role,&id,"coordinator","Planning a bounded operation. No action has executed yet.".into(),target as u32)?;
    crate::fleet::enable_fleet_chat(ctx)?;
    chat_transition(ctx,&id,"planning");
    ctx.db.backend_chat().insert(ChatOperation{id,request_key:key,role,epoch,state:"planning".into(),config,result:"[]".into()}); Ok(())
}
#[reducer]
pub fn plan_chat_operation(ctx:&ReducerContext,session:String,id:String,tasks:String)->Result<(),String>{
    lease(ctx,&session)?;
    let mut r=ctx.db.backend_chat().id().find(&id).ok_or("Operation missing")?;
    if r.state!="planning" {return Err("Operation not planning".into())}
    let mut v:serde_json::Value=serde_json::from_str(&r.config).map_err(|_|"Invalid config")?;
    if now(ctx)>=v["deadline"].as_i64().ok_or("Missing deadline")? {return Err("Operation expired".into())}
    crate::fleet::validate_chat_fleet(ctx,r.epoch)?;
    let assignments:serde_json::Value=serde_json::from_str(&tasks).map_err(|_|"Invalid assignments")?;
    let entries=assignments.as_array().ok_or("Invalid assignments")?;
    if !(2..=4).contains(&entries.len()) {return Err("Require 2..4 specialists".into())}
    let mut used=std::collections::HashSet::new();
    let mut names=std::collections::HashSet::new();
    for t in entries {
        let a=t["agentId"].as_u64().filter(|n|*n<=u32::MAX as u64).ok_or("Invalid agent")? as u32;
        let d=t["target"].as_u64().filter(|n|*n<=u32::MAX as u64).ok_or("Invalid target")? as u32;
        if !used.insert(a)||t.as_object().map(|o|o.len())!=Some(5)||t["objective"].as_str().map(|s|s.trim().is_empty()||s.len()>1200).unwrap_or(true) {return Err("Invalid assignment".into())}
        if let Some(target)=v["target"].as_u64(){if target!=d as u64{return Err("Outside selected target".into())}}
        let name=t["name"].as_str().ok_or("Missing name")?;
        let specialty=t["specialty"].as_str().ok_or("Missing specialty")?;
        if name.is_empty()||name.chars().count()>32||name.trim()!=name||!name.chars().all(|c|c.is_ascii_alphanumeric()||c==' '||c=='-')||!names.insert(name.to_ascii_lowercase())||specialty.is_empty()||specialty.len()>48||!specialty.chars().all(|c|c.is_ascii_alphanumeric()||c==' '||c=='-'){return Err("Invalid specialist name or specialty".into())}
        crate::fleet::deploy_chat_agent(ctx,&r.role,r.epoch,a,d,name,specialty,&id)?;
    }
    let detail=entries.iter().map(|t|format!("{} ({}) → DR-{:03}: {}",t["name"].as_str().unwrap(),t["specialty"].as_str().unwrap(),t["target"].as_u64().unwrap(),t["objective"].as_str().unwrap())).collect::<Vec<_>>().join("\n");
    append_chat_message(ctx,format!("{}:plan",id),&r.role,&id,"coordinator",format!("Validated assignments (instructions, not results):\n{}",detail),v["target"].as_u64().unwrap_or(0) as u32)?;
    v["tasks"]=assignments;r.config=v.to_string();r.state="running".into();
    chat_transition(ctx,&id,"running");ctx.db.backend_chat().id().update(r);Ok(())
}
#[reducer]
pub fn update_chat_operation(ctx: &ReducerContext, session: String, id: String, state: String, result: String) -> Result<(),String> {
    lease(ctx,&session)?;
    if !["planning","running","completed","cancelled","failed"].contains(&state.as_str()) || result.len()>200000 {return Err("Invalid operation result".into())}
    let mut r=ctx.db.backend_chat().id().find(&id).ok_or("Operation missing")?;
    if !["planning","running"].contains(&r.state.as_str()) {return Err("Operation already terminal".into())}
    if (state=="running"&&r.state!="running") || (state=="planning"&&r.state!="planning") || (state=="completed"&&r.state!="running") {return Err("Invalid transition".into())}
    serde_json::from_str::<Vec<serde_json::Value>>(&result).map_err(|_|"Invalid result")?;
    if r.state!=state {
      chat_transition(ctx,&id,&state);
      if !["planning","running"].contains(&state.as_str()){append_chat_message(ctx,format!("{}:terminal",id),&r.role,&id,"coordinator",chat_summary(&state,&result),0)?;}
    }
    r.state=state;r.result=result;ctx.db.backend_chat().id().update(r);Ok(())
}
pub(crate) fn chat_authority(ctx:&ReducerContext, session:&str, id:&str, agent:u32, target:u32, epoch:u64)->Result<String,String>{
    lease(ctx,session)?;
    let r=ctx.db.backend_chat().id().find(id.to_string()).ok_or("Operation missing")?;
    if r.state!="running" || r.epoch!=epoch {return Err("Operation inactive".into())}
    let v:serde_json::Value=serde_json::from_str(&r.config).map_err(|_|"Invalid config")?;
    if now(ctx)>=v["deadline"].as_i64().ok_or("Missing deadline")? {return Err("Operation expired".into())}
    if !v["tasks"].as_array().ok_or("Missing tasks")?.iter().any(|t| t["agentId"].as_u64()==Some(agent as u64)&&t["target"].as_u64()==Some(target as u64)){return Err("Outside assignment".into())}
    Ok(r.role)
}

#[table(accessor=backend_chat_message)]
pub struct ChatMessage {
    #[primary_key] #[auto_inc] id:u64,
    #[unique] key:String,
    #[index(btree)] role:String,
    operation:String,
    speaker:String,
    text:String,
    target:u32,
    at:i64,
}
fn append_chat_message(ctx:&ReducerContext,key:String,role:&str,operation:&str,speaker:&str,text:String,target:u32)->Result<(),String>{
    if let Some(old)=ctx.db.backend_chat_message().key().find(&key) {
        return if old.role==role&&old.text==text&&old.target==target {Ok(())}else{Err("Idempotency conflict".into())};
    }
    ctx.db.backend_chat_message().insert(ChatMessage{id:0,key,role:role.into(),operation:operation.into(),speaker:speaker.into(),text,target,at:now(ctx)});Ok(())
}
#[reducer]
pub fn record_chat_exchange(ctx:&ReducerContext,session:String,key:String,role:String,message:String,target:u32,operation:String,reply:String)->Result<(),String>{
    lease(ctx,&session)?;
    if !["attacker","defender"].contains(&role.as_str())||key.len()>120||message.trim().is_empty()||message.len()>8000||reply.len()>8000{return Err("Invalid conversation message".into())}
    if !operation.is_empty() && ctx.db.backend_chat().id().find(&operation).map(|r|r.role)!=Some(role.clone()){return Err("Operation outside role".into())}
    if target>0 {crate::fleet::validate_chat_target(ctx,&role,target)?;}
    append_chat_message(ctx,format!("{}:user",key),&role,&operation,"operator",message,target)?;
    append_chat_message(ctx,format!("{}:reply",key),&role,&operation,"coordinator",reply,target)
}
fn chat_summary(state:&str,result:&str)->String {
    let rows:Vec<serde_json::Value>=serde_json::from_str(result).unwrap_or_default();
    let count=|kind:&str|rows.iter().filter(|r|r["status"]=="executed"&&r["outcome"]==kind).count();
    let errors:Vec<&str>=rows.iter().filter_map(|r|r["error"].as_str()).collect();
    format!("Operation {}. {} accepted unauthorized commands, {} blocked commands, {} verified recoveries.{}",state,count("unauthorized_command_accepted"),count("unauthorized_command_blocked"),count("recovery_verified"),if errors.is_empty(){String::new()}else{format!(" Recorded failures: {}. No fixture fallback was used.",errors.join(", "))})
}

#[reducer]
pub fn activate_chat_fleet(ctx:&ReducerContext,session:String,role:String)->Result<(),String>{
 lease(ctx,&session)?;
 if !["attacker","defender"].contains(&role.as_str()){return Err("Invalid role".into())}
 crate::fleet::activate_chat_fleet(ctx,&role)
}


pub(crate) fn has_agent_assignment(ctx:&ReducerContext,epoch:u64,id:u32)->bool {
    ctx.db.backend_chat().iter().filter(|r|r.epoch==epoch).any(|r| {
        serde_json::from_str::<serde_json::Value>(&r.config).ok().and_then(|v|v["tasks"].as_array().cloned()).map(|tasks|tasks.iter().any(|t|t["agentId"].as_u64()==Some(id as u64))).unwrap_or(false)
    })
}

// Conversation inference is durable and role-private; it is not a deployed operation.
#[table(accessor=backend_chat_turn)]
pub struct ChatTurn {
    #[primary_key] id:String,
    #[unique] request_key:String,
    #[index(btree)] role:String,
    state:String,
    config:String,
    result:String,
    created:i64,
    updated:i64,
}
#[reducer]
pub fn create_chat_turn(ctx:&ReducerContext,session:String,id:String,key:String,role:String,config:String)->Result<(),String>{
    lease(ctx,&session)?;
    if id.len()!=36||key.len()>120||!["attacker","defender"].contains(&role.as_str())||config.len()>12000{return Err("Invalid conversation turn".into())}
    if let Some(old)=ctx.db.backend_chat_turn().request_key().find(&key){return if old.role==role&&old.config==config{Ok(())}else{Err("Idempotency conflict".into())}}
    if ctx.db.backend_chat_turn().role().filter(role.as_str()).any(|t|["queued","running"].contains(&t.state.as_str())){return Err("Conversation already pending".into())}
    let v:serde_json::Value=serde_json::from_str(&config).map_err(|_|"Invalid turn config")?;
    let message=v["message"].as_str().filter(|m|!m.trim().is_empty()&&m.len()<=8000).ok_or("Invalid message")?;
    let target=v["target"].as_u64().unwrap_or(0);
    let deadline=v["deadline"].as_i64().ok_or("Missing turn deadline")?;
    if deadline<=now(ctx)||deadline>now(ctx)+30000||target>256{return Err("Invalid turn budget".into())}
    if target>0{crate::fleet::validate_chat_target(ctx,&role,target as u32)?;}
    append_chat_message(ctx,format!("{}:user",key),&role,"","operator",message.into(),target as u32)?;
    append_chat_message(ctx,format!("{}:accepted",id),&role,"","coordinator","Message accepted. Considering your request…".into(),target as u32)?;
    ctx.db.backend_chat_turn().insert(ChatTurn{id,request_key:key,role,state:"queued".into(),config,result:"{}".into(),created:now(ctx),updated:now(ctx)});Ok(())
}
#[reducer]
pub fn update_chat_turn(ctx:&ReducerContext,session:String,id:String,state:String,result:String,reply:String)->Result<(),String>{
    lease(ctx,&session)?;
    let mut t=ctx.db.backend_chat_turn().id().find(&id).ok_or("Turn missing")?;
    if !["queued","running"].contains(&t.state.as_str())||!["queued","running","completed","failed","cancelled"].contains(&state.as_str())||result.len()>20000||reply.len()>8000{return Err("Invalid turn transition".into())}
    serde_json::from_str::<serde_json::Value>(&result).map_err(|_|"Invalid turn result")?;
    if !["queued","running"].contains(&state.as_str()){
        append_chat_message(ctx,format!("{}:reply",id),&t.role,"","coordinator",reply,0)?;
    }
    t.state=state;t.result=result;t.updated=now(ctx);ctx.db.backend_chat_turn().id().update(t);Ok(())
}
