import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

// Ship connection metadata only. Each browser admits its own identity-bound session.
const out = "output/vercel-static";
await mkdir(`${out}/assets/environments`, { recursive: true });
const configText = process.env.FLEET_MAINCLOUD_CONFIG_JSON || (process.env.FLEET_MAINCLOUD_CONFIG
  ? await readFile(process.env.FLEET_MAINCLOUD_CONFIG, "utf8") : undefined);
if (!configText) throw Error("Set FLEET_MAINCLOUD_CONFIG_JSON or FLEET_MAINCLOUD_CONFIG; production requires Maincloud configuration");
const input = JSON.parse(configText);
if (input.uri !== "https://maincloud.spacetimedb.com" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.database)) throw Error("Maincloud deployment requires valid connection metadata");
const config = { maincloud:true, visitorSessions:true, uri:input.uri, database:input.database, sandbox:input.database, authenticated:true, demo:true, chat:true, engine:input.engine ?? "bitdeer", models:input.models };
await writeFile(`${out}/fleet-config.json`, JSON.stringify(config));

await Promise.all([
  copyFile("web/fleet.html", `${out}/index.html`),
  copyFile("web/theme.css", `${out}/theme.css`),
  copyFile("web/assets/swarm-blockout.glb", `${out}/assets/swarm-blockout.glb`),
  copyFile("web/assets/environments/sudoko-dusk-basin.webp", `${out}/assets/environments/sudoko-dusk-basin.webp`),
  build({ entryPoints: ["web/fleet.ts"], bundle: true, format: "esm", minify: true, outfile: `${out}/fleet.js` }),
]);
console.log(`Built current fleet UI in ${out}`);
