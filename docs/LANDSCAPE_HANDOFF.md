# Landscape integration prompt

Improve SudoKO's existing fleet landscape and background using the supplied Higgsfield asset. Implement the change; do not just propose a design. Read AGENTS.md and the current fleet documentation first.

## Supplied asset

- `web/assets/environments/sudoko-dusk-basin.webp` — 1344 × 752, approximately 122 KiB.
- Generated through Higgsfield for this project, job `57aa869a-bea2-4669-bc19-d13637420aaf`; optimized from the original PNG.
- Original: https://d8j0ntlcm91z4.cloudfront.net/user_3L7cjj8E7oIqAO1wd6F5LNfP7eA/hf_20261025_053028_57aa869a-bea2-4669-bc19-d13637420aaf.png
- This commit supplies the asset and handoff only. It does not integrate or deploy the background.

## Direction

Create a restrained dusk battlefield: slate-blue mountain ridges, distant communications outposts, atmospheric depth, and a readable central operating area. Use the image as visual direction and distant scenery; preserve genuine 3D foreground terrain, selectable drones, and camera navigation. Scenery is illustrative, not measured geography or operational infrastructure.

Inspect `web/fleet.ts`: the current Three.js scene uses a procedural CanvasTexture sky, role-dependent sky colors, fog, OrbitControls, terrain geometry, contour shading, and a Canvas fallback. Extend this renderer rather than replacing it or adding a framework.

The supplied image is a flat perspective landscape, NOT a seamless panorama, cubemap, HDR environment, terrain heightmap, or ground texture. Do not assign equirectangular mapping to it or stretch it around a sphere. Choose a restrained distant scenic card with feathered edges if it works across the supported camera range; otherwise use it as reference for procedural distant ridges and sky. Do not force a flat image treatment that breaks orbiting, crops mountains awkwardly, or makes the ground appear to slide. Report which approach you chose.

Match foreground materials, lighting and fog to the backdrop. Keep the middle of the battlefield uncluttered and give red/blue team markers strong contrast. Preserve subtle contour cues. Add depth with inexpensive geometry and fog rather than heavy volumetric effects, dense particles, or video playback. Do not bake drones, attack routes, or outcomes into scenery. Decorative outposts must not look selectable or imply live attack targets.

Keep the existing procedural sky available immediately and as a failure fallback. Load the image once, set the appropriate sRGB color space, preserve its aspect ratio, reuse GPU resources, and dispose them only when the scene is destroyed. Reset and role switching must never remove the landscape or recreate its textures unnecessarily. Check interactions with `paintSky()` so it cannot overwrite the new treatment unexpectedly. Preserve the Canvas fallback.

## Asset delivery

Serve the asset locally at `/assets/environments/sudoko-dusk-basin.webp`; do not depend on the external generation URL at runtime. Update the explicit asset copies in `scripts/build-vercel.ts` and `scripts/export-fleet.ts`, creating nested output directories as needed. Update the asset routes in `sandbox/src/fleet-web.ts` and `scripts/check-fleet.ts` with the correct `image/webp` MIME type. Inspect other relevant serving paths rather than assuming a public-directory convention.

## Validation

Run the relevant existing typecheck/build and fleet rendering checks. Visually inspect default view, orbit, zoom, resize, all three roles, zero drones, populated swarm, selection, reset, reconnect, and image-load failure. Check that local, exported and production build artifacts contain the image at the requested URL. Production build validation requires the existing Maincloud configuration; never invent credentials or claim a build ran without it.

Compare viewport responsiveness before and after using the same fleet and camera. Avoid per-frame allocations, React rewrites, unnecessary geometry density, or expensive new postprocessing. Confirm no duplicate landscape meshes or resource growth after repeated resets. Provide before/after screenshots and report any checks that could not run.

Scope this task to environment integration and visual polish. Preserve simulation authority, attack/defense mechanics, chat, agent lifecycle, and event meanings. Commit the implementation and summarize changed files, validation, and remaining limitations. Deploy only if separately authorized.
