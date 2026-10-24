//! Sanitized read-only projection. Publish as a NEW database; never deploy the legacy arena.
use spacetimedb::{reducer, table, Identity, ReducerContext, Table, Timestamp};

#[table(accessor = publisher)]
pub struct Publisher { #[primary_key] id: u32, identity: Identity }
#[table(accessor = seen_match)]
pub struct SeenMatch { #[primary_key] id: String }
#[table(accessor = arena_snapshot, public)]
pub struct ArenaSnapshot {
    #[primary_key] slot: u32,
    match_id: String,
    sequence: u64,
    payload: String,
    updated_at: Timestamp,
}
#[reducer(init)]
pub fn init(ctx: &ReducerContext) {
    ctx.db.publisher().insert(Publisher { id: 0, identity: ctx.sender() });
}
#[reducer]
pub fn publish_snapshot(ctx: &ReducerContext, match_id: String, sequence: u64, payload: String) -> Result<(), String> {
    let publisher = ctx.db.publisher().id().find(0).ok_or("Publisher missing")?;
    if ctx.sender() != publisher.identity { return Err("Publisher identity required".into()); }
    if match_id.len() != 36 || payload.len() > 8_000_000 || sequence == 0 { return Err("Invalid envelope".into()); }
    let data: serde_json::Value = serde_json::from_str(&payload).map_err(|_| "Invalid JSON")?;
    if data["id"].as_str() != Some(&match_id) || data["projectionVersion"].as_u64() != Some(1) || !data["events"].is_array() { return Err("Invalid projection".into()); }
    if let Some(old) = ctx.db.arena_snapshot().slot().find(0) {
        if old.match_id == match_id {
            if sequence < old.sequence { return Err("Stale sequence".into()); }
            if sequence == old.sequence {
                return if payload == old.payload { Ok(()) } else { Err("Conflicting duplicate".into()) };
            }
            let previous: serde_json::Value = serde_json::from_str(&old.payload).map_err(|_| "Stored JSON invalid")?;
            if previous["live"] == false && data["live"] == true { return Err("Completed match cannot reopen".into()); }
        } else {
            if ctx.db.seen_match().id().find(&match_id).is_some() { return Err("Stale match".into()); }
            ctx.db.seen_match().insert(SeenMatch { id: match_id.clone() });
        }
        ctx.db.arena_snapshot().slot().update(ArenaSnapshot { slot: 0, match_id, sequence, payload, updated_at: ctx.timestamp });
    } else {
        ctx.db.seen_match().insert(SeenMatch { id: match_id.clone() });
        ctx.db.arena_snapshot().insert(ArenaSnapshot { slot: 0, match_id, sequence, payload, updated_at: ctx.timestamp });
    }
    Ok(())
}

mod fleet;

mod backend;
