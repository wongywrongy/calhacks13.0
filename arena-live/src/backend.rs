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
    for mut r in ctx.db.backend_chat().iter().filter(|r|r.state=="running") { r.state="interrupted".into(); ctx.db.backend_chat().id().update(r); }
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
#[reducer]
pub fn create_chat_operation(ctx: &ReducerContext, session: String, id: String, key: String, role: String, epoch: u64, config: String) -> Result<(), String> {
    lease(ctx, &session)?;
    if !["attacker", "defender"].contains(&role.as_str()) || config.len()>16000 || id.len()!=36 || key.len()>120 { return Err("Invalid chat operation".into()); }
    if let Some(old)=ctx.db.backend_chat().request_key().find(&key) {
        return if old.config==config && old.role==role {Ok(())}else{Err("Idempotency conflict".into())};
    }
    if ctx.db.backend_chat().iter().any(|r|r.role==role && r.state=="running") {return Err("Role operation already active".into())}
    ctx.db.backend_chat().insert(ChatOperation{id,request_key:key,role,epoch,state:"running".into(),config,result:"[]".into()}); Ok(())
}
#[reducer]
pub fn update_chat_operation(ctx: &ReducerContext, session: String, id: String, state: String, result: String) -> Result<(),String> {
    lease(ctx,&session)?;
    if !["running","completed","cancelled","failed"].contains(&state.as_str()) || result.len()>200000 {return Err("Invalid operation result".into())}
    let mut r=ctx.db.backend_chat().id().find(&id).ok_or("Operation missing")?;
    if r.state!="running" {return Err("Operation already terminal".into())}
    r.state=state;r.result=result;ctx.db.backend_chat().id().update(r);Ok(())
}
pub(crate) fn chat_authority(ctx:&ReducerContext, session:&str, id:&str, agent:u32, target:u32, epoch:u64)->Result<String,String>{
    lease(ctx,session)?;
    let r=ctx.db.backend_chat().id().find(id.to_string()).ok_or("Operation missing")?;
    if r.state!="running" || r.epoch!=epoch {return Err("Operation inactive".into())}
    let v:serde_json::Value=serde_json::from_str(&r.config).map_err(|_|"Invalid config")?;
    if !v["tasks"].as_array().ok_or("Missing tasks")?.iter().any(|t| t["agentId"].as_u64()==Some(agent as u64)&&t["target"].as_u64()==Some(target as u64)){return Err("Outside assignment".into())}
    Ok(r.role)
}
