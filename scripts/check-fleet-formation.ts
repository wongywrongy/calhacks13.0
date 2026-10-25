import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium, type Page } from "@playwright/test";
import { FLEET } from "../shared/fleet.ts";

// Exercise actual reducer snapshots, not a front-end invented fleet. Run test:fleet first.
const recording = await readFile("output/fleet/formation.json", "utf8");
const output = "output/fleet-formation";
await mkdir(output, { recursive: true });
await mkdir("docs/screenshots", { recursive: true });
const instrumentation = `
const drawSamples = [];
const originalDraw = draw;
draw = () => { const start = performance.now(); originalDraw(); drawSamples.push(performance.now()-start); if(drawSamples.length>2000)drawSamples.shift(); };
Object.assign(globalThis, {formationCheck: () => ({
  resetCheck: () => { const saved = frame; render({...EMPTY, epoch: fleetEpoch + 1}); fit(true); const empty = pad.scale.toArray(); render({...saved, epoch: fleetEpoch}); fit(true); return {empty, restored: pad.scale.toArray()}; },
  role, count: frame.drones.length, webgl: !!renderer, pad: {size: pad.scale.toArray(), center: pad.position.toArray()},
  positions: frame.drones.map(d=>[d.id,...shown(d).toArray()]), rawPositions: frame.drones.map(d=>[d.id,d.x,d.y,d.z]), points: frame.drones.map(d=>screen(d)),
  ground: [[-1,-1],[-1,1],[1,-1],[1,1]].map(([x,z]) => new THREE.Vector3(x*pad.scale.x/2,0,z*pad.scale.z/2).project(camera).toArray()),
  instances: [...batches.values()].reduce((n,b)=>n+b.body.count,0), calls: renderer?.info.render.calls,
  triangles: renderer?.info.render.triangles, pixelRatio: renderer?.getPixelRatio(), drawSamples: [...drawSamples],
  landscape: duskBackdrop?.userData.state, camera: camera.position.toArray(), target: controls.target.toArray(),
})});`;
const bundle = await build({ stdin: { contents: await readFile("web/fleet.ts", "utf8") + instrumentation, resolveDir: process.cwd() + "/web", loader: "ts" }, bundle: true, format: "esm", write: false });
const files: Record<string, [string, string]> = {
  "/": ["web/fleet.html", "text/html"], "/theme.css": ["web/theme.css", "text/css"],
  "/assets/swarm-blockout.glb": ["web/assets/swarm-blockout.glb", "model/gltf-binary"],
  "/assets/environments/sudoko-dusk-basin.webp": ["web/assets/environments/sudoko-dusk-basin.webp", "image/webp"],
};
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/fleet-config") { res.setHeader("content-type", "application/json"); res.end('{"recorded":true}'); }
    else if (path === "/fleet-recording.json") { res.setHeader("content-type", "application/json"); res.end(recording); }
    else if (path === "/fleet.js") { res.setHeader("content-type", "text/javascript"); res.end(bundle.outputFiles[0].text); }
    else if (files[path]) { res.setHeader("content-type", files[path][1]); res.end(await readFile(files[path][0])); }
    else { res.writeHead(404); res.end(); }
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox", "--enable-unsafe-swiftshader"] });
const report: any = { renderer: "Headless Chromium / SwiftShader on Linux; not a MacBook Air GPU benchmark", checks: [], errors: [] };
const state = (page: Page) => page.evaluate(() => (globalThis as any).formationCheck());
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await context.addInitScript(() => sessionStorage.setItem("sudoko.role", "defender"));
  const page = await context.newPage();
  page.on("pageerror", e => report.errors.push(e.message));
  await page.goto(`http://127.0.0.1:${(server.address() as any).port}`);
  await page.waitForFunction(count => (globalThis as any).formationCheck?.().instances === count, FLEET.drones);
  await page.waitForFunction(() => (globalThis as any).formationCheck().landscape === "ready");
  for (const name of ["fit", "top-down"]) {
    if (name === "top-down") await page.locator("#camera").click();
    await page.locator("#reframe").click();
    await page.waitForTimeout(300);
    const current = await state(page);
    assert.equal(current.webgl, true); assert.equal(current.count, FLEET.drones); assert.equal(current.instances, FLEET.drones);
    assert.equal(current.pad.size[0], current.pad.size[2]);
    assert.equal(current.pad.center[0], 0); assert.equal(current.pad.center[2], 0);
    for (const p of current.ground) assert.ok(Math.abs(p[0]) < 1 && Math.abs(p[1]) < 1 && p[2] < 1, "Fit keeps the whole square pad in view");
    assert.match(await page.locator("#context").innerText(), new RegExp(`${FLEET.drones} drones`));
    assert.match(await page.locator("#poss-bar").getAttribute("aria-label") ?? "", new RegExp(`blue holds ${FLEET.drones} of ${FLEET.drones}`));
    await page.screenshot({ path: `docs/screenshots/fleet-${FLEET.drones}-${name}.png` });
    report[name] = current;
  }
  report.checks.push("Defend at 1440x900: centered flock waves, full instanced fleet and scoped counts in Fit and Top-down");
  const before = (await state(page)).rawPositions;
  await page.reload();
  await page.waitForFunction(count => (globalThis as any).formationCheck?.().instances === count, FLEET.drones);
  assert.deepEqual((await state(page)).rawPositions, before, "Replaying the same recorded snapshot preserves authoritative positions while decorative waves continue");
  await page.locator('nav [data-role="attacker"]').click();
  await page.waitForFunction(() => document.body.dataset.role === "attacker");
  assert.equal((await state(page)).count, 0);
  assert.match(await page.locator("#context").innerText(), /Fleet size unknown/);
  assert.ok(!(await page.locator("#context").innerText()).includes(String(FLEET.drones)));
  await page.locator('nav [data-role="defender"]').click();
  await page.waitForFunction(count => (globalThis as any).formationCheck().count === count, FLEET.drones);
  report.checks.push("Replay reload and role switch keep slots stable; Attack sees no undiscovered drones or fleet total");
  const resetSizes = await page.evaluate(() => (globalThis as any).formationCheck().resetCheck());
  report.resetSizes = resetSizes;
  assert.deepEqual(resetSizes.empty, resetSizes.restored, "Reset's empty subscription frame must not resize the operating pad");
  report.checks.push("Reset epoch and empty subscription frame preserve operating pad size");
  // Measure after other checks and with all drones visible; never reduce the scene's count.
  report.performance = await page.evaluate(async () => {
    const intervals: number[] = []; let last = performance.now(), start = last;
    await new Promise<void>(done => {
      const step = (now: number) => { intervals.push(now-last); last=now; if(now-start>=6000)done();else requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });
    const elapsed = performance.now()-start;
    intervals.sort((a,b)=>a-b);
    return { frames: intervals.length, elapsedMs: elapsed, fps: intervals.length*1000/elapsed, p95FrameMs: intervals[Math.floor(intervals.length*0.95)] };
  });
  const final = await state(page);
  assert.equal(final.instances, FLEET.drones); assert.ok(final.calls < 40, "Draw calls stay batched, not per drone");
  const samples: number[] = final.drawSamples.sort((a:number,b:number)=>a-b);
  report.performance.drawCalls=final.calls; report.performance.triangles=final.triangles; report.performance.pixelRatio=final.pixelRatio;
  report.performance.p95DrawSubmissionMs=samples[Math.floor(samples.length*0.95)];
  assert.deepEqual(report.errors, []);
  report.passed = true;
} finally {
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
  await browser.close(); await new Promise<void>(resolve => server.close(() => resolve()));
}
console.log(JSON.stringify({passed:report.passed,checks:report.checks,performance:report.performance}));
