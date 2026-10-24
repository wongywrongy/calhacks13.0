//! Fleet motion model. Pure functions so the trajectory is testable without a database.
//!
//! Healthy drones fly one shared formation on the match clock, so the whole swarm moves in
//! lockstep and keeps its 6 m x 7 m spacing. A hijacked drone stops following that clock: it
//! is pulled off its slot, wobbles at its own frequency and sinks, and every effect grows with
//! how long the attacker has held it. Recovery glides it back into step.
use std::f32::consts::TAU;

/// Seconds for one figure-eight sweep of the formation.
pub const PERIOD: f32 = 20.0;
/// Fraction of the remaining gap closed per drone tick (~0.2 s) when off target.
pub const GLIDE: f32 = 0.35;
/// Within this many metres of its formation pose a healthy drone locks onto it exactly.
pub const LOCK: f32 = 0.6;

pub type Pose = (f32, f32, f32);

pub fn slot(id: u32) -> (f32, f32) {
    (((id - 1) % 16) as f32 * 6.0, ((id - 1) / 16) as f32 * 7.0)
}

/// Shared formation pose at match time `t` seconds. The same offset applies to every slot.
pub fn formation(id: u32, t: f32) -> Pose {
    let w = TAU / PERIOD;
    let (sx, sy) = slot(id);
    let col = ((id - 1) % 16) as f32;
    (
        sx + 6.0 * (w * t).sin(),
        sy + 3.0 * (2.0 * w * t).sin(),
        10.0 + 1.5 * (3.0 * w * t - col * 0.45).sin(),
    )
}

/// Stable per-drone value in [0, 1), so each hijacked drone has its own heading and rhythm.
fn unit(id: u32) -> f32 {
    (id.wrapping_mul(2_654_435_761) >> 8) as f32 / (1u32 << 24) as f32
}

/// Pose of a drone taken over at match time `since` and held for `held` seconds.
pub fn hijacked(id: u32, since: f32, held: f32) -> Pose {
    let (bx, by, _) = formation(id, since);
    let h = unit(id);
    let heading = h * TAU;
    let held = held.max(0.0);
    let drift = (1.2 * held).min(18.0);
    let amp = (0.6 + 0.25 * held).min(3.5);
    // Slow enough (0.35-0.6 Hz) to read correctly at the ~3-5 Hz drone tick rate.
    let p = TAU * (0.35 + 0.25 * h) * held;
    (
        bx + heading.cos() * drift + amp * p.sin(),
        by + heading.sin() * drift + amp * (1.7 * p + 1.0).cos(),
        (10.0 - 0.6 * held).max(3.0) + 0.8 * (2.3 * p).sin(),
    )
}

/// One tick of motion from `at` toward `target`.
pub fn step(at: Pose, target: Pose, healthy: bool) -> Pose {
    let d = (target.0 - at.0, target.1 - at.1, target.2 - at.2);
    if healthy && (d.0 * d.0 + d.1 * d.1 + d.2 * d.2).sqrt() < LOCK {
        return target;
    }
    (at.0 + d.0 * GLIDE, at.1 + d.1 * GLIDE, at.2 + d.2 * GLIDE)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn dist(a: Pose, b: Pose) -> f32 {
        ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2) + (a.2 - b.2).powi(2)).sqrt()
    }
    #[test]
    fn healthy_drones_share_one_offset() {
        for t in [0.0, 3.7, 12.0, 59.9] {
            let (ax, ay, _) = formation(1, t);
            let (bx, by, _) = formation(40, t);
            let (s1, s40) = (slot(1), slot(40));
            assert!(((ax - s1.0) - (bx - s40.0)).abs() < 1e-4);
            assert!(((ay - s1.1) - (by - s40.1)).abs() < 1e-4);
        }
    }
    #[test]
    fn hijack_grows_off_formation_over_time() {
        let since = 10.0;
        let off = |held: f32| dist(hijacked(7, since, held), formation(7, since + held));
        assert!(off(1.0) < off(10.0));
        assert!(off(10.0) > 8.0);
        assert!(hijacked(7, since, 30.0).2 <= 4.0);
    }
    #[test]
    fn recovery_glides_back_and_locks() {
        let target = formation(3, 20.0);
        let mut at = hijacked(3, 5.0, 15.0);
        let mut ticks = 0;
        while at != target {
            let next = step(at, target, true);
            assert!(dist(next, at) < 10.0, "no teleport");
            at = next;
            ticks += 1;
            assert!(ticks < 40);
        }
    }
}
