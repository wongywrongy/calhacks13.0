import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const database = process.env.MAINCLOUD_DATABASE || "sudoko-maincloud-20261025";
const uri = "https://maincloud.spacetimedb.com";
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(database)) throw Error("Invalid Maincloud database name");
const out = process.env.MAINCLOUD_OUTPUT || "output/maincloud";
await mkdir(out, { recursive:true, mode:0o700 });
const call = (name:string,args:unknown[]) => execFileSync("spacetime", ["call", "-s", "maincloud", database, name, ...args.map(a => JSON.stringify(a)), "-y"], {stdio:["ignore","pipe","pipe"]});
const configPath = `${out}/fleet-config.json`;
let existing:any;
try { existing=JSON.parse(await readFile(configPath,"utf8")); } catch (e:any) { if(e.code!=="ENOENT") throw e; }
if (existing && existing.database!==database) throw Error("Config database mismatch");
const workspaces:any=existing?.workspaces ?? {};
for (const role of ["attacker","defender"]) {
  if (!workspaces[role]) {
    const r=await fetch(`${uri}/v1/identity`,{method:"POST"});
    if (!r.ok) throw Error(`Maincloud identity: HTTP ${r.status}`);
    const credentials:any=await r.json();
    call("grant_fleet_view",[credentials.identity,role]);
    workspaces[role]={token:credentials.token,identity:credentials.identity};
  }
}
const config={maincloud:true,uri,database,sandbox:database,authenticated:true,demo:true,chat:true,engine:"bitdeer",switchableRoles:["attacker","defender"],models:{coordinator:process.env.BITDEER_COORDINATOR_MODEL||"zai-org/GLM-5.3-Flash",specialist:process.env.BITDEER_SPECIALIST_MODEL||"zai-org/GLM-5.3-Flash"},workspaces};
await writeFile(configPath,JSON.stringify(config,null,2)+"\n",{mode:0o600});
// Provisioning grants never initializes or resets existing data.
console.log(`Prepared role-scoped demo credentials for ${database} at ${configPath}. Owner and provider credentials are excluded.`);
