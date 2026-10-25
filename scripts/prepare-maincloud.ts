import { mkdir, readFile, writeFile } from "node:fs/promises";

const database = process.env.MAINCLOUD_DATABASE || "sudoko-maincloud-20261025";
const uri = "https://maincloud.spacetimedb.com";
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(database)) throw Error("Invalid Maincloud database name");
const out = process.env.MAINCLOUD_OUTPUT || "output/maincloud";
await mkdir(out, { recursive:true, mode:0o700 });
const configPath = `${out}/fleet-config.json`;
let existing:any;
try { existing=JSON.parse(await readFile(configPath,"utf8")); } catch (e:any) { if(e.code!=="ENOENT") throw e; }
if (existing && existing.database!==database) throw Error("Config database mismatch");
const config={maincloud:true,visitorSessions:true,uri,database,sandbox:database,authenticated:true,demo:true,chat:true,engine:"bitdeer",models:{coordinator:process.env.BITDEER_COORDINATOR_MODEL||"zai-org/GLM-5.3-Flash",specialist:process.env.BITDEER_SPECIALIST_MODEL||"zai-org/GLM-5.3-Flash"}};
await writeFile(configPath,JSON.stringify(config,null,2)+"\n",{mode:0o600});
// Connection metadata never provisions identities or changes simulation data.
console.log(`Prepared non-secret visitor connection metadata for ${database} at ${configPath}. Owner and provider credentials are excluded.`);
