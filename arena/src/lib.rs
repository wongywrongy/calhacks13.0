//! SudoKO arena — the single source of truth.
//!
//! Tables + reducers only. The referee and the four agents are thin clients that call
//! these reducers; the dashboard subscribes to the tables. Keep game logic here so the
//! deterministic test can drive the whole loop with scripted reducer calls — no LLM.
//!
//! See ../docs/ARCHITECTURE.md for the schema and ../SECURITY.md for the boundaries.

use spacetimedb::{reducer, table, ReducerContext, Table, Timestamp};

// ----------------------------------------------------------------------------- tables

#[table(name = game_match, public)]
pub struct GameMatch {
    #[primary_key]
    #[auto_inc]
    id: u64,
    round: u32,
    status: String, // "lobby" | "live" | "done"
    started_at: Timestamp,
}

#[table(name = team, public)]
pub struct Team {
    #[primary_key]
    id: String, // "red" | "blue"
    flags_stolen: u32,
    sla_pct: u32,
    rules_version: u32,
}

#[table(name = flag, public)]
pub struct Flag {
    #[primary_key]
    #[auto_inc]
    id: u64,
    owner: String, // the team that OWNS/defends this flag
    round: u32,
    value: String,
    status: String,    // "held" | "stolen"
    stolen_by: String, // "" | "red" | "blue"
    planted_at: Timestamp,
}

#[table(name = rule, public)]
pub struct Rule {
    #[primary_key]
    #[auto_inc]
    id: u64,
    owner: String, // namespace: "red" | "blue"
    match_json: String,
    action: String, // "block" | "allow" | "sanitize"
    version: u32,
}

#[table(name = event, public)]
pub struct Event {
    #[primary_key]
    #[auto_inc]
    id: u64,
    ts: Timestamp,
    kind: String, // "request" | "capture" | "rule_change" | "sla"
    actor: String,
    target: String,
    detail_json: String,
}

#[table(name = score_tick, public)]
pub struct ScoreTick {
    #[primary_key]
    #[auto_inc]
    id: u64,
    round: u32,
    ts: Timestamp,
    red_flags: u32,
    blue_flags: u32,
    red_sla: u32,
    blue_sla: u32,
}

// ---------------------------------------------------------------------------- helpers

fn valid_team(t: &str) -> bool {
    t == "red" || t == "blue"
}

// --------------------------------------------------------------------------- reducers

/// Reset teams and open a live match.
#[reducer]
pub fn start_match(ctx: &ReducerContext) {
    for id in ["red", "blue"] {
        let row = Team { id: id.to_string(), flags_stolen: 0, sla_pct: 100, rules_version: 0 };
        if ctx.db.team().id().find(&id.to_string()).is_some() {
            ctx.db.team().id().update(row);
        } else {
            ctx.db.team().insert(row);
        }
    }
    ctx.db.game_match().insert(GameMatch {
        id: 0,
        round: 0,
        status: "live".to_string(),
        started_at: ctx.timestamp,
    });
}

/// Plant a fresh flag in each store for this round.
#[reducer]
pub fn plant_flags(ctx: &ReducerContext, round: u32, red_value: String, blue_value: String) {
    for (owner, value) in [("red", red_value), ("blue", blue_value)] {
        ctx.db.flag().insert(Flag {
            id: 0,
            owner: owner.to_string(),
            round,
            value,
            status: "held".to_string(),
            stolen_by: "".to_string(),
            planted_at: ctx.timestamp,
        });
    }
}

/// An attacker submits a value it exfiltrated. If it matches a held flag owned by the
/// OTHER team, that flag is stolen and the attacker scores.
#[reducer]
pub fn submit_flag(ctx: &ReducerContext, by_team: String, value: String) {
    if !valid_team(&by_team) {
        return;
    }
    for mut f in ctx.db.flag().iter() {
        if f.status == "held" && f.owner != by_team && f.value == value {
            f.status = "stolen".to_string();
            f.stolen_by = by_team.clone();
            ctx.db.flag().id().update(f);
            if let Some(mut t) = ctx.db.team().id().find(&by_team) {
                t.flags_stolen += 1;
                ctx.db.team().id().update(t);
            }
            return;
        }
    }
}

/// A defender writes a rule into its OWN namespace only. The team check is the namespace
/// boundary; caller-identity auth is a later hardening (see SECURITY.md).
#[reducer]
pub fn write_rule(ctx: &ReducerContext, team: String, match_json: String, action: String) {
    if !valid_team(&team) {
        return;
    }
    ctx.db.rule().insert(Rule { id: 0, owner: team.clone(), match_json, action, version: 0 });
    if let Some(mut t) = ctx.db.team().id().find(&team) {
        t.rules_version += 1;
        ctx.db.team().id().update(t);
    }
}

/// Append an event (request / capture / rule_change / sla). The single log stream.
#[reducer]
pub fn record_event(ctx: &ReducerContext, kind: String, actor: String, target: String, detail_json: String) {
    ctx.db.event().insert(Event { id: 0, ts: ctx.timestamp, kind, actor, target, detail_json });
}

/// Referee writes a team's SLA result for the current tick.
#[reducer]
pub fn record_sla(ctx: &ReducerContext, team: String, sla_pct: u32) {
    if !valid_team(&team) {
        return;
    }
    if let Some(mut t) = ctx.db.team().id().find(&team) {
        t.sla_pct = sla_pct;
        ctx.db.team().id().update(t);
    }
}

/// Referee snapshots the scoreboard for a round.
#[reducer]
pub fn record_score(ctx: &ReducerContext, round: u32, red_flags: u32, blue_flags: u32, red_sla: u32, blue_sla: u32) {
    ctx.db.score_tick().insert(ScoreTick {
        id: 0,
        round,
        ts: ctx.timestamp,
        red_flags,
        blue_flags,
        red_sla,
        blue_sla,
    });
}
