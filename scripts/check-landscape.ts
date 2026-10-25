import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {execFileSync} from "node:child_process";
import {chromium,type Page} from "@playwright/test";
import {build} from "esbuild";
const baseline=process.argv.includes("--baseline");
const output="output/landscape";await mkdir(output,{recursive:true});await mkdir(".impeccable/review",{recursive:true});
const recording=JSON.parse(await readFile(baseline?"output/fleet/recording.json":"output/landscape/fixture.json","utf8"));
// A single measured replay frame keeps fleet, state and camera comparisons repeatable.
const sample=recording.frames.findLast((f:any)=>f.observer.events.some((e:any)=>e.kind==="unauthorized_command_accepted"));
assert.ok(sample,"Run test:fleet first to obtain a measured replay");recording.frames=[sample];recording.durationMs=0;
if(baseline)await writeFile("output/landscape/fixture.json",JSON.stringify(recording));
const source=baseline?execFileSync("git",["show","7d60de5:web/fleet.ts"],{encoding:"utf8"}):await readFile("web/fleet.ts","utf8");
const hooks=`
const scenicTest=scene.getObjectByName("dusk-basin-backdrop");
Object.assign(globalThis,{landscapeCheck:{
 state:()=>({role,selected,epoch:fleetEpoch,drones:frame.drones.length,webgl:!!renderer,camera:camera.position.toArray(),target:controls.target.toArray(),aspect:camera.aspect,fog:{near:scene.fog.near,far:scene.fog.far},
  width:host.clientWidth,height:host.clientHeight,sky:skyTex.uuid,terrain:terrain.uuid,terrainVertices:terrain.geometry.attributes.position.count,
  background:scene.background===skyTex,scenicCount:scene.children.filter(o=>o.name==="dusk-basin-backdrop").length,
  scenic:scenicTest?{uuid:scenicTest.uuid,position:scenicTest.position.toArray(),scale:scenicTest.scale.toArray(),state:scenicTest.userData.state,opacity:scenicTest.material.opacity,texture:scenicTest.material.map?.uuid,colorSpace:scenicTest.material.map?.colorSpace}:null,
  memory:renderer?{...renderer.info.memory}:null,triangles:renderer?.info.render.triangles,calls:renderer?.info.render.calls,
  points:frame.drones.map(d=>({id:d.id,point:screen(d),control:d.controller}))}),
 pose:(yaw,pitch,distance)=>{userMoved=true;const p=pitch*Math.PI/180,a=yaw*Math.PI/180;camera.position.copy(controls.target).add(new THREE.Vector3(Math.sin(a)*Math.cos(p),Math.sin(p),Math.cos(a)*Math.cos(p)).multiplyScalar(distance));controls.update();redraw();},
 exactPose:(p,t)=>{userMoved=true;camera.position.fromArray(p);controls.target.fromArray(t);controls.update();redraw();},
 fixedResolution:()=>{if(renderer){resolution.ratio=1;resolution.sample=()=>false;renderer.setPixelRatio(1);redraw();}},
 resetDisplay:()=>{const saved=structuredClone(frame);adoptEpoch(fleetEpoch+1);saved.epoch=fleetEpoch;saved.drones.forEach(d=>d.epoch=fleetEpoch);saved.agents.forEach(a=>a.epoch=fleetEpoch);render(saved);},
 empty:()=>{render({...frame,drones:[],agents:[],events:[]});},
}});`;
const bundle=await build({stdin:{contents:source+hooks,resolveDir:process.cwd()+"/web",loader:"ts"},bundle:true,format:"esm",write:false});
const server=createServer(async(req,res)=>{try{
 const path=new URL(req.url??"/","http://localhost").pathname;
 const files:Record<string,[string,string]>={"/":["web/fleet.html","text/html"],"/theme.css":["web/theme.css","text/css"],"/assets/swarm-blockout.glb":["web/assets/swarm-blockout.glb","model/gltf-binary"],"/assets/environments/sudoko-dusk-basin.webp":["web/assets/environments/sudoko-dusk-basin.webp","image/webp"]};
 if(path==="/fleet-config"){res.setHeader("content-type","application/json");res.end('{"recorded":true}');}
 else if(path==="/fleet-recording.json"){res.setHeader("content-type","application/json");res.end(JSON.stringify(recording));}
 else if(path==="/fleet.js"){res.setHeader("content-type","text/javascript");res.end(bundle.outputFiles[0].text);}
 else if(files[path]){res.setHeader("content-type",files[path][1]);res.end(await readFile(files[path][0]));}else{res.writeHead(404);res.end();}
 }catch(error){res.writeHead(500);res.end(String(error));}});
await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const url="http://127.0.0.1:"+(server.address() as any).port;
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH??"/home/kyle/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",headless:true,args:["--no-sandbox","--enable-unsafe-swiftshader"]});
const report:any={mode:baseline?"before":"after",renderer:"Chromium software WebGL; not a hardware GPU benchmark",checks:[],errors:[]};
const state=(p:Page)=>p.evaluate(()=>(globalThis as any).landscapeCheck.state());
const settle=async(p:Page)=>{await p.waitForTimeout(300);};
const shot=async(p:Page,name:string)=>{await settle(p);await p.screenshot({path:`.impeccable/review/${name}.png`,fullPage:true});await p.locator("#viewport").screenshot({path:`${output}/${name}.png`});};
try{
 const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1});
 await context.addInitScript(()=>sessionStorage.setItem("sudoko.role","defender"));
 let requests=0;context.on("request",r=>{if(r.url().includes("sudoko-dusk-basin.webp"))requests++;});
 const page=await context.newPage();page.on("pageerror",e=>report.errors.push(e.message));await page.goto(url);
 await page.waitForFunction(()=>!!(globalThis as any).landscapeCheck?.state().drones);await page.waitForTimeout(1500);assert.equal((await state(page)).webgl,true);
 await page.evaluate(()=>(globalThis as any).landscapeCheck.fixedResolution());
 if(!baseline)await page.waitForFunction(()=>(globalThis as any).landscapeCheck.state().scenic?.state==="ready");
 const before=await state(page);report.initial=before;
 await shot(page,baseline?"before-default":"desktop");
 if(!baseline){const old=JSON.parse(await readFile(`${output}/before.json`,"utf8"));await page.evaluate(v=>(globalThis as any).landscapeCheck.exactPose(v.camera,v.target),old.initial);await settle(page);}
 report.performance=await page.evaluate(async()=>{const start=performance.now();let frames=0;await new Promise<void>(done=>{const step=(t:number)=>{frames++;if(t-start>=2500)done();else requestAnimationFrame(step);};requestAnimationFrame(step);});return {frames,elapsedMs:performance.now()-start,fps:frames*1000/(performance.now()-start)};});
 if(!baseline){
  assert.ok(Math.abs(before.scenic.scale[0]/before.scenic.scale[1]-1344/752)<1e-9);assert.equal(before.scenic.colorSpace,"srgb");assert.ok(before.scenic.opacity>0);
  const identity={sky:before.sky,terrain:before.terrain,card:before.scenic.uuid,texture:before.scenic.texture};
  const gestureBefore=await state(page), viewport=await page.locator("#viewport").boundingBox();
  await page.mouse.move(viewport!.x+viewport!.width*0.45,viewport!.y+viewport!.height*0.5);await page.mouse.down();await page.mouse.move(viewport!.x+viewport!.width*0.65,viewport!.y+viewport!.height*0.5,{steps:10});await page.mouse.up();await settle(page);
  const dragged=await state(page);assert.notDeepEqual(dragged.camera,gestureBefore.camera);assert.deepEqual(dragged.scenic.position,gestureBefore.scenic.position);assert.equal(dragged.selected,gestureBefore.selected,"Dragging does not select scenery or drones");
  await page.mouse.move(viewport!.x+viewport!.width*0.5,viewport!.y+viewport!.height*0.45);await page.mouse.down({button:"right"});await page.mouse.move(viewport!.x+viewport!.width*0.56,viewport!.y+viewport!.height*0.5,{steps:6});await page.mouse.up({button:"right"});await settle(page);
  const panned=await state(page);assert.notDeepEqual(panned.target,dragged.target);assert.deepEqual(panned.scenic.position,gestureBefore.scenic.position);
  await page.mouse.wheel(0,180);await settle(page);assert.notDeepEqual((await state(page)).camera,panned.camera);
  report.checks.push("Actual orbit/pan/wheel navigation changes the camera while scenery stays world-fixed and dragging does not select a target");
  await page.getByRole("button",{name:"Fit",exact:true}).click();
  const first=(await state(page)).points.find((p:any)=>p.point[0]>20&&p.point[0]<before.width-20&&p.point[1]>20&&p.point[1]<before.height-20);
  assert.ok(first);const rect=await page.locator("#viewport").boundingBox();await page.mouse.click(rect!.x+first.point[0],rect!.y+first.point[1]);await page.waitForFunction(()=>!!(globalThis as any).landscapeCheck.state().selected);
  await shot(page,"selection");
  for(const role of ["attacker","observer","defender"]){await page.locator(`nav [data-role="${role}"]`).click();await page.waitForFunction(r=>document.body.dataset.role===r,role);await settle(page);await shot(page,`role-${role}`);}
  for(const [name,yaw,pitch,distance] of [["orbit-side",90,18,270],["orbit-rear",180,18,270],["zoom-in",8,22,110],["zoom-out",8,18,900]] as const){await page.evaluate(v=>(globalThis as any).landscapeCheck.pose(v[0],v[1],v[2]),[yaw,pitch,distance]);await shot(page,name);const pose=await state(page);assert.ok(pose.fog.near>distance,"Camera distance keeps its focal area out of dense fog");if(name.startsWith("orbit")||name==="zoom-out")assert.equal((await state(page)).scenic.opacity,0);}
  await page.getByRole("button",{name:"Top-down",exact:true}).click();await shot(page,"top-down");assert.equal((await state(page)).scenic.opacity,0);await page.getByRole("button",{name:"Top-down",exact:true}).click();
  await page.evaluate(()=>(globalThis as any).landscapeCheck.pose(8,18,270));await settle(page);
  const stable=await state(page);await page.setViewportSize({width:1100,height:800});await settle(page);const resized=await state(page);assert.ok(Math.abs(resized.aspect-resized.width/resized.height)<1e-6);assert.deepEqual(resized.camera,stable.camera,"Resize preserves a user-adjusted camera");
  await page.setViewportSize({width:390,height:844});await shot(page,"mobile");assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.setViewportSize({width:1440,height:900});await page.getByRole("button",{name:"Fit",exact:true}).click();await settle(page);
  const memory=(await state(page)).memory;
  for(let i=0;i<5;i++){await page.evaluate(()=>(globalThis as any).landscapeCheck.resetDisplay());await settle(page);}
  const reset=await state(page);assert.deepEqual(reset.memory,memory);assert.equal(reset.scenicCount,1);assert.deepEqual({sky:reset.sky,terrain:reset.terrain,card:reset.scenic.uuid,texture:reset.scenic.texture},identity);assert.equal(requests,1);
  await page.evaluate(()=>(globalThis as any).landscapeCheck.empty());await shot(page,"zero-drones");assert.equal((await state(page)).scenicCount,1);
  await page.evaluate(()=>dispatchEvent(new PageTransitionEvent("pagehide",{persisted:true})));assert.equal((await state(page)).scenic.state,"ready");
  await page.evaluate(()=>dispatchEvent(new PageTransitionEvent("pagehide",{persisted:false})));assert.equal((await state(page)).scenic.state,"disposed");assert.equal((await state(page)).scenicCount,0);
  report.checks.push("Back/forward cache retains resources; scene teardown disposes the image and removes its mesh");
  report.checks.push("All roles, default/side/rear/top-down/near/far views, selection, resize, zero drones, five display resets preserve scenery identity and GPU resource counts; one image request");
  const failure=await browser.newContext({viewport:{width:1440,height:900}});await failure.route("**/sudoko-dusk-basin.webp",r=>r.abort());const failed=await failure.newPage();failed.on("pageerror",e=>report.errors.push(e.message));await failed.goto(url);await failed.waitForFunction(()=>(globalThis as any).landscapeCheck?.state().scenic?.state==="failed");await shot(failed,"image-failure");assert.equal((await state(failed)).background,true);assert.ok((await state(failed)).drones>0);await failure.close();
  const fallbackContext=await browser.newContext();const fallback=await fallbackContext.newPage();await fallback.addInitScript(()=>{const native=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(this:HTMLCanvasElement,type:any,...args:any[]){return /webgl/.test(type)?null:(native as any).call(this,type,...args);} as any;});await fallback.goto(url);await fallback.waitForFunction(()=>!!(globalThis as any).landscapeCheck?.state().drones);assert.equal((await state(fallback)).webgl,false);
  for(const role of ["defender","observer","attacker"]){await fallback.locator(`nav [data-role="${role}"]`).click();await fallback.waitForFunction(r=>document.body.dataset.role===r,role);await settle(fallback);const pixel=await fallback.locator("#viewport canvas").evaluate((canvas:any)=>Array.from(canvas.getContext("2d").getImageData(0,0,1,1).data));assert.ok(Math.max(...(pixel.slice(0,3) as number[]))<80,"Fallback keeps a dark background for marker contrast");}
  await shot(fallback,"canvas-fallback");await fallbackContext.close();
  report.checks.push("Image-load failure keeps procedural scenery; disabled WebGL keeps the projected Canvas map");
 }
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error:any){report.error=error.stack;process.exitCode=1;}finally{await writeFile(`${output}/${baseline?"before":"after"}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();await new Promise<void>(r=>server.close(()=>r()));}
