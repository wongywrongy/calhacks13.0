import { mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
const destination = resolve(process.argv[2] ?? "output/fleet-site");
const recording = JSON.parse(
  await readFile("output/fleet/recording.json", "utf8"),
);
if (!recording.frames?.length)
  throw Error("Run test:fleet first to produce measured frames");
await mkdir(join(destination, "assets/environments"), { recursive: true });
await copyFile("web/fleet.html", join(destination, "index.html"));
await copyFile("web/dist/fleet.js", join(destination, "fleet.js"));
await copyFile("web/theme.css", join(destination, "theme.css"));
await copyFile(
  "web/assets/swarm-blockout.glb",
  join(destination, "assets/swarm-blockout.glb"),
);
await copyFile("web/assets/environments/sudoko-dusk-basin.webp", join(destination, "assets/environments/sudoko-dusk-basin.webp"));
await writeFile(
  join(destination, "fleet-config"),
  JSON.stringify({ recorded: true }),
);
await writeFile(
  join(destination, "fleet-recording.json"),
  JSON.stringify(recording),
);
console.log(
  `Exported ${recording.frames.length} measured frames to ${destination}`,
);
