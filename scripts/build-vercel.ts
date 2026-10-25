import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

// Ship the fleet client and scoped demo config. Maincloud keeps owner/provider credentials.
const out = "output/vercel-static";
await mkdir(`${out}/assets/environments`, { recursive: true });
const configText = process.env.FLEET_MAINCLOUD_CONFIG_JSON || (process.env.FLEET_MAINCLOUD_CONFIG
  ? await readFile(process.env.FLEET_MAINCLOUD_CONFIG, "utf8") : undefined);
if (!configText) throw Error("Set FLEET_MAINCLOUD_CONFIG_JSON or FLEET_MAINCLOUD_CONFIG; production requires Maincloud configuration");
const config = JSON.parse(configText);
if (config.uri !== "https://maincloud.spacetimedb.com" || !config.database || !["attacker", "defender"].every(role => config.workspaces?.[role]?.token && config.switchableRoles?.includes(role)) || config.switchableRoles?.includes("observer") && !config.workspaces?.observer?.token) throw Error("Maincloud deployment requires credentials for its enabled workspaces");
await writeFile(`${out}/fleet-config.json`, JSON.stringify(config));

await Promise.all([
  copyFile("web/fleet.html", `${out}/index.html`),
  copyFile("web/theme.css", `${out}/theme.css`),
  copyFile("web/assets/swarm-blockout.glb", `${out}/assets/swarm-blockout.glb`),
  copyFile("web/assets/environments/sudoko-dusk-basin.webp", `${out}/assets/environments/sudoko-dusk-basin.webp`),
  build({ entryPoints: ["web/fleet.ts"], bundle: true, format: "esm", minify: true, outfile: `${out}/fleet.js` }),
]);
console.log(`Built current fleet UI in ${out}`);
