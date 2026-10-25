import assert from "node:assert/strict";
import {mkdir,writeFile} from "node:fs/promises";
import {chromium} from "@playwright/test";

// Public inspection is read-only. State-changing/provider checks belong in a disposable DB.
assert.ok(!process.argv.includes("--send")&&!process.argv.includes("--reset"),"Use scripts/check-judge.ts --real for isolated mission/reset verification");
const origin=process.env.MAINCLOUD_FRONTEND_URL || "https://sudo-ko.us";
const out=process.env.MAINCLOUD_BROWSER_OUTPUT || "output/maincloud/browser";
await mkdir(out,{recursive:true});
const report:any={origin,at:new Date().toISOString(),readOnly:true,passed:false,checks:[],errors:[],requests:[]};
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:["--no-sandbox","--enable-unsafe-swiftshader"]});
try{
 const context=await browser.newContext({viewport:{width:1366,height:768}}),page=await context.newPage();
 page.on("pageerror",e=>report.errors.push(e.message));page.on("request",r=>report.requests.push(new URL(r.url()).pathname));
 await page.goto(origin);await page.waitForFunction(()=>document.querySelector("#live")?.textContent==="Live");
 report.initialText=await page.locator("body").innerText();await page.screenshot({path:`${out}/first-visit.png`});
 for(const role of ["attacker","defender","observer"]){
  const button=page.locator(`nav [data-role="${role}"]`);assert.ok(await button.isEnabled(),`${role} workspace must be available`);await button.click();
  await page.waitForFunction(r=>document.body.dataset.role===r&&document.querySelector("#live")?.textContent==="Live",role);
  if(role!=="observer")assert.ok(await page.locator("#say").isEditable());else{assert.equal(await page.locator("#compose").isVisible(),false);assert.match(await page.locator("#overview").innerText(),/Not tested does not mean safe/);}
 }
 report.checks.push("Current Attack/Defend controls open editable chat; Observer opens a read-only evidence assessment");
 await page.reload();await page.waitForFunction(()=>document.body.dataset.role==="observer"&&document.querySelector("#live")?.textContent==="Live");
 await page.screenshot({path:`${out}/assessment.png`});
 for(const width of [1280,1366,390]){await page.setViewportSize({width,height:width===390?844:768});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
 await page.locator("#overview").scrollIntoViewIfNeeded();await page.screenshot({path:`${out}/narrow.png`});
 assert.deepEqual(report.errors,[]);assert.ok(!report.requests.some((path:string)=>path.startsWith("/api/")),"No legacy API proxy requests");
 report.checks.push("Refresh preserves Observer, laptop/narrow views fit, no page errors or legacy API calls");report.passed=true;
}catch(error){report.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{await browser.close();await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,error:report.error,checks:report.checks}));}
