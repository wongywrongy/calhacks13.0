import { FLEET } from "../shared/fleet.ts";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
const origin=process.env.MAINCLOUD_FRONTEND_URL||"https://sudo-ko.us";
const send=process.argv.includes("--send"), reset=process.argv.includes("--reset");
const out=process.env.MAINCLOUD_BROWSER_OUTPUT||"output/maincloud/browser";
await mkdir(out,{recursive:true});
const report:any={origin,at:new Date().toISOString(),passed:false,checks:[],errors:[],requests:[]};
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:["--no-sandbox","--enable-unsafe-swiftshader"]});
const context=await browser.newContext({viewport:{width:1366,height:768}});
const sockets:any[]=[];
await context.routeWebSocket(/maincloud\.spacetimedb\.com/,socket=>{socket.connectToServer();sockets.push(socket)});
const page=await context.newPage();
page.on("pageerror",e=>report.errors.push(e.message));
page.on("request",r=>report.requests.push(r.url().split("?")[0]));
const wait=async(fn:()=>Promise<any>,ms=85000)=>{const until=Date.now()+ms;while(Date.now()<until){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,350))}throw Error("Browser check timed out")};
try{
  await page.addInitScript(()=>sessionStorage.setItem("sudoko.role","defender"));
  await page.goto(origin + (process.env.VERCEL_PREVIEW_SHARE ? `?_vercel_share=${process.env.VERCEL_PREVIEW_SHARE}` : ""));
  await page.waitForFunction(()=>document.querySelector("#live")?.textContent?.startsWith("Live"),{timeout:30000});
  const config:any=await context.request.get(origin+"/fleet-config").then(r=>r.json());
  assert.equal(config.maincloud,true);assert.equal(config.uri,"https://maincloud.spacetimedb.com");
  const rows=async(table:string,role="defender")=>{
    const r=await context.request.post(`${config.uri}/v1/database/${config.database}/sql`,{headers:{authorization:`Bearer ${config.workspaces[role].token}`},data:`SELECT * FROM ${table}`});
    assert.ok(r.ok(),`Maincloud ${table}: HTTP ${r.status()}`);
    const data=await r.json();return data[0].rows.map((values:any[])=>Object.fromEntries(data[0].schema.elements.map((f:any,i:number)=>[f.name.some,values[i]])));
  };
  const session=(await rows("visible_fleet_session"))[0];
  assert.equal((await rows("visible_drones")).length,FLEET.drones);
  assert.equal((await rows("visible_agents")).length,0);
  report.epoch=session.epoch;
  for(const [name,role] of [["1. Prepare challenge","attacker"],["2. Prepare defense","defender"]]){
    await page.getByRole("button",{name,exact:true}).click();
    await page.waitForFunction(role=>document.body.dataset.role===role,role);
    await page.waitForFunction(()=>document.querySelector("#live")?.textContent?.startsWith("Live"));
    assert.ok((await page.locator("#say").inputValue()).length>20);
  }
  for(const width of [1280,1366,1440]){
    await page.setViewportSize({width,height:768});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    for(const selector of ["#viewport","#compose"]){const box=await page.locator(selector).boundingBox();assert.ok(box&&box.height>0&&box.y>=0&&box.y+box.height<=768,`${selector} fits ${width}x768`)}
  }
  report.checks.push(`${FLEET.drones} drones, zero initial agents, both guided roles and editable chat, viewport and composer fit laptop sizes`);
  await page.locator("#say").fill("");
  await page.reload();
  await page.waitForFunction(()=>document.querySelector("#live")?.textContent?.startsWith("Live"));
  assert.equal((await rows("visible_fleet_session"))[0].epoch,session.epoch);
  const socketCount=sockets.length;
  for(const s of [...sockets])s.close({code:1012,reason:"verification reconnect"});
  await wait(async()=>sockets.length>=socketCount+2,20000);
  await page.waitForFunction(()=>document.querySelector("#live")?.textContent?.startsWith("Live"));
  report.checks.push("Refresh and forced WebSocket reconnect restore the current Maincloud epoch");
  if(send){
    for(const [name,role,message] of [
      ["1. Prepare challenge","attacker","Deploy exactly two specialists on targets 1 and 2. Discover each synthetic drone, then test the planted command authorization weakness. Reassess measured results and adapt within the original budget until capture is verified or an honest terminal blocker remains."],
      ["2. Prepare defense","defender","Deploy exactly two specialists to recover drones 1 and 2. Isolate each, then verify unauthorized denial and legitimate command acceptance. Report measured recovery evidence."],
    ]){
      await page.getByRole("button",{name,exact:true}).click();
      await page.waitForFunction(role=>document.body.dataset.role===role,role);
      await page.waitForFunction(()=>document.querySelector("#live")?.textContent?.startsWith("Live"));
      await page.locator("#say").fill(message);
      await page.getByRole("button",{name:"Send",exact:true}).click();
      const op=await wait(async()=>{
        const operations=await rows("visible_chat_operations",role);
        const op=operations.find((o:any)=>JSON.parse(o.config).message===message);
        if(!op||["planning","running"].includes(op.state))return false;
        assert.equal(op.state,"completed",op.result);return op;
      });
      const records=JSON.parse(op.result),outcome=role==="attacker"?"unauthorized_command_accepted":"recovery_verified";
      assert.ok(records.some((r:any)=>r.outcome===outcome));
      await wait(async()=> (await page.locator(`[data-operation-id="${op.id}"] .interaction-outcome`).innerText()).includes("Mission verified success"),10000);
      report.operations??=[];report.operations.push({id:op.id,role,state:op.state,records});
    }
    await page.locator("#judge-guide summary").click();
    const evidence=(await rows("visible_evidence")).filter((e:any)=>e.kind==="recovery_verified").at(-1);
    assert.ok(evidence);
    const button=page.locator(`#judge-findings [data-evidence-id="${evidence.id}"]`);
    await button.click();
    assert.equal(await button.getAttribute("aria-pressed"),"true");
    assert.match(await page.locator("#context-slot").innerText(),new RegExp("DR-"+String(evidence.drone).padStart(3,"0")));
    assert.match(await page.locator("#judge-findings").innerText(),/Agent susceptibility and causal spread are not established/);
    await page.screenshot({path:`${out}/findings.png`});
    report.checks.push("Live judge Send flow completes Bitdeer attack and defense; measured evidence selects its drone; unverified susceptibility stays explicit");
    await page.locator("#judge-guide summary").click();
  }
  if(reset){
    page.once("dialog",dialog=>void dialog.accept());
    await page.getByRole("button",{name:"Reset Demo",exact:true}).click();
    await wait(async()=> (await rows("visible_fleet_session"))[0].epoch>session.epoch,10000);
    await page.waitForFunction(()=>document.querySelector("#live")?.textContent==="Live · Awaiting objective");
    assert.equal((await rows("visible_drones")).length,FLEET.drones);assert.equal((await rows("visible_agents")).length,0);
    report.checks.push(`Confirmed browser reset returns to ${FLEET.drones} persisted drones and zero agents`);
  }
  await page.screenshot({path:`${out}/fleet.png`});
  assert.deepEqual(report.errors,[]);
  assert.ok(!report.requests.some((url:string)=>/neo\.|tailscale|taile1abc7|\/api\//i.test(url)),"Production browser must have no legacy host or API proxy dependency");
  report.checks.push("No browser exceptions or Neo/Tailscale/API-proxy requests");report.passed=true;
}catch(e:any){report.error=e.stack;process.exitCode=1;}
finally{await browser.close();await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.checks,error:report.error}));}
