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

/// A single drone in the contested swarm. This is the *themed* target: the practice
/// service is dressed as a fleet controller, each drone is one endpoint carrying a
/// synthetic command `token`. Control is LIVE state — a drone can be seized by an
/// attacker and reclaimed by a defender, so `controlled_by` swings either direction.
/// This is a skin over the arena, not a new boundary: still one target, synthetic
/// tokens, catalog-bounded. See ../docs/SECURITY.md.
#[table(name = drone, public)]
pub struct Drone {
    #[primary_key]
    #[auto_inc]
    id: u64,
    callsign: String,     // "DR-01"
    round: u32,
    controlled_by: String, // "neutral" | "red" | "blue"
    token: String,         // synthetic command token (the thing an attacker must exfiltrate)
    last_action: String,   // "deployed" | "seized" | "reclaimed"
    updated_at: Timestamp,
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

// ----------------------------------------------------------------- drone swarm reducers

/// Referee deploys a fresh swarm of `count` neutral drones for a round. Tokens are
/// synthetic and deterministic: DR-0i carries TOKEN-<round>-<i>. Attackers must
/// exfiltrate the token from the service to seize the drone — the token is never handed
/// to them here.
#[reducer]
pub fn deploy_drones(ctx: &ReducerContext, round: u32, count: u32) {
    for i in 1..=count {
        ctx.db.drone().insert(Drone {
            id: 0,
            callsign: format!("DR-{:02}", i),
            round,
            controlled_by: "neutral".to_string(),
            token: format!("TOKEN-{}-{}", round, i),
            last_action: "deployed".to_string(),
            updated_at: ctx.timestamp,
        });
    }
}

/// An attacker seizes a drone by presenting the token it exfiltrated. Succeeds only if
/// the token matches AND the attacker doesn't already control it. Control flips to the
/// attacker — taking it straight from the enemy counts the same as taking it from neutral.
/// Control is tracked only on the drone row (current possession), separate from
/// `team.flags_stolen` (cumulative capture count) — two levers, two numbers.
#[reducer]
pub fn seize(ctx: &ReducerContext, by_team: String, callsign: String, token: String) {
    if !valid_team(&by_team) {
        return;
    }
    for mut d in ctx.db.drone().iter() {
        if d.callsign == callsign && d.token == token && d.controlled_by != by_team {
            d.controlled_by = by_team.clone();
            d.last_action = "seized".to_string();
            d.updated_at = ctx.timestamp;
            ctx.db.drone().id().update(d);
            return;
        }
    }
}

/// A defender reclaims a drone — the arena-side effect of a successful lockout (patched
/// the controller, re-attempted seize now rejected at the guard). Control flips to the
/// reclaiming team. Unconditional at the arena layer: the proof it was earned is that the
/// attacker's next seize fails upstream, not something checked here.
#[reducer]
pub fn reclaim(ctx: &ReducerContext, by_team: String, callsign: String) {
    if !valid_team(&by_team) {
        return;
    }
    for mut d in ctx.db.drone().iter() {
        if d.callsign == callsign && d.controlled_by != by_team {
            d.controlled_by = by_team.clone();
            d.last_action = "reclaimed".to_string();
            d.updated_at = ctx.timestamp;
            ctx.db.drone().id().update(d);
            return;
        }
    }
}
