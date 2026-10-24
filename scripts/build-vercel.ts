import { mkdir, copyFile } from "node:fs/promises";
import { build } from "esbuild";

// Ship only the existing fleet client; the scheduler and credentials stay on the backend host.
const out = "output/vercel-static";
await mkdir(`${out}/assets`, { recursive: true });
await Promise.all([
  copyFile("web/fleet.html", `${out}/index.html`),
  copyFile("web/assets/swarm-blockout.glb", `${out}/assets/swarm-blockout.glb`),
  build({ entryPoints: ["web/fleet.ts"], bundle: true, format: "esm", minify: true, outfile: `${out}/fleet.js` }),
]);
console.log(`Built current fleet UI in ${out}`);
