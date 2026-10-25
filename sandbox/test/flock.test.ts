import assert from "node:assert/strict";
import { test } from "node:test";
import { display, FlockClock, linkFade, neighbours } from "../../web/flock.ts";
import { FLEET, ROWS, ROW_SPACING, slot } from "../../shared/fleet.ts";

test("rendering preserves authoritative positions at every clock and compromise state", () => {
  for (const t of [undefined, 0, 7, 120]) for (const sync of [0, 0.5, 1]) {
    const p = display([30, 7, 12], 7, t, sync);
    assert.deepEqual([p.x, p.y, p.z], [30, 7, 12]);
    if (t === undefined || sync === 1) assert.equal(p.roll + p.pitch + p.yaw, 0);
  }
});
test("default slots are unique, even and centered across a square", () => {
  const slots = Array.from({length:FLEET.drones},(_,i)=>slot(i+1));
  assert.equal(new Set(slots.map(p=>p.join())).size, FLEET.drones);
  assert.equal(ROWS * FLEET.columns, FLEET.drones);
  for (const axis of [0, 1]) assert.ok(Math.abs(slots.reduce((sum,p)=>sum+p[axis],0))<1e-6);
  assert.ok(Math.abs(slots.at(-1)![0]-slots[0][0]-(slots.at(-1)![1]-slots[0][1]))<1e-6);
  for(let id=1;id<=FLEET.drones;id++) {
    if(id%FLEET.columns) assert.ok(Math.abs(slot(id+1)[0]-slot(id)[0]-FLEET.spacing)<1e-6);
    if(id+FLEET.columns<=FLEET.drones) assert.ok(Math.abs(slot(id+FLEET.columns)[1]-slot(id)[1]-ROW_SPACING)<1e-6);
  }
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
  const ids = new Set(Array.from({ length: FLEET.drones }, (_, i) => i + 1));
  assert.deepEqual(neighbours(FLEET.columns, ids), [2 * FLEET.columns]);
  assert.deepEqual(neighbours(1, ids), [2, FLEET.columns + 1, FLEET.columns + 2]);
  assert.equal(linkFade(1), 1);
  assert.equal(linkFade(1.75), 0);
});
