import assert from "node:assert/strict";
import {randomUUID,createHash} from "node:crypto";
import {readFile,writeFile} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {build} from "esbuild";
import {chromium} from "@playwright/test";
import {testDatabase} from "../sandbox/test/spacetime-helper.ts";
import {startService} from "../sandbox/src/service.ts";
const db=await testDatabase();
const env:NodeJS.ProcessEnv={...db.env,SUDOKO_DEMO_MODE:"1",FLEET_PUBLIC_URI:db.env.SPACETIME_URI};
const service=await startService({operatorToken:randomUUID()+randomUUID(),env});
const bundle=await build({stdin:{contents:await readFile("web/fleet.ts","utf8")+`
Object.assign(globalThis,{environmentState:()=>({epoch:fleetEpoch,count:frame.drones.length,tick:frame.drones.find(d=>d.id===1)?.tick,
 sky:skyTex.uuid,card:duskBackdrop?.uuid,texture:duskBackdrop?.material.map?.uuid,state:duskBackdrop?.userData.state,
 scenery:scene.children.filter(o=>o.name==="dusk-basin-backdrop").length,memory:renderer?{...renderer.info.memory}:null})});`,resolveDir:process.cwd()+"/web",loader:"ts"},bundle:true,format:"esm",write:false});
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH??"/home/kyle/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",args:["--no-sandbox","--enable-unsafe-swiftshader"],headless:true});
const report:any={checks:[],errors:[]};let fixture:ReturnType<typeof spawn>|undefined;
const asset="/assets/environments/sudoko-dusk-basin.webp";
const source=await readFile("web"+asset),hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const checkAsset=async(url:string)=>{const response=await fetch(url+asset);assert.equal(response.status,200);assert.equal(response.headers.get("content-type"),"image/webp");assert.equal(hash(new Uint8Array(await response.arrayBuffer())),hash(source));};
try{
 await service.store.call("start_fleet",[120,0,0,false]);
 for(const role of ["attacker","defender","observer"]){const identity:any=await fetch(db.env.SPACETIME_URI+"/v1/identity",{method:"POST"}).then(r=>r.json());await service.store.call("grant_fleet_view",[identity.identity,role]);env[`SUDOKO_DEMO_${role.toUpperCase()}_VIEWER_TOKEN`]=identity.token;}
 await checkAsset(service.url);
 for(const path of ["output/fleet-site"+asset,"output/vercel-static"+asset])assert.equal(hash(await readFile(path)),hash(source));
 report.checks.push("Backend HTTP route serves identical WebP bytes with image/webp; exported and actual Maincloud-configured production build contain the same asset");
 const context=await browser.newContext({viewport:{width:1440,height:900}});await context.addInitScript(()=>sessionStorage.setItem("sudoko.role","defender"));await context.route("**/fleet.js",r=>r.fulfill({contentType:"text/javascript",body:bundle.outputFiles[0].text}));
 let requests=0;context.on("request",r=>{if(r.url().endsWith(asset))requests++;});
 const page=await context.newPage();page.on("pageerror",e=>report.errors.push(e.message));await page.goto(service.url);
 const state=()=>page.evaluate(()=>(globalThis as any).environmentState());
 await page.waitForFunction(()=>{const s=(globalThis as any).environmentState?.();return s?.count===120&&s?.state==="ready"});await delay(1000);
 const initial=await state();
 for(let i=0;i<3;i++){const epoch=(await state()).epoch;await page.locator("#reset-swarm").click();await page.waitForFunction(previous=>(globalThis as any).environmentState().epoch>previous,epoch);await page.waitForFunction(()=>(globalThis as any).environmentState().count===120);}
 await delay(700);const reset=await state();assert.equal(reset.epoch,initial.epoch+3);
 for(const field of ["sky","card","texture"])assert.equal(reset[field],initial[field]);assert.equal(reset.scenery,1);assert.equal(requests,1);assert.deepEqual(reset.memory,initial.memory);
 await page.screenshot({path:".impeccable/review/live-reset.png",fullPage:true});await page.locator("#viewport").screenshot({path:"output/landscape/live-reset.png"});
 report.checks.push("Three real backend swarm resets retain 120 drones, one landscape, texture identities and GPU resource counts with no image reload");
 await page.locator('nav [data-role="attacker"]').click();await page.waitForFunction(()=>document.body.dataset.role==="attacker"&&(globalThis as any).environmentState().count===0);assert.equal((await state()).card,initial.card);
 await page.locator('nav [data-role="defender"]').click();await page.waitForFunction(()=>document.body.dataset.role==="defender"&&(globalThis as any).environmentState().count===120);
 await db.restart();const [committed]=await service.store.query("SELECT * FROM fleet_drone WHERE id=1");await page.waitForFunction(t=>(globalThis as any).environmentState().tick>t,committed.tick,{timeout:20000});
 await page.screenshot({path:".impeccable/review/live-reconnect.png",fullPage:true});await page.locator("#viewport").screenshot({path:"output/landscape/live-reconnect.png"});
 assert.equal((await state()).texture,initial.texture);assert.equal(requests,1);
 report.checks.push("A real database restart recovers current fleet updates through the existing connection/fallback path without reloading scenery; attacker with zero discoveries also retains the environment");
 const portServer=createServer();await new Promise<void>(r=>portServer.listen(0,"127.0.0.1",r));const port=(portServer.address() as any).port;await new Promise<void>(r=>portServer.close(()=>r()));
 let text="";fixture=spawn(process.execPath,["scripts/check-fleet.ts","--serve"],{env:{...process.env,CHECK_SPACETIME_URI:`http://127.0.0.1:${port}`,FLEET_PORT:"0"},stdio:["ignore","pipe","pipe"]});
 fixture.stdout!.on("data",data=>{text+=data;});fixture.stderr!.on("data",data=>{text+=data;});
 let address="";for(let i=0;i<600;i++){address=/Fleet demo: (http:\/\/127\.0\.0\.1:\d+)/.exec(text)?.[1]??"";if(address)break;if(fixture.exitCode!==null)throw Error("Fleet fixture server failed: "+text);await delay(50);}
 assert.ok(address,"Fixture server did not start");await checkAsset(address);report.checks.push("Existing fixture server passes its reducer checks and serves the image with the correct MIME type on an isolated loopback port");
 assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error:any){report.error=error.stack;process.exitCode=1;}finally{
 if(fixture&&fixture.exitCode===null){fixture.kill("SIGINT");await new Promise<void>(r=>fixture!.once("exit",()=>r()));}
 await writeFile("output/landscape/live.json",JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();await service.close();await db.close();
}
