import assert from "node:assert/strict";
import { test } from "node:test";
import { display, FlockClock, linkFade, neighbours, scatter } from "../../web/flock.ts";

const f = { ox: 0, oy: 0, rows: 3 };
test("flock warp is deterministic and bounded for drifting drones", () => {
  assert.deepEqual(scatter(7), scatter(7));
  assert.deepEqual(display([30, 7, 12], 7, f), display([30, 7, 12], 7, f));
  // 100 m off its slot: span clamp limits the warp; only the rigid heading turn (≤0.12 rad) adds to it.
  const far = display([145, 7, 12], 7, f, 3);
  assert.ok(Math.hypot(far.x - 145, far.y - 7, far.z - 12) < 40);
  const still = display([30, 7, 12], 7, f);
  assert.equal(still.roll + still.pitch + still.yaw, 0);
});
test("compromised clocks fall out of sync and recover", () => {
  const c = new FlockClock(0);
  let now = 0;
  for (let i = 0; i < 100; i++) c.step(0.05, (now += 0.05), true);
  assert.ok(c.sync < 0.01 && c.t < now * 0.5);
  for (let i = 0; i < 400; i++) c.step(0.05, (now += 0.05), false);
  assert.ok(c.sync > 0.99 && c.t === now);
});
test("neighbours and link fade", () => {
  const ids = new Set(Array.from({ length: 48 }, (_, i) => i + 1));
  assert.deepEqual(neighbours(16, ids), [32]);
  assert.deepEqual(neighbours(1, ids), [2, 17, 18]);
  assert.equal(linkFade(1), 1);
  assert.equal(linkFade(1.75), 0);
});
