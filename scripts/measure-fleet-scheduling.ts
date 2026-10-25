// Bundle with esbuild before running (SDK imports); see docs/DATABASE_DESIGN.md.
// Local disposable WASM experiment; never publishes the comparison module to Maincloud.
import { cp,copyFile,mkdtemp,mkdir,readFile,writeFile,rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { DbConnection } from "../web/module_bindings/index.ts";
import { testDatabase } from "../sandbox/test/spacetime-helper.ts";
import { RunStore } from "../sandbox/src/run-store.ts";
const exec=promisify(execFile), root=process.cwd(),temp=await mkdtemp("/tmp/fleet-scheduling-");
const wasm="arena-live/target/wasm32-unknown-unknown/release/sudoko_live.wasm";
const hz=Number((await exec("getconf",["CLK_TCK"])).stdout.trim());
const cpu=async(pid:number)=>{const fields=(await readFile(`/proc/${pid}/stat`,"utf8")).split(") ")[1].split(" ");return (Number(fields[11])+Number(fields[12]))/hz;};
try {
  await copyFile(wasm,temp+"/single.wasm");
  await mkdir(temp+"/arena-live");
  for(const file of ["Cargo.toml","Cargo.lock","build.rs","src"])await cp("arena-live/"+file,temp+"/arena-live/"+file,{recursive:true});
  await cp("shared",temp+"/shared",{recursive:true});
  await writeFile(temp+"/arena-live/src/fleet.rs",(await readFile(temp+"/arena-live/src/fleet.rs","utf8"))+`
#[table(accessor=benchmark_schedule,scheduled(benchmark_tick))]
pub struct BenchmarkSchedule { #[primary_key] id:u64, scheduled_at:ScheduleAt, epoch:u64 }
#[reducer]
pub fn benchmark_batch(ctx:&ReducerContext)->Result<(),String>{
 owner(ctx)?;let epoch=ctx.db.fleet_session().id().find(0).ok_or("Fleet missing")?.epoch;
 for t in ctx.db.drone_schedule().iter(){ctx.db.drone_schedule().id().delete(t.id);}
 ctx.db.benchmark_schedule().insert(BenchmarkSchedule{id:0,scheduled_at:Duration::from_millis(240).into(),epoch});Ok(())
}
#[reducer]
pub fn benchmark_tick(ctx:&ReducerContext,t:BenchmarkSchedule){
 if !live(ctx,t.epoch){ctx.db.benchmark_schedule().id().delete(t.id);return}
 for d in ctx.db.fleet_drone().epoch().filter(t.epoch){drone_tick(ctx,DroneSchedule{id:d.id as u64,epoch:t.epoch,scheduled_at:Duration::from_millis(240).into()});}
}
`);
  try {
    await exec("cargo",["build","--manifest-path",temp+"/arena-live/Cargo.toml","--target","wasm32-unknown-unknown","--release","--target-dir",resolve("arena-live/target")]);
    await copyFile(wasm,temp+"/batch.wasm");
  }finally{await copyFile(temp+"/single.wasm",wasm);}
  const samples=[];
  for(const mode of ["single","batch"]){
    const db=await testDatabase(temp+"/"+mode+".wasm");let conn:DbConnection|undefined;
    try {
      const store=new RunStore({uri:db.env.SPACETIME_URI,database:db.env.SPACETIME_DATABASE,token:db.env.SPACETIME_TOKEN});
      const identity:any=await fetch(db.env.SPACETIME_URI+"/v1/identity",{method:"POST"}).then(r=>r.json());
      await store.call("grant_fleet_view",[identity.identity,"defender"]);await store.call("start_fleet",[200,0,0,false]);
      if(mode==="batch")await store.call("benchmark_batch",[]);
      let callbacks=0;
      await new Promise<void>((done,reject)=>{
        conn=DbConnection.builder().withUri(db.env.SPACETIME_URI).withDatabaseName(db.env.SPACETIME_DATABASE).withToken(identity.token)
          .onConnect(c=>{c.db.visibleDrones.onInsert(()=>callbacks++);c.subscriptionBuilder().onApplied(()=>done()).onError(e=>reject(e.event)).subscribe(["SELECT * FROM visible_drones"]);})
          .onConnectError((_c,e)=>reject(e)).build();
      });
      await delay(1000);
      const ticks=()=>[...conn!.db.visibleDrones.iter()].reduce((n,d)=>n+d.tick,0);
      const before=ticks(),updates=callbacks,cpuBefore=await cpu(db.pid()),start=performance.now();
      await delay(5000);
      const elapsedMs=performance.now()-start,cpuSeconds=(await cpu(db.pid()))-cpuBefore,movementTicks=ticks()-before;
      assert.ok(movementTicks>1000&&callbacks>updates,"Both modes must move and deliver subscribed updates");
      samples.push({mode,drones:200,elapsedMs,movementTicks,updateCallbacks:callbacks-updates,cpuSeconds,cpuMsPer1000Ticks:cpuSeconds*1e6/movementTicks,approxMovementTransactions:mode==="single"?movementTicks:movementTicks/200});
    }finally{conn?.disconnect();await db.close();}
  }
  const report={measuredAt:new Date().toISOString(),scope:"One five-second sample per mode, local Linux standalone 2.13.0, one scoped subscriber, no inference or rendering. Batch uses uniform 240ms cadence; baseline uses 180–300ms independent cadence. Not a hosted/GPU benchmark.",samples};
  await mkdir(root+"/output/architecture",{recursive:true});await writeFile(root+"/output/architecture/scheduling.json",JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await rm(temp,{recursive:true,force:true});}
