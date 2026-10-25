// Display-only warp that bends the shared slot grid into a flock. Database positions are
// never changed: drone, ghost slot and tether all pass through display(), so the distance
// between a drone and its slot keeps its meaning.
import { FLEET, ROW_SPACING } from "../shared/fleet.ts";
const COLS = FLEET.columns;
const HALF_SPAN = ((COLS - 1) * FLEET.spacing) / 2;
/** Formation origin: expected slot minus slot(id), plus the number of rows. */
export type Formation = { ox: number; oy: number; rows: number };
/** Database axes: x = span, y = depth, z = altitude. Angles in radians. */
export type Pose = {
  x: number;
  y: number;
  z: number;
  roll: number;
  pitch: number;
  yaw: number;
};
const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const hash01 = (id: number, salt: number) => {
  let h = (id * 374761393 + salt * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
/** Fixed per-id offset so the swarm does not read as a grid: ±1.2 m span/depth, ±1.8 m altitude. */
export const scatter = (id: number) => [
  (hash01(id, 1) - 0.5) * 2.4,
  (hash01(id, 2) - 0.5) * 2.4,
  (hash01(id, 3) - 0.5) * 3.6,
];

/**
 * Displayed pose of point p = [x, y, z] (database axes) for drone id.
 * t: flow clock in seconds, or undefined for the static shape only. sync: 0 (out of step) .. 1.
 */
export function display(
  p: readonly number[],
  id: number,
  f: Formation,
  t?: number,
  sync = 1,
): Pose {
  const [jx, jy, jz] = scatter(id);
  const lx = p[0] - f.ox,
    ly = p[1] - f.oy,
    depth = Math.max(1, (f.rows - 1) * ROW_SPACING);
  // Normalized span, clamped so a drone far off its slot is not flung.
  const s = clamp(lx / HALF_SPAN, -1.25, 1.25),
    s2 = s * s;
  let x = p[0] + jx;
  // Crescent sweep plus an S term; depth tapers to 58% at the tips.
  let y = f.oy + ly * (1 - 0.42 * Math.min(1, s2)) + HALF_SPAN * (0.3 * s2 - 0.1 * s * s2) + jy;
  let z = p[2] + 3 * s2 + jz;
  let roll = 0,
    pitch = 0,
    yaw = 0;
  if (t !== undefined && sync > 0) {
    const d = clamp((ly / depth) * 2, -1, 1); // -1 leading edge .. 1 trailing edge
    const tw = (TAU * t) / 9 - s * Math.PI,
      lw = (TAU * t) / 7 - s * 1.5 * Math.PI;
    z += sync * (4.5 * d * Math.sin(tw) + 0.35 * Math.sin((TAU * t) / 1.7 + s * 5 + id * 0.9));
    y += sync * 3.5 * Math.sin(lw);
    // Heading turns start at the leading edge and roll back through the rows.
    const hd = sync * 0.12 * Math.sin((TAU * (t - 0.12 * ly)) / 15);
    const cx = f.ox,
      cy = f.oy,
      rx = x - cx,
      ry = y - cy,
      c = Math.cos(hd),
      sn = Math.sin(hd);
    x = cx + rx * c - ry * sn;
    y = cy + rx * sn + ry * c;
    pitch = sync * 0.08 * d * Math.cos(tw);
    roll = sync * 0.35 * Math.cos(lw);
    yaw = hd;
  }
  if (t !== undefined && sync < 1) {
    const w = 1 - sync; // wobble and tumble while out of step
    x += w * 0.7 * Math.sin(t * 5.1 + id);
    y += w * 0.7 * Math.sin(t * 4.3 + id * 2);
    z += w * 0.9 * Math.sin(t * 6.7 + id * 3);
    roll += w * 0.9 * Math.sin(t * 3.7 + id);
    pitch += w * 0.6 * Math.sin(t * 2.9 + id * 2);
    yaw += w * t * 1.5;
  }
  return { x, y, z: Math.max(0.5, z), roll, pitch, yaw };
}

/** Each drone's own flow clock. Compromised drones slow to 0.45x and lose sync; recovered ones catch up. */
export class FlockClock {
  t: number;
  sync = 1;
  constructor(now: number) {
    this.t = now;
  }
  step(dt: number, now: number, compromised: boolean) {
    if (compromised) {
      this.t += dt * 0.45;
      this.sync += (0 - this.sync) * (1 - Math.exp(-dt / 0.7));
    } else {
      this.sync += (1 - this.sync) * (1 - Math.exp(-dt / 2.2));
      this.t = this.t < now ? Math.min(now, this.t + dt * 1.8) : now;
    }
  }
}

/** Slot neighbours to the right, below and diagonally below-right within a cols-wide grid. */
export function neighbours(id: number, ids: Set<number>) {
  const col = (id - 1) % COLS,
    out: number[] = [];
  for (const [dc, n] of [[1, id + 1], [0, id + COLS], [1, id + COLS + 1]] as const)
    if (col + dc < COLS && ids.has(n)) out.push(n);
  return out;
}

/** Link opacity by stretch (displayed distance over in-step distance): full to 1x, gone past ~1.75x. */
export const linkFade = (stretch: number) => clamp(1 - (stretch - 1) / 0.75, 0, 1);
