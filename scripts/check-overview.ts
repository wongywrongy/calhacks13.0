import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { testDatabase } from "../sandbox/test/spacetime-helper.ts";
import { RunStore } from "../sandbox/src/run-store.ts";

const real = process.argv.includes("--real");
if (real && !process.env.BITDEER_API_KEY) throw Error("Set BITDEER_API_KEY for --real; no fixture fallback");
const output = "output/overview";
await mkdir(output, { recursive: true });
await build({ stdin: { contents: await readFile("web/fleet.ts", "utf8") + "\nObject.assign(globalThis,{disconnectOverview:()=>close()});", resolveDir: process.cwd()+"/web", loader:"ts" }, bundle:true, format:"esm", outfile:output+"/browser.js" });
const db = await testDatabase(undefined, real ? { BITDEER_API_KEY: process.env.BITDEER_API_KEY! } : {});
const owner = new RunStore({uri:db.env.SPACETIME_URI,database:db.env.SPACETIME_DATABASE,token:db.env.SPACETIME_TOKEN});
const config = {maincloud:true,uri:db.env.SPACETIME_URI,database:db.env.SPACETIME_DATABASE,sandbox:db.env.SPACETIME_DATABASE,models:{coordinator:"zai-org/GLM-5.3-Flash",specialist:"zai-org/GLM-5.3-Flash"},engine:"bitdeer"};
const files:Record<string,[string,string]> = {"/":["web/fleet.html","text/html"],"/theme.css":["web/theme.css","text/css"],"/fleet.js":[output+"/browser.js","text/javascript"],"/assets/swarm-blockout.glb":["web/assets/swarm-blockout.glb","model/gltf-binary"],"/assets/environments/sudoko-dusk-basin.webp":["web/assets/environments/sudoko-dusk-basin.webp","image/webp"]};
const server = createServer((req,res) => { void (async()=>{
  const path = new URL(req.url!,"http://localhost").pathname;
  if(path==="/fleet-config"){res.setHeader("content-type","application/json");res.end(JSON.stringify(config));return;}
  const file=files[path];if(!file){res.writeHead(404).end();return;}res.setHeader("content-type",file[1]);res.end(await readFile(file[0]));
})().catch(()=>res.writeHead(500).end()); });
await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:["--no-sandbox","--enable-unsafe-swiftshader"]});
const report:any={realProvider:real,passed:false,checks:[],errors:[]};
try {
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  page.on("pageerror",error=>report.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as any).port}`);
  await page.locator("#continue").click();
  const live=()=>page.waitForFunction(()=>document.querySelector("#live")?.textContent==="Live");
  await live();
  await page.locator('nav [data-role="observer"]').click();await live();
  await page.locator("#overview").waitFor();
  assert.equal(await page.locator(".overview-grid button").count(),200);
  assert.match(await page.locator("#overview").innerText(),/0 of 200/);
  assert.equal(await page.locator("#compose").isVisible(),false);
  await page.locator("#analyze").click();
  await page.waitForFunction(()=>/completed|failed/.test(document.querySelector("#analysis-status")?.textContent??""),undefined,{timeout:35000});
  report.analysisStatus=await page.locator("#analysis-status").innerText();
  report.analysis=await page.locator("#analysis-text").innerText();
  assert.match(report.analysisStatus,real?/completed/:/failed/);
  if(!real)assert.match(report.analysis,/provider_not_configured|not configured/);
  assert.equal((await owner.query("SELECT * FROM fleet_agent")).length,0);
  assert.equal((await owner.query("SELECT * FROM battle_attempt")).length,0);
  report.checks.push("Visitor Overview shows 200 untested drones; analysis creates no agents or action attempts");
  await page.screenshot({path:output+"/current-desktop.png"});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:output+"/current-mobile.png",fullPage:true});
  await page.setViewportSize({width:1440,height:960});
  await page.evaluate(()=>(globalThis as any).disconnectOverview());
  await page.waitForFunction(()=>document.querySelector("#live")?.textContent!=="Live");
  await live();
  for(const role of ["attacker","defender","observer"]){await page.locator(`nav [data-role="${role}"]`).click();await live();}
  await page.reload();await live();
  await page.locator("#overview").waitFor();
  assert.match(await page.locator("#analysis-status").innerText(),real?/completed/:/failed/);
  assert.deepEqual(report.errors,[]);
  report.checks.push("Desktop/mobile fit; forced reconnect, role switching and reload preserve the persisted analysis");
  report.passed=true;
} catch(error) {
  report.error=error instanceof Error?error.stack:String(error);process.exitCode=1;
} finally {
  await browser.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await db.close();
  await writeFile(output+"/current-verification.json",JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
