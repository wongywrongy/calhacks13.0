// Display-only flock layer for the fleet viewport.
//
// Database positions are never changed here. The viewport maps them through two
// deterministic display transforms so the swarm reads as a flock instead of a parade grid:
//   warp  - bends the 16-column slot grid into a swept, tapered wing (static shape);
//   flow  - turns, banks and ripples that start at the leading edge and roll back through
//           the flock, starling-style (animated, off under prefers-reduced-motion).
// Every drone, its ghost slot and its tether pass through the same transforms, so measured
// deviation from the formation keeps its meaning. Only a drone the database reports as
// compromised leaves the shared flow clock: it stops turning with the flock, lags in phase
// and wobbles, which is what "falls out of sync" looks like. Recovered drones catch back up.
import * as THREE from "three";

const COLS = 16,
  DX = 6,
  DZ = 7,
  TAU = Math.PI * 2;
/** Max flock yaw (rad). Kept small so the flock stays inside the fitted frame. */
export const YAW_MAX = 0.12;

export type Grid = { rows: number; offX: number; offZ: number };
export type Attitude = { yaw: number; roll: number; pitch: number };
/** Normalised position inside the flock: u across the span, v front (-1) to back (+1). */
export type UV = { u: number; v: number };

const halfSpan = () => ((COLS - 1) * DX) / 2;
const halfDepth = (g: Grid) => Math.max(((g.rows - 1) * DZ) / 2, 3.5);
const sweepOf = () => 0.3 * halfSpan();
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Static warp of a three-space position (x, altitude, z): the slot grid becomes an
 * S-curved crescent that thins toward the tips, with tips riding higher.
 */
export function warp(g: Grid, x: number, y: number, z: number, out: THREE.Vector3, uv?: UV) {
  const hx = halfSpan(),
    hz = halfDepth(g);
  const lx = x - g.offX - hx,
    lz = z - g.offZ - hz;
  // Clamp so a drone that drifts past the tip is not flung by the quadratic terms.
  const u = clamp(lx / hx, -1.25, 1.25),
    u2 = Math.min(1, u * u);
  if (uv) {
    uv.u = u;
    uv.v = clamp(lz / hz, -1.3, 1.3);
  }
  return out.set(
    g.offX + hx + lx,
    y + 3 * u2,
    g.offZ + hz + lz * (0.58 + 0.42 * (1 - u2)) + sweepOf() * u * u + 0.22 * hx * Math.sin(1.4 * u),
  );
}

/** Centre the flow turns about: middle of the warped flock. */
export function centre(g: Grid, out: THREE.Vector3) {
  return out.set(g.offX + halfSpan(), 0, g.offZ + halfDepth(g) + sweepOf() * 0.4);
}

/** Margin the camera fit needs around the warped flock for its turns, waves and scatter. */
export function margin(out: THREE.Vector3) {
  return out.set(3, 8, halfSpan() * Math.sin(YAW_MAX) + 6);
}

/**
 * Animated flow applied to a warped position. `tau` is the flow clock (s), `a` the
 * amplitude (1 = flying with the flock, 0 = no flow). Writes position and attitude.
 * Two waves travel along the span like a murmuration: a rolling twist of the sheet and a
 * lateral S-wave. Heading changes start at the leading edge and roll back.
 */
export function flow(
  g: Grid,
  c: THREE.Vector3,
  p: THREE.Vector3,
  uv: UV,
  tau: number,
  a: number,
  out: THREE.Vector3,
  att: Attitude,
) {
  const { u, v } = uv;
  const qx = p.x - c.x,
    qz = p.z - c.z;
  const t = tau - 0.8 * clamp(v * 0.5 + 0.5, 0, 1.3) - 0.6 * Math.min(1.25, Math.abs(u));
  const w = TAU / 13;
  const yaw = a * YAW_MAX * Math.sin(w * t);
  const cy = Math.cos(yaw),
    sy = Math.sin(yaw);
  const rx = qx * cy + qz * sy,
    rz = -qx * sy + qz * cy;
  const twist = Math.PI * 1.2 * u - (TAU * tau) / 9,
    snake = Math.PI * u - (TAU * tau) / 7,
    rp = (TAU * tau) / 4.2 - qx / 14 - qz / 11;
  out.set(
    c.x + rx,
    Math.max(1.2, p.y + a * (4.5 * v * Math.sin(twist) + Math.sin(rp))),
    c.z + rz + a * 3.5 * Math.sin(snake),
  );
  att.yaw = yaw + a * 0.25 * Math.cos(snake);
  att.roll = a * 0.32 * Math.cos(twist);
  att.pitch = a * 0.12 * Math.cos(rp);
  return out;
}

/** Stable per-drone phase in [0, 2π). */
export const phase = (id: number, k = 1) => (((id * 0.6180339887 * k) % 1) + 1) % 1 * TAU;

/* ---------- trails and cohesion links: one draw call each ---------- */

export const TRAIL_N = 36; // samples kept per drone
export const TRAIL_DT = 0.055; // s between samples, so a trail is ~2 s of flight

function lineBuffer(segments: number) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(segments * 6), 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(segments * 8), 4).setUsage(THREE.DynamicDrawUsage));
  geo.setDrawRange(0, 0);
  return geo;
}
const lineMat = () =>
  new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false });

/** Grows its buffers on demand; write() fills segments, finish() uploads them. */
export class Segments {
  readonly mesh: THREE.LineSegments;
  private cap = 0;
  private n = 0;
  constructor(initial: number) {
    this.mesh = new THREE.LineSegments(lineBuffer(initial), lineMat());
    this.cap = initial;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }
  begin() {
    this.n = 0;
  }
  private grow() {
    // Keep segments already written this frame.
    const old = this.mesh.geometry;
    this.cap *= 2;
    const next = lineBuffer(this.cap);
    (next.attributes.position.array as Float32Array).set(old.attributes.position.array as Float32Array);
    (next.attributes.color.array as Float32Array).set(old.attributes.color.array as Float32Array);
    old.dispose();
    this.mesh.geometry = next;
  }
  write(ax: number, ay: number, az: number, bx: number, by: number, bz: number, c: THREE.Color, a0: number, a1: number) {
    if (this.n >= this.cap) this.grow();
    const pos = this.mesh.geometry.attributes.position.array as Float32Array,
      col = this.mesh.geometry.attributes.color.array as Float32Array;
    const i = this.n++,
      p = i * 6,
      q = i * 8;
    pos[p] = ax;
    pos[p + 1] = ay;
    pos[p + 2] = az;
    pos[p + 3] = bx;
    pos[p + 4] = by;
    pos[p + 5] = bz;
    col[q] = col[q + 4] = c.r;
    col[q + 1] = col[q + 5] = c.g;
    col[q + 2] = col[q + 6] = c.b;
    col[q + 3] = a0;
    col[q + 7] = a1;
  }
  finish() {
    const g = this.mesh.geometry;
    g.setDrawRange(0, this.n * 2);
    g.attributes.position.needsUpdate = true;
    g.attributes.color.needsUpdate = true;
  }
}

export type Trail = { pts: Float32Array; n: number; head: number };
export const newTrail = (): Trail => ({ pts: new Float32Array(TRAIL_N * 3), n: 0, head: 0 });
export function pushTrail(tr: Trail, p: THREE.Vector3) {
  const j = tr.head * 3;
  tr.pts[j] = p.x;
  tr.pts[j + 1] = p.y;
  tr.pts[j + 2] = p.z;
  tr.head = (tr.head + 1) % TRAIL_N;
  tr.n = Math.min(TRAIL_N, tr.n + 1);
}
/** Newest-to-oldest segments, alpha fading from `alpha` at the drone to 0 at the tail. */
export function drawTrail(s: Segments, tr: Trail, head: THREE.Vector3, c: THREE.Color, alpha: number) {
  let px = head.x,
    py = head.y,
    pz = head.z;
  for (let k = 0; k < tr.n; k++) {
    const j = ((tr.head - 1 - k + TRAIL_N) % TRAIL_N) * 3;
    const x = tr.pts[j],
      y = tr.pts[j + 1],
      z = tr.pts[j + 2];
    s.write(px, py, pz, x, y, z, c, alpha * (1 - k / tr.n), alpha * (1 - (k + 1) / tr.n));
    px = x;
    py = y;
    pz = z;
  }
}
