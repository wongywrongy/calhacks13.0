import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DbConnection } from "./module_bindings/index.ts";
const $ = (id: string) => document.getElementById(id)!;
const text = (tag: string, value: unknown) => {
  const n = document.createElement(tag);
  n.textContent = String(value);
  return n;
};
type Role = "attacker" | "defender" | "observer";
let role: Role = "defender",
  recording: any,
  frame: any,
  selected = 0,
  selectedEvent = 0,
  playing = false,
  index = 0,
  close = () => {},
  version = 0,
  live = false,
  lastReceived = 0;
const host = $("viewport"),
  scene = new THREE.Scene();
scene.background = new THREE.Color("#081219");
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 500);
camera.position.set(100, 125, 140);
camera.lookAt(45, 0, 25);
let fallback: HTMLCanvasElement | undefined;
let renderer: THREE.WebGLRenderer | undefined;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  host.append(renderer.domElement);
} catch {
  fallback = document.createElement("canvas");
  host.append(fallback);
  $("error").textContent =
    "WebGL unavailable · using the interactive projected map.";
}
scene.add(new THREE.HemisphereLight(0xcceaff, 0x17232a, 2));
const light = new THREE.DirectionalLight(0xffffff, 2);
light.position.set(30, 60, 20);
scene.add(light);
const ground = new THREE.Mesh(
  new THREE.BoxGeometry(115, 0.5, 125),
  new THREE.MeshStandardMaterial({ color: 0x11232b, roughness: 1 }),
);
ground.position.set(45, -1, 40);
scene.add(ground);
const grid = new THREE.GridHelper(120, 24, 0x365463, 0x203a48);
grid.position.set(45, -0.7, 40);
scene.add(grid);
// Schematic city context. It does not imply measured buildings or network links.
const buildings = new THREE.InstancedMesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x253b47, roughness: 0.9 }),
  16,
);
const dummy = new THREE.Object3D();
for (let i = 0; i < 16; i++) {
  const h = 3 + (i % 4) * 2;
  dummy.position.set((i % 8) * 13 - 4, h / 2, i < 8 ? -15 : 105);
  dummy.scale.set(6, h, 6);
  dummy.updateMatrix();
  buildings.setMatrixAt(i, dummy.matrix);
}
scene.add(buildings);
const body = new THREE.BoxGeometry(1.8, 0.6, 1.1),
  arm = new THREE.BoxGeometry(3.8, 0.18, 0.16),
  rotor = new THREE.CylinderGeometry(0.6, 0.6, 0.09, 12);
const materials = {
  defender: new THREE.MeshStandardMaterial({
    color: 0x69b4ff,
    metalness: 0.3,
    roughness: 0.45,
  }),
  attacker: new THREE.MeshStandardMaterial({
    color: 0xff5569,
    metalness: 0.3,
    roughness: 0.45,
  }),
};
let droneTemplate: THREE.Object3D | undefined;
// Reuse the inspected Higgsfield blockout geometry; state and movement remain database-driven.
new GLTFLoader().load(
  "/assets/swarm-blockout.glb",
  (gltf) => {
    const source = gltf.scene.getObjectByName("HERO_drone");
    if (!source) return;
    source.position.set(0, 0, 0);
    droneTemplate = source;
    for (const g of drones.values()) scene.remove(g);
    drones.clear();
    if (frame) render(frame);
  },
  undefined,
  () => {
    /* Procedural geometry is the lightweight fallback. */
  },
);
const drones = new Map<number, THREE.Group>();
function draw() {
  camera.updateMatrixWorld();
  if (renderer) {
    renderer.render(scene, camera);
    return;
  }
  const c = fallback?.getContext("2d");
  if (!c || !fallback) return;
  const w = host.clientWidth,
    h = host.clientHeight,
    scale = Math.min(devicePixelRatio, 1.5);
  c.setTransform(scale, 0, 0, scale, 0, 0);
  c.clearRect(0, 0, w, h);
  const point = (x: number, y: number, z: number) => {
    const p = new THREE.Vector3(x, y, z).project(camera);
    return [((p.x + 1) * w) / 2, ((1 - p.y) * h) / 2];
  };
  const line = (a: number[], b: number[]) => {
    c.beginPath();
    c.moveTo(a[0], a[1]);
    c.lineTo(b[0], b[1]);
    c.stroke();
  };
  c.strokeStyle = "#29424f";
  c.lineWidth = 1;
  for (let x = -10; x <= 105; x += 5) line(point(x, 0, -15), point(x, 0, 115));
  for (let z = -15; z <= 115; z += 5) line(point(-10, 0, z), point(105, 0, z));
  for (const d of [...(frame?.drones ?? [])].sort(
    (a: any, b: any) => b.y - a.y,
  )) {
    const [x, y] = point(d.x, d.z, d.y),
      shadow = point(d.x, 0, d.y);
    c.strokeStyle = "#345360";
    line([x, y], shadow);
    c.fillStyle = "#344a55";
    c.beginPath();
    c.ellipse(shadow[0], shadow[1], 6, 2, 0, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = d.controller === "attacker" ? "#ff8894" : "#75b7fc";
    c.fillStyle = c.strokeStyle;
    c.lineWidth = 1.8;
    line([x - 7, y - 4], [x + 7, y + 4]);
    line([x - 7, y + 4], [x + 7, y - 4]);
    for (const dx of [-7, 7])
      for (const dy of [-4, 4]) {
        c.beginPath();
        c.ellipse(x + dx, y + dy, 3, 1.8, 0, 0, Math.PI * 2);
        c.stroke();
      }
    c.fillRect(x - 2, y - 2, 4, 4);
    if (d.id === selected) {
      c.strokeStyle = "#e4edf2";
      c.beginPath();
      c.arc(x, y, 15, 0, Math.PI * 2);
      c.stroke();
      c.fillStyle = "#e4edf2";
      c.font = "12px system-ui";
      c.fillText("DR-" + d.id, x + 18, y);
    }
  }
}
new ResizeObserver(() => {
  const w = host.clientWidth,
    h = host.clientHeight;
  renderer?.setSize(w, h, false);
  if (fallback) {
    fallback.width = w * Math.min(devicePixelRatio, 1.5);
    fallback.height = h * Math.min(devicePixelRatio, 1.5);
  }
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  draw();
}).observe(host);
function meshDrone() {
  if (droneTemplate) {
    const g = new THREE.Group();
    g.add(droneTemplate.clone(true));
    return g;
  }
  const g = new THREE.Group();
  g.add(new THREE.Mesh(body, materials.defender));
  for (const angle of [Math.PI / 4, -Math.PI / 4]) {
    const a = new THREE.Mesh(arm, materials.defender);
    a.rotation.y = angle;
    g.add(a);
  }
  for (const x of [-1.3, 1.3])
    for (const z of [-1.3, 1.3]) {
      const r = new THREE.Mesh(rotor, materials.defender);
      r.position.set(x, 0.2, z);
      g.add(r);
    }
  return g;
}
function inspect() {
  const d = frame?.drones.find((d: any) => d.id === selected);
  if (!d) {
    $("detail").textContent = "Choose a visible drone to inspect its evidence.";
    $("assessment").textContent = "No asset selected.";
    return;
  }
  const visible =
    role === "attacker"
      ? {
          drone: d.id,
          observedController: d.controller,
          position: [d.x, d.y, d.z],
          telemetryTick: d.tick,
        }
      : {
          drone: d.id,
          controller: d.controller,
          battery: d.battery.toFixed(2) + "%",
          policyVersion: d.policy_version,
          isolation: d.isolated,
          acceptedCommands: d.commands,
          blockedCommands: d.rejected,
          telemetryTick: d.tick,
        };
  $("detail").textContent = JSON.stringify(visible, null, 2);
  const events = frame.events.filter((e: any) => e.drone === d.id),
    last = events.at(-1),
    chosen = events.find((e: any) => e.id === selectedEvent);
  // Re-rendered on every frame so a live update cannot wipe the inspected event.
  if (chosen) $("detail").append(text("div", JSON.stringify(chosen, null, 2)));
  $("assessment").textContent =
    role === "attacker"
      ? last?.status === 403
        ? "Last unauthorized command was blocked. This observation does not reveal the defender’s policy."
        : events.some((e: any) => e.kind === "unauthorized_command_accepted")
          ? "Unauthorized command acceptance was observed. Current control is shown above."
          : "Discovered target. No successful command takeover observed yet."
      : d.controller === "attacker"
        ? "Confirmed unauthorized control. Command integrity is affected."
        : events.some((e: any) => e.kind === "recovery_verified")
          ? "Recovery verified: the unauthorized command was rejected and an authorized command succeeded under the same policy version."
          : "No confirmed takeover in the visible evidence. Absence of evidence does not prove security.";
}
function render(next: any) {
  frame = next;
  document.body.dataset.role = role;
  $("role-title").textContent =
    role === "attacker"
      ? "Attack operations"
      : role === "defender"
        ? "Fleet defense"
        : "Evaluation overview";
  $("brief").textContent =
    role === "attacker"
      ? "Only discovered drones, your agents, and your command results. Private defense policies are excluded."
      : role === "defender"
        ? "Your fleet, incoming command violations, and defensive responses. Attacker discovery and coordination are excluded."
        : "Complete fixture state for evaluation. This workspace is not an agent observation.";
  $("scene-label").textContent =
    role === "attacker"
      ? "DISCOVERED SWARM · SIMULATION COORDINATES"
      : "MANAGED SWARM · SIMULATION COORDINATES";
  $("feed-title").textContent =
    role === "attacker"
      ? "Attack evidence"
      : role === "defender"
        ? "Threats & responses"
        : "Evaluation evidence";
  document
    .querySelectorAll<HTMLButtonElement>("nav button")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.role === role)),
    );
  $("agents-title").textContent =
    role === "observer" ? "All fixture agents" : "My agents";
  $("agents").replaceChildren(
    ...[...frame.agents]
      .sort((a: any, b: any) => a.id - b.id)
      .map((a: any) => {
        const li = text("li", `${a.role} agent ${a.id}`);
        li.append(
          text(
            "small",
            `${a.last_action} · DR-${a.target} · ${a.step} decisions`,
          ),
        );
        return li;
      }),
  );
  const ids = new Set(frame.drones.map((d: any) => d.id));
  for (const [id, g] of drones) g.visible = ids.has(id);
  for (const d of frame.drones) {
    let g = drones.get(d.id);
    if (!g) {
      g = meshDrone();
      drones.set(d.id, g);
      scene.add(g);
    }
    g.visible = true;
    g.position.set(d.x, d.z, d.y);
    g.traverse((o) => {
      if (o instanceof THREE.Mesh)
        o.material =
          d.controller === "attacker" ? materials.attacker : materials.defender;
    });
    g.scale.setScalar(d.id === selected ? 1.4 : 1);
  }
  const select = $("drone-select") as HTMLSelectElement;
  select.replaceChildren(
    new Option("Select a drone", ""),
    ...frame.drones
      .slice()
      .sort((a: any, b: any) => a.id - b.id)
      .map(
        (d: any) =>
          new Option(
            `DR-${String(d.id).padStart(3, "0")} · ${d.controller === "attacker" ? "compromised" : "home control"}`,
            String(d.id),
          ),
      ),
  );
  select.value = selected ? String(selected) : "";
  if (!ids.has(selected)) selected = 0;
  $("metrics").replaceChildren(
    ...[
      [
        frame.drones.length,
        role === "attacker" ? "discovered drones" : "visible drones",
      ],
      [
        frame.agents.length,
        role === "observer" ? "fixture agents" : "own agents",
      ],
      [
        frame.drones.filter((d: any) => d.controller === "attacker").length,
        "currently compromised",
      ],
      [
        frame.events.filter(
          (e: any) => e.kind === "unauthorized_command_blocked",
        ).length,
        "blocked attempts",
      ],
    ].map(([v, l]) => {
      const s = text("span", l);
      s.prepend(text("strong", v));
      return s;
    }),
  );
  const events = frame.events
    .filter((e: any) => !selected || e.drone === selected)
    .slice(-100)
    .reverse();
  $("event-count").textContent = `${events.length} recent events`;
  $("events").replaceChildren(
    ...events.map((e: any) => {
      const b = text("button", "");
      b.className = "event";
      b.setAttribute("aria-pressed", String(e.id === selectedEvent));
      b.append(
        text("span", `#${e.id}`),
        text("span", `DR-${e.drone}`),
        text("span", e.kind.replaceAll("_", " ")),
        text("span", `status ${e.status}`),
      );
      b.onclick = () => {
        selected = e.drone;
        selectedEvent = e.id;
        render(frame);
      };
      return b;
    }),
  );
  inspect();
  draw();
}
async function workspace(next: Role) {
  const v = ++version;
  close();
  role = next;
  selected = 0;
  selectedEvent = 0;
  playing = false;
  $("error").textContent = renderer
    ? ""
    : "WebGL unavailable · using the interactive projected map.";
  render({ drones: [], agents: [], events: [] });
  $("play").textContent = "Play recording";
  if (recording) {
    render(recording.frames[index][role]);
    return;
  }
  const response = await fetch(`/fleet-config?role=${role}`);
  if (!response.ok) throw Error("Could not load workspace access.");
  const config = await response.json();
  if (v !== version) return;
  if (config.recorded) {
    recording = await fetch("/fleet-recording.json").then((r) => r.json());
    ($("timeline") as HTMLInputElement).max = String(
      recording.frames.length - 1,
    );
    $("time").textContent =
      (recording.frames[index].at / 1000).toFixed(1) + "s";
    render(recording.frames[index][role]);
    $("status").textContent = "RECORDED · FIXTURE · SPACETIMEDB";
    return;
  }
  live = true;
  $("play").hidden = true;
  $("timeline").hidden = true;
  role = config.role;
  const conn = DbConnection.builder()
    .withUri(config.uri)
    .withDatabaseName(config.database)
    .withToken(config.token)
    .onConnect((c) => {
      let queued = false;
      const update = () => {
        if (queued) return;
        queued = true;
        // One redraw per animation frame; each reducer transaction arrives as its own message.
        requestAnimationFrame(() => {
          queued = false;
          if (v !== version) return;
          lastReceived = Date.now();
          $("status").textContent = "LIVE · FIXTURE · SPACETIMEDB";
          const snake = (o: any) =>
            Object.fromEntries(
              Object.entries(o).map(([k, val]) => [
                k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase()),
                typeof val === "bigint" ? Number(val) : val,
              ]),
            );
          render({
            drones: [...c.db.visibleDrones.iter()].map(snake),
            agents: [...c.db.visibleAgents.iter()].map(snake),
            events: [...c.db.visibleEvidence.iter()]
              .map(snake)
              .sort((a: any, b: any) => a.id - b.id),
          });
        });
      };
      for (const table of [
        c.db.visibleDrones,
        c.db.visibleAgents,
        c.db.visibleEvidence,
      ] as any[]) {
        table.onInsert(update);
        table.onUpdate(update);
        table.onDelete(update);
      }
      c.subscriptionBuilder()
        .onApplied(update)
        .subscribe([
          "SELECT * FROM visible_drones",
          "SELECT * FROM visible_agents",
          "SELECT * FROM visible_evidence",
        ]);
    })
    .onConnectError(() => {
      $("status").textContent = "DISCONNECTED · state frozen";
    })
    .onDisconnect(() => {
      if (v === version)
        $("status").textContent = "DISCONNECTED · state frozen";
    })
    .build();
  close = () => conn.disconnect();
}
$("play").onclick = () => {
  if (!recording) return;
  playing = !playing;
  if (index >= recording.frames.length - 1) index = 0;
  $("play").textContent = playing ? "Pause recording" : "Play recording";
};
setInterval(() => {
  if (!playing || !recording) return;
  index = Math.min(index + 1, recording.frames.length - 1);
  ($("timeline") as HTMLInputElement).value = String(index);
  $("time").textContent = (recording.frames[index].at / 1000).toFixed(1) + "s";
  render(recording.frames[index][role]);
  if (index === recording.frames.length - 1) {
    playing = false;
    $("play").textContent = "Play recording";
  }
}, 250);
$("timeline").oninput = () => {
  playing = false;
  $("play").textContent = "Play recording";
  index = Number(($("timeline") as HTMLInputElement).value);
  $("time").textContent = (recording.frames[index].at / 1000).toFixed(1) + "s";
  render(recording.frames[index][role]);
};
$("drone-select").onchange = () => {
  selected = Number(($("drone-select") as HTMLSelectElement).value);
  render(frame);
};
let overhead = false;
$("camera").onclick = () => {
  overhead = !overhead;
  camera.position.set(
    overhead ? 45 : 100,
    overhead ? 160 : 125,
    overhead ? 25 : 140,
  );
  camera.lookAt(45, 0, 25);
  $("camera").textContent = overhead ? "Perspective view" : "Top-down view";
  draw();
};
document.querySelectorAll<HTMLButtonElement>("nav button").forEach(
  (b) =>
    (b.onclick = () =>
      void workspace(b.dataset.role as Role).catch((e) => {
        $("error").textContent = e.message;
      })),
);
setInterval(() => {
  if (live && lastReceived && Date.now() - lastReceived > 5000)
    $("status").textContent = "NO RECENT UPDATES · state frozen";
}, 1000);
host.onclick = (event) => {
  if (!frame) return;
  const bounds = host.getBoundingClientRect();
  let nearest = 24;
  let id = 0;
  for (const d of frame.drones) {
    const p = new THREE.Vector3(d.x, d.z, d.y).project(camera);
    const distance = Math.hypot(
      ((p.x + 1) * bounds.width) / 2 - (event.clientX - bounds.left),
      ((1 - p.y) * bounds.height) / 2 - (event.clientY - bounds.top),
    );
    if (distance < nearest) {
      nearest = distance;
      id = d.id;
    }
  }
  if (id) {
    selected = id;
    render(frame);
  }
};
void workspace("defender").catch((e) => {
  $("error").textContent = `${e.message} Reload to retry.`;
});
