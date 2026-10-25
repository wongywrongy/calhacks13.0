// Display database positions faithfully; only compromised model attitude is decorative.
import { FLEET } from "../shared/fleet.ts";
export type Pose = { x: number; y: number; z: number; roll: number; pitch: number; yaw: number };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export function display(p: readonly number[], id: number, t?: number, sync = 1): Pose {
  const w = t === undefined ? 0 : 1 - sync;
  return {
    x: p[0], y: p[1], z: p[2],
    roll: w * 0.9 * Math.sin((t ?? 0) * 3.7 + id),
    pitch: w * 0.6 * Math.sin((t ?? 0) * 2.9 + id * 2),
    yaw: w * (t ?? 0) * 1.5,
  };
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
  const col = (id - 1) % FLEET.columns,
    out: number[] = [];
  for (const [dc, n] of [[1, id + 1], [0, id + FLEET.columns], [1, id + FLEET.columns + 1]] as const)
    if (col + dc < FLEET.columns && ids.has(n)) out.push(n);
  return out;
}

/** Link opacity by stretch (displayed distance over in-step distance): full to 1x, gone past ~1.75x. */
export const linkFade = (stretch: number) => clamp(1 - (stretch - 1) / 0.75, 0, 1);
