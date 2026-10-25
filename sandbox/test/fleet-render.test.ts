import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { droneGeometry, FleetLines, ViewportResolution } from "../../web/fleet-render.ts";

test("merged drone keeps every part's world position and normals without modifying the source", () => {
  const model = new THREE.Group();
  model.rotation.y = 0.4;
  model.scale.setScalar(1.2);
  const part = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 3));
  part.position.set(3, 2, 1);
  const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.1, 12));
  rotor.position.set(-2, 0.5, 2);
  model.add(part, rotor);
  model.updateMatrixWorld(true);
  const original = Array.from(part.geometry.attributes.position.array);
  const expected = part.geometry.toNonIndexed().applyMatrix4(part.matrixWorld);
  const expectedRotor = rotor.geometry.toNonIndexed().applyMatrix4(rotor.matrixWorld);
  const merged = droneGeometry(model);
  assert.deepEqual(Array.from(merged.attributes.position.array), [...expected.attributes.position.array, ...expectedRotor.attributes.position.array]);
  assert.deepEqual(Array.from(merged.attributes.normal.array), [...expected.attributes.normal.array, ...expectedRotor.attributes.normal.array]);
  assert.deepEqual(Array.from(part.geometry.attributes.position.array), original);
  assert.equal(merged.index, null);
  merged.dispose(); expected.dispose(); expectedRotor.dispose(); part.geometry.dispose(); rotor.geometry.dispose();
});

test("fleet lines reuse buffers, hide old segments, and grow storage only when needed", () => {
  const lines = new FleetLines(), color = new THREE.Color(0xff0000);
  lines.begin(4);
  lines.segment(1, 2, 3, 4, 5, 6, color, 0.2, 0.4);
  lines.end();
  const geometry = lines.geometry, positions = geometry.attributes.position as THREE.BufferAttribute;
  assert.equal(geometry.drawRange.count, 2);
  assert.equal(positions.usage, THREE.DynamicDrawUsage);
  assert.deepEqual(Array.from(positions.array).slice(0, 6), [1, 2, 3, 4, 5, 6]);
  assert.ok(Math.abs(geometry.attributes.color.getW(1) - 0.4) < 1e-6);
  lines.begin(2); lines.end();
  assert.equal(lines.geometry, geometry);
  assert.equal(lines.geometry.attributes.position, positions);
  assert.equal(lines.geometry.drawRange.count, 0);
  assert.equal(lines.visible, false);
  let disposed = false;
  geometry.addEventListener("dispose", () => { disposed = true; });
  lines.begin(256);
  lines.segment(0, 0, 0, 1, 1, 1, color, 1); lines.end();
  assert.equal(disposed, true);
  assert.equal(lines.geometry.attributes.position.count, 256);
  assert.equal(lines.geometry.drawRange.count, 2);
  assert.equal(lines.visible, true);
  lines.geometry.dispose(); lines.material.dispose();
});

test("resolution caps high DPR, degrades under sustained load and recovers slowly", () => {
  const quality = new ViewportResolution(3);
  assert.equal(quality.ratio, 1.5);
  for (let i = 0; i < 20; i++) quality.sample(33);
  assert.equal(quality.ratio, 1.5, "brief spikes do not lower quality");
  quality.sample(5000);
  for (let i = 0; i < 500; i++) quality.sample(33);
  assert.equal(quality.ratio, 0.75);
  for (let i = 0; i < 120; i++) quality.sample(16);
  assert.equal(quality.ratio, 0.75, "recovery needs several fast windows");
  for (let i = 0; i < 1500; i++) quality.sample(16);
  assert.equal(quality.ratio, 1.5);
  const slow = new ViewportResolution(2);
  for (let i = 0; i < 8; i++) slow.sample(300);
  assert.equal(slow.ratio, 1.25, "very slow visible frames still degrade");
  const low = new ViewportResolution(0.5);
  for (let i = 0; i < 500; i++) low.sample(33);
  assert.equal(low.ratio, 0.5, "never supersample a low DPR device");
});

test("dusk basin stays flat around the operating area and rises deterministically outside it", async () => {
  const {basinHeight}=await import("../../web/fleet-render.ts");
  for(const [cx,cz,hx,hz] of [[45,10,60,30],[50,50,70,80]]) {
    for(const [x,z] of [[cx,cz],[cx-hx,cz-hz],[cx+hx,cz+hz],[cx+hx+20,cz]])assert.equal(basinHeight(x,z,cx,cz,hx,hz),-0.4);
    const ridge=basinHeight(cx+600,cz-500,cx,cz,hx,hz);
    assert.ok(Number.isFinite(ridge)&&ridge>30&&ridge<240);
    assert.equal(basinHeight(cx+600,cz-500,cx,cz,hx,hz),ridge);
  }
});
test("decorative outposts use one bounded shared geometry with finite normals", async () => {
  const {outpostGeometry}=await import("../../web/fleet-render.ts");
  const geometry=outpostGeometry();geometry.computeBoundingBox();
  assert.ok(geometry.attributes.position.count<300);assert.ok(geometry.boundingBox!.min.y>=-1e-6);assert.ok(geometry.boundingBox!.max.y<=14);
  assert.ok(Array.from(geometry.attributes.normal.array).every(Number.isFinite));geometry.dispose();
});
