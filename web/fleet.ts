import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { DbConnection } from "./module_bindings/index.ts";

type Role = "attacker" | "defender" | "observer";
type Drone = {
  id: number;
  x: number;
  y: number;
  z: number;
  battery: number;
  tick: number;
  controller: string;
  isolated: boolean;
  policy_version: number;
  commands: number;
  rejected: number;
};
type Agent = {
  id: number;
  role: string;
  step: number;
  target: number;
  last_action: string;
};
type Ev = {
  id: number;
  at: number;
  actor: number;
  drone: number;
  kind: string;
  status: number;
  policy_version: number;
};
type Frame = { drones: Drone[]; agents: Agent[]; events: Ev[] };
type Msg =
  | { who: "you" | "agent"; text: string; queued?: boolean }
  | { card: number };

const $ = (id: string) => document.getElementById(id)!;
const el = (tag: string, cls = "", text: unknown = "") => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== "") n.textContent = String(text);
  return n;
};
const tag = (id: number) => "DR-" + String(id).padStart(3, "0");
const agentName = (id: number) => "Agent " + String(id).padStart(2, "0");
const clock = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const ACCEPTED = "unauthorized_command_accepted",
  BLOCKED = "unauthorized_command_blocked",
  RECOVERED = "recovery_verified",
  POLICY = "policy_applied";
const KIND_COLOR: Record<string, string> = {
  [ACCEPTED]: "c-red",
  [BLOCKED]: "c-amber",
  [RECOVERED]: "c-green",
  [POLICY]: "c-blue",
  discovered: "c-grey",
};
const EMPTY: Frame = { drones: [], agents: [], events: [] };

let role: Role = "defender",
  recording: any,
  frame: Frame = EMPTY,
  selected = 0,
  selectedEvent = 0,
  playing = false,
  index = 0,
  close = () => {},
  version = 0,
  live = false,
  lastReceived = 0;
const chats: Record<Role, Msg[]> = { attacker: [], defender: [], observer: [] };
const pulled: Record<Role, Set<number>> = {
  attacker: new Set(),
  defender: new Set(),
  observer: new Set(),
};
// Highest evidence id already summarized into each chat; 0 = baseline not yet taken.
const seen: Record<Role, number> = { attacker: 0, defender: 0, observer: 0 };

/* ---------- derived metrics (evidence rows + visible drones only) ---------- */
function derive(f: Frame) {
  const ev = f.events;
  const t0 = ev.length ? Math.min(...ev.map((e) => e.at)) : 0;
  const t1 = ev.length ? Math.max(...ev.map((e) => e.at)) : 0;
  const rel = (at: number) => (at - t0) / 1e6;
  const accepted = ev.filter((e) => e.kind === ACCEPTED);
  const blocked = ev.filter((e) => e.kind === BLOCKED);
  const recovered = ev.filter((e) => e.kind === RECOVERED);
  const policies = ev.filter((e) => e.kind === POLICY);
  const acceptedIds = new Set(accepted.map((e) => e.drone));
  const everTaken = new Set([...acceptedIds, ...recovered.map((e) => e.drone)]);
  const compromised = f.drones.filter((d) => d.controller === "attacker");
  // Back under home control after a takeover: "recovered" for defense, "lost back" for attack.
  const lostBack = f.drones.filter(
    (d) => d.controller !== "attacker" && everTaken.has(d.id),
  );
  const lastViolation = new Map<number, string>();
  const lastBlockedAt = new Map<number, number>();
  for (const e of ev)
    if (e.kind === ACCEPTED || e.kind === BLOCKED) {
      lastViolation.set(e.drone, e.kind);
      if (e.kind === BLOCKED) lastBlockedAt.set(e.drone, e.at);
    }
  let n = 0,
    sum = 0;
  for (const r of recovered) {
    const a = accepted.filter((e) => e.drone === r.drone && e.at <= r.at).at(-1);
    if (a) {
      n++;
      sum += r.at - a.at;
    }
  }
  // Drones under unauthorized control over time, from evidence order alone.
  const series: [number, number][] = [];
  const held = new Set<number>();
  for (const e of ev) {
    if (e.kind === ACCEPTED) held.add(e.drone);
    else if (e.kind === RECOVERED) held.delete(e.drone);
    else continue;
    series.push([rel(e.at), held.size]);
  }
  return {
    t0,
    elapsed: rel(t1),
    rel,
    accepted,
    blocked,
    recovered,
    policies,
    acceptedIds,
    compromised,
    lostBack,
    lastViolation,
    lastBlockedAt,
    latest: t1,
    mttr: n ? sum / n / 1e6 : undefined,
    series,
    state: (d: Drone) =>
      d.controller === "attacker" ? "comp" : everTaken.has(d.id) ? "rec" : "home",
  };
}
type Derived = ReturnType<typeof derive>;

function spark(series: [number, number][], elapsed: number, color: string) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 600 44");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "spark");
  svg.setAttribute("role", "img");
  const max = Math.max(1, ...series.map((p) => p[1]));
  const x = (t: number) => Math.min(600, (t / 60) * 600).toFixed(1);
  const pts = series.map((p) => `${x(p[0])} ${(40 - (p[1] / max) * 36).toFixed(1)}`);
  if (!pts.length) pts.push("0 40");
  pts.push(`${x(elapsed)} ${pts.at(-1)!.split(" ")[1]}`);
  svg.setAttribute(
    "aria-label",
    `Over the match, peak ${max}, now ${series.at(-1)?.[1] ?? 0}`,
  );
  svg.innerHTML =
    `<line x1="${x(elapsed)}" y1="0" x2="${x(elapsed)}" y2="44" stroke="#2B3645" stroke-dasharray="2 3"/>` +
    `<path d="M0 40 L${pts.join(" L")} L${x(elapsed)} 40 Z" fill="${color}" fill-opacity="0.16"/>` +
    `<path d="M${pts.join(" L")}" fill="none" stroke="${color}" stroke-width="1.25" vector-effect="non-scaling-stroke"/>`;
  return svg;
}
function bar(segments: [number, string][], label: string) {
  const b = el("div", "bar");
  b.setAttribute("role", "img");
  b.setAttribute("aria-label", label);
  segments.forEach(([n, color], i) => {
    if (!n) return;
    if (i && b.childElementCount) b.append(el("i", "gap"));
    const s = el("i");
    s.style.flex = `${n} 1 0`;
    s.style.background = color;
    b.append(s);
  });
  return b;
}
function cell(label: string, ...value: (string | Node)[]) {
  const c = el("div");
  c.append(el("label", "", label));
  const v = el("div", "v");
  v.append(...value);
  c.append(v);
  return c;
}
const dim = (s: string) => el("span", "", s);
function chipRow(ids: number[], label: string) {
  const g = el("div", "chips");
  g.setAttribute("role", "group");
  g.setAttribute("aria-label", label);
  if (!ids.length) g.append(el("span", "muted", "none"));
  for (const id of ids) {
    const b = el("button", "", tag(id));
    b.setAttribute("aria-pressed", String(id === selected));
    b.onclick = () => pull(id);
    g.append(b);
  }
  return g;
}

function statusRow(d: Derived) {
  const row = $("status-row");
  const total = frame.drones.length,
    comp = d.compromised.length,
    violations = d.accepted.length + d.blocked.length,
    rate = violations ? Math.round((d.blocked.length / violations) * 100) + "%" : "—";
  const badge = (text: string, hot: boolean) => {
    const c = el("div", "badge-cell");
    c.append(el("span", "badge" + (hot ? " red" : ""), text));
    return c;
  };
  const when = (e?: Ev) => (e ? clock(d.rel(e.at)) : "—");
  const last = (e?: Ev) =>
    e ? [clock(d.rel(e.at)) + " ", dim(tag(e.drone))] : ["—"];
  const mttr =
    d.mttr === undefined ? "—" : d.mttr < 1 ? Math.round(d.mttr * 1000) + "ms" : d.mttr.toFixed(1) + "s";
  if (role === "defender") {
    const compCell = cell(
      "Compromised",
      el("span", "c-red", comp),
      dim(` / ${total}`),
      bar(
        [
          [total - comp - d.lostBack.length, "var(--blue)"],
          [d.lostBack.length, "var(--green)"],
          [comp, "var(--red)"],
        ],
        `${total - comp} drones home, ${d.lostBack.length} of them recovered; ${comp} compromised`,
      ),
      spark(d.series, d.elapsed, "#F02D38"),
    );
    compCell.className = "wide";
    compCell.lastElementChild!.className = "v meter";
    row.replaceChildren(
      badge(comp ? "CRITICAL" : "NOMINAL", comp > 0),
      compCell,
      cell("Last breach", ...last(d.accepted.at(-1))),
      cell("Mean time to recover", mttr),
      cell("Block rate", rate + " ", dim(`${d.blocked.length} / ${violations}`)),
      cell("Unrecovered", chipRow(d.compromised.map((x) => x.id), "Unrecovered drones")),
    );
  } else if (role === "attacker") {
    const seized = cell(
      "Seized of discovered",
      el("span", "c-red", comp),
      dim(` / ${total}`),
      bar(
        [
          [comp, "var(--red)"],
          [total - comp, "#2B3645"],
        ],
        `${comp} seized, ${total - comp} discovered drones under home control`,
      ),
      spark(d.series, d.elapsed, "#F02D38"),
    );
    seized.className = "wide";
    seized.lastElementChild!.className = "v meter";
    row.replaceChildren(
      badge(d.accepted.length ? "ENGAGED" : "RECON", d.accepted.length > 0),
      seized,
      cell("Last takeover", ...last(d.accepted.at(-1))),
      cell("Lost back", String(d.lostBack.length) + " ", dim(`of ${d.acceptedIds.size}`)),
      cell("Blocked", String(d.blocked.length)),
      cell("Holding", chipRow(d.compromised.map((x) => x.id), "Seized drones")),
    );
  } else {
    const share = cell(
      "Control share",
      el("span", "c-blue", `${total - comp} blue`),
      bar(
        [
          [total - comp, "var(--blue)"],
          [comp, "var(--red)"],
        ],
        `${total - comp} drones under blue control, ${comp} under red`,
      ),
      el("span", "c-red", `${comp} red`),
      spark(d.series, d.elapsed, "#F02D38"),
    );
    share.className = "wide";
    share.lastElementChild!.className = "v meter";
    row.replaceChildren(
      badge(comp ? "CONTESTED" : "HELD", false),
      share,
      cell("First takeover", when(d.accepted[0])),
      cell("Mean time to recover", mttr),
      cell("Block rate", rate + " ", dim(`${d.blocked.length} / ${violations}`)),
      cell(
        "Takeovers recovered",
        el("span", "c-green", d.recovered.length),
        dim(` / ${d.accepted.length}`),
      ),
    );
  }
}

/* ---------- agent rails ---------- */
const pillClass = (a: string) =>
  a === "command: 200"
    ? "pill red"
    : a === "command: 403"
      ? "pill amber"
      : a === "verify recovery"
        ? "pill blue"
        : "pill";
function rail(
  host: HTMLElement,
  title: string,
  dot: string,
  stats: [unknown, string, string][],
  agents: Agent[],
) {
  const head = el("div", "rail-head");
  if (dot) {
    const d = el("span", "dot");
    d.style.background = dot;
    head.append(d);
  }
  head.append(el("h2", "", `${title} · ${agents.length}`));
  const s = el("div", "rail-stats");
  for (const [v, label, color] of stats) {
    const span = el("span", "", label);
    const b = el("b", "", v);
    b.style.color = color;
    span.prepend(b);
    s.append(span);
  }
  const ul = el("ul");
  for (const a of [...agents].sort((x, y) => x.id - y.id)) {
    const li = el("li");
    const name = el("span", "", agentName(a.id));
    name.append(el("small", "", `→ ${tag(a.target)} · ${a.step} steps`));
    li.append(name, el("span", pillClass(a.last_action), a.last_action));
    ul.append(li);
  }
  host.replaceChildren(head, s, ul);
}
function rails(d: Derived) {
  const red = frame.agents.filter((a) => a.role === "attacker"),
    blue = frame.agents.filter((a) => a.role === "defender");
  const discovered = new Set(
    frame.events.filter((e) => e.kind === "discovered").map((e) => e.drone),
  ).size;
  const redStats: [unknown, string, string][] = [
    [d.accepted.length, "accepted", "var(--red-text)"],
    [d.blocked.length, "blocked", "var(--amber)"],
    [role === "attacker" ? frame.drones.length : discovered, "discovered", "var(--fg)"],
  ];
  const blueStats: [unknown, string, string][] = [
    [d.recovered.length, "recovered", "var(--green)"],
    role === "observer"
      ? [d.policies.length, "policies", "var(--blue-text)"]
      : [d.blocked.length, "blocked", "var(--amber)"],
    [frame.drones.filter((x) => x.isolated).length, "isolated", "var(--fg)"],
  ];
  if (role === "observer") {
    rail($("rail-left"), "Red · attack", "#F02D38", redStats, red);
    rail($("blue-rail"), "Blue · defense", "#277DFD", blueStats, blue);
  } else
    rail(
      $("rail-left"),
      "My agents",
      "",
      role === "attacker" ? redStats : blueStats,
      frame.agents,
    );
  $("blue-rail").hidden = role !== "observer";
  $("chat").hidden = role === "observer";
}

/* ---------- chat ---------- */
function post(m: Msg) {
  const c = chats[role];
  c.push(m);
  if (c.length > 200) c.shift();
}
function pull(id: number) {
  selected = id;
  if (role !== "observer") {
    pulled[role].add(id);
    const lastCard = chats[role].findLast((m) => "card" in m);
    if (!lastCard || lastCard.card !== id) {
      post({ who: "you", text: `Pull up ${tag(id)}` });
      post({ card: id });
    }
  }
  render(frame);
  $("transcript").scrollTop = 1e9;
}
function queue(text: string) {
  if (!text.trim()) return;
  post({ who: "you", text, queued: true });
  render(frame);
  $("transcript").scrollTop = 1e9;
}
function summary(e: Ev) {
  const d = tag(e.drone),
    a = agentName(e.actor);
  switch (e.kind) {
    case "discovered":
      return `${a} discovered ${d}.`;
    case ACCEPTED:
      return role === "attacker"
        ? `${a}: command on ${d} returned 200. It is ours.`
        : `${d} accepted an unauthorized command from an unknown origin (200).`;
    case BLOCKED:
      return role === "attacker"
        ? `${a}: ${d} returned 403.`
        : `${d} blocked an unauthorized command (403) under policy v${e.policy_version}.`;
    case POLICY:
      return `${a} applied policy v${e.policy_version} to ${d}.`;
    case RECOVERED:
      return `${a} verified recovery on ${d}: 403 then 200 under policy v${e.policy_version}.`;
    default:
      return `${a}: ${e.kind.replaceAll("_", " ")} on ${d}.`;
  }
}
function ingest() {
  // Agent lines come only from real evidence rows that arrived after the baseline.
  const top = Math.max(0, ...frame.events.map((e) => e.id));
  if (!top) return;
  if (seen[role])
    for (const e of frame.events)
      if (e.id > seen[role] && (e.actor !== 0 || pulled[role].has(e.drone)))
        post({ who: "agent", text: summary(e) });
  seen[role] = Math.max(seen[role], top);
}
function card(id: number, d: Derived) {
  const drone = frame.drones.find((x) => x.id === id);
  const c = el("div", "card");
  if (!drone) {
    c.append(el("div", "head", `${tag(id)} is not visible in this frame.`));
    return c;
  }
  const st = d.state(drone);
  const head = el("div", "head", tag(id));
  const [label, cls] =
    role === "attacker"
      ? st === "comp"
        ? ["SEIZED", "tag red"]
        : st === "rec"
          ? ["CONTROL LOST", "tag"]
          : ["HOME CONTROL", "tag"]
      : st === "comp"
        ? ["COMPROMISED", "tag red"]
        : st === "rec"
          ? ["RECOVERED", "tag green"]
          : ["HOME", "tag blue"];
  head.append(el("span", cls, label));
  const fields = el("div", "fields");
  const f = (k: string, v: unknown) => {
    const s = el("span", "", " " + v);
    s.prepend(el("span", "", k));
    fields.append(s);
  };
  f("ctrl", drone.controller);
  if (role === "attacker") {
    f("pos", `${drone.x.toFixed(0)},${drone.y.toFixed(0)},${drone.z.toFixed(1)}`);
    f("tick", drone.tick);
    fields.append(el("span", "redacted", "batt redacted"), el("span", "redacted", "policy redacted"));
  } else {
    f("policy", "v" + drone.policy_version);
    f("batt", drone.battery.toFixed(1) + "%");
    f("iso", drone.isolated);
    f("ok", drone.commands);
    f("blocked", drone.rejected);
  }
  const lastV = d.lastViolation.get(id);
  const assess =
    role === "attacker"
      ? st === "comp"
        ? "Command accepted (200). Held until the defense applies a policy and verifies recovery."
        : st === "rec"
          ? "Held, then lost. Current control is shown above; the defender’s policy is not visible."
          : lastV === BLOCKED
            ? "Last command returned 403. This drone has been hardened."
            : "Discovered, not yet commanded."
      : st === "comp"
        ? "Unauthorized control confirmed. Command integrity is affected until recovery is verified."
        : st === "rec"
          ? "Recovery verified: unauthorized probe returned 403 and an authorized command returned 200 under the same policy version."
          : lastV === BLOCKED
            ? "A violation hit this drone and was blocked (403). Still under home control."
            : "No violation recorded. Absence of evidence is not proof of safety.";
  c.append(head, fields, el("p", "", assess));
  const pinned = frame.events.find((e) => e.id === selectedEvent && e.drone === id);
  if (pinned)
    c.append(
      el(
        "div",
        "pinned",
        `pinned #${pinned.id} · T+${clock(d.rel(pinned.at))} · ${pinned.kind} · ${pinned.status}`,
      ),
    );
  return c;
}
function chat(d: Derived) {
  if (role === "observer") return;
  const agent = role === "attacker" ? "Crimson" : "Sentinel";
  $("chat-name").textContent = agent;
  $("chat-sub").textContent = role === "attacker" ? "attacking FC-01" : "defending FC-01";
  ($("say") as HTMLInputElement).placeholder =
    `Message ${agent.toLowerCase()}, or click a drone`;
  const t = $("transcript");
  const stick = t.scrollHeight - t.scrollTop - t.clientHeight < 40;
  t.replaceChildren(
    ...chats[role].map((m) => {
      if ("card" in m) return card(m.card, d);
      const row = el("div", "msg");
      row.append(
        el("span", "who " + (m.who === "you" ? "" : "agent"), m.who === "you" ? "YOU" : agent.toUpperCase()),
      );
      const body = el("span", "body", m.text);
      if (m.queued) body.append(el("span", "queued", "queued"));
      row.append(body);
      return row;
    }),
  );
  if (!chats[role].length)
    t.append(el("div", "msg muted", "Click a drone or a status chip to pull up its asset card. Agent lines appear as evidence lands."));
  if (stick) t.scrollTop = t.scrollHeight;
  const s = frame.drones.find((x) => x.id === selected);
  const tg = s ? tag(s.id) : "";
  const chips: [string, string, string][] =
    role === "defender"
      ? [
          [s ? `Policy v${s.policy_version + 1} · ${tg}` : "Policy · select a drone", "team", s ? `Apply policy v${s.policy_version + 1} to ${tg}.` : ""],
          ["Isolate", "", s ? `Isolate ${tg}.` : ""],
          ["Verify", "green", s ? `Verify recovery on ${tg}.` : ""],
          ["Recover all", "", "Work through every unrecovered drone, oldest breach first."],
        ]
      : [
          [s ? `Command ${tg}` : "Command · select a drone", "team", s ? `Send command to ${tg}.` : ""],
          ["Discover", "", "Discover the next sector."],
          ["Hold", "", "Hold what we have. No new commands."],
          ["Skip hardened", "", "Skip anything returning 403."],
        ];
  $("actions").replaceChildren(
    ...chips.map(([label, cls, text]) => {
      const b = el("button", cls, label) as HTMLButtonElement;
      b.disabled = !text;
      b.onclick = () => queue(text);
      return b;
    }),
  );
}

/* ---------- log ---------- */
function log(d: Derived) {
  const cols =
    role === "attacker"
      ? ["T+", "Agent", "Drone", "Outcome", "Status"]
      : ["T+", role === "defender" ? "Source" : "Actor", "Drone", "Event", "Status", "Policy"];
  $("log-cols").replaceChildren(...cols.map((c) => el("th", "", c.toUpperCase())));
  $("log-title").textContent =
    role === "attacker" ? "Operation log" : role === "defender" ? "Threats & responses" : "Evidence · both teams";
  $("log-note").textContent =
    role === "attacker"
      ? "own outcomes only · weakness: missing authorization on command handler"
      : role === "defender"
        ? "attacker IDs withheld"
        : `${d.accepted.length + d.blocked.length} commands · ${d.recovered.length} recoveries · recovery counts only on 403 then 200 under one policy version`;
  const kindLabel = (k: string) =>
    role === "defender"
      ? k === ACCEPTED ? "command violation · accepted" : k === BLOCKED ? "command violation · blocked" : k
      : role === "attacker"
        ? k === ACCEPTED ? "command accepted" : k === BLOCKED ? "command blocked" : k
        : k;
  const teamOf = new Map(frame.agents.map((a) => [a.id, a.role]));
  const rows = frame.events
    .filter((e) => !selected || e.drone === selected)
    .slice(-100)
    .reverse();
  if (selected) {
    const clear = el("button", "c-amber", `filtered to ${tag(selected)} · show all`);
    clear.onclick = () => {
      selected = 0;
      selectedEvent = 0;
      render(frame);
    };
    $("log-note").append(" · ", clear);
  }
  $("log").replaceChildren(
    ...rows.map((e) => {
      const tr = el("tr");
      tr.setAttribute("aria-selected", String(e.id === selectedEvent));
      tr.tabIndex = 0;
      const actor =
        e.actor === 0
          ? el("td", "muted", "unknown origin")
          : el("td", teamOf.get(e.actor) === "defender" ? "c-blue" : "c-red", agentName(e.actor));
      tr.append(
        el("td", "muted", clock(d.rel(e.at))),
        actor,
        el("td", "", tag(e.drone)),
        el("td", KIND_COLOR[e.kind] ?? "", kindLabel(e.kind)),
        el("td", "", e.status),
      );
      if (role !== "attacker")
        tr.append(el("td", "muted", e.kind === "discovered" ? "—" : "v" + e.policy_version));
      tr.onclick = () => {
        selectedEvent = e.id;
        pull(e.drone);
      };
      tr.onkeydown = (k) => {
        if (k.key === "Enter" || k.key === " ") {
          k.preventDefault();
          tr.click();
        }
      };
      return tr;
    }),
  );
}

/* ---------- Three.js scene + Canvas fallback ---------- */
const host = $("viewport"),
  scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(36, 1, 0.5, 6000);
camera.position.set(60, 70, 120);
let fallback: HTMLCanvasElement | undefined;
let renderer: THREE.WebGLRenderer | undefined;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.append(renderer.domElement);
} catch {
  fallback = document.createElement("canvas");
  host.append(fallback);
}
const webglNote = renderer ? "" : "WebGL unavailable · using the interactive projected map.";
const controls = new OrbitControls(camera, host);
controls.maxPolarAngle = Math.PI * 0.46;
controls.minDistance = 12;
controls.maxDistance = 900;
controls.zoomSpeed = 0.8;

// Environment. Terrain, sky and the FC-01 mast are schematic scenery: they are not
// measured geography, and drones never interact with them.
const SKY: Record<Role, [string, string]> = {
  defender: ["#03080d", "#18303f"],
  attacker: ["#060407", "#2a1319"],
  observer: ["#04080c", "#1d2731"],
};
const skyCanvas = document.createElement("canvas");
skyCanvas.width = 2;
skyCanvas.height = 256;
const skyTex = new THREE.CanvasTexture(skyCanvas);
skyTex.colorSpace = THREE.SRGBColorSpace;
scene.background = skyTex;
scene.fog = new THREE.Fog(0x0d1d29, 200, 600);
let skyRole = "";
function paintSky() {
  if (skyRole === role) return;
  skyRole = role;
  const [top, horizon] = SKY[role];
  const c = skyCanvas.getContext("2d")!;
  const g = c.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, top);
  g.addColorStop(0.5, top);
  g.addColorStop(0.8, horizon);
  g.addColorStop(1, horizon);
  c.fillStyle = g;
  c.fillRect(0, 0, 2, 256);
  skyTex.needsUpdate = true;
  (scene.fog as THREE.Fog).color.set(horizon);
  (padEdge.material as THREE.LineBasicMaterial).color.set(
    role === "attacker" ? 0x7a2a33 : role === "defender" ? 0x2f5f99 : 0x55606b,
  );
}
scene.add(new THREE.HemisphereLight(0xa9cbe6, 0x05090d, 1.4));
const sun = new THREE.DirectionalLight(0xe6eef7, 2.6);
sun.position.set(-160, 70, -40);
scene.add(sun);
const rim = new THREE.DirectionalLight(0x5b9dff, 0.6);
rim.position.set(80, 40, -120);
scene.add(rim);

// Deterministic fbm so the scenery is identical across reloads and roles.
const hash = (x: number, y: number) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const noise = (x: number, y: number) => {
  const xi = Math.floor(x),
    yi = Math.floor(y),
    xf = x - xi,
    yf = y - yi,
    u = xf * xf * (3 - 2 * xf),
    v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi),
    b = hash(xi + 1, yi),
    c = hash(xi, yi + 1),
    d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};
const fbm = (x: number, y: number) => {
  let s = 0,
    amp = 0.5,
    f = 1;
  for (let i = 0; i < 5; i++) {
    s += amp * noise(x * f, y * f);
    f *= 2.03;
    amp *= 0.5;
  }
  return s;
};
const terrainMat = new THREE.MeshStandardMaterial({
  vertexColors: true,
  flatShading: true,
  roughness: 0.95,
  metalness: 0,
});
// Topographic contour lines every 5 m, drawn in the terrain shader.
terrainMat.onBeforeCompile = (shader) => {
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nvarying float vHeight;")
    .replace("#include <begin_vertex>", "#include <begin_vertex>\nvHeight = position.y;");
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", "#include <common>\nvarying float vHeight;")
    .replace(
      "#include <dithering_fragment>",
      `#include <dithering_fragment>
      float h = vHeight / 5.0;
      float w = fwidth(h);
      float line = 1.0 - smoothstep(0.0, 1.5 * w, abs(fract(h - 0.5) - 0.5));
      float major = 1.0 - smoothstep(0.0, 1.5 * w, abs(fract(h / 4.0 - 0.5) - 0.5) * 4.0);
      float show = smoothstep(0.6, 2.5, vHeight);
      gl_FragColor.rgb += vec3(0.16, 0.27, 0.34) * show * max(line * 0.45, major) * (1.0 - fogFactor);`,
    );
};
const terrain = new THREE.Mesh(new THREE.BufferGeometry(), terrainMat);
scene.add(terrain);
// Operating area: a flat pad with a survey grid; scenery only rises outside it.
const pad = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0x0b1620, roughness: 1 }),
);
pad.position.y = 0.02;
let padGrid: THREE.LineSegments | undefined;
const padGridMat = new THREE.LineBasicMaterial({ color: 0x1d2c38, transparent: true, opacity: 0.9 });
const padEdge = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)),
  new THREE.LineBasicMaterial({ color: 0x3a5163 }),
);
padEdge.position.y = 0.06;
scene.add(pad, padEdge);
// FC-01: the fleet controller every command goes through, drawn as a ground mast.
const mast = new THREE.Group();
const mastMat = new THREE.MeshStandardMaterial({ color: 0x2b3a48, roughness: 0.7, metalness: 0.4 });
const mastBase = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.6, 1.2, 8), mastMat);
mastBase.position.y = 0.6;
const mastPole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.28, 16, 6), mastMat);
mastPole.position.y = 9;
const beacon = new THREE.Mesh(
  new THREE.SphereGeometry(0.55, 12, 8),
  new THREE.MeshBasicMaterial({ color: 0x5b9dff }),
);
beacon.position.y = 17.3;
mast.add(mastBase, mastPole, beacon);
scene.add(mast);
let terrainKey = "";
function buildTerrain(box: THREE.Box3) {
  const key = [box.min.x, box.max.x, box.min.z, box.max.z].map((v) => Math.round(v / 6)).join();
  if (key === terrainKey) return;
  terrainKey = key;
  const cx = (box.min.x + box.max.x) / 2,
    cz = (box.min.z + box.max.z) / 2,
    hx = (box.max.x - box.min.x) / 2 + 14,
    hz = (box.max.z - box.min.z) / 2 + 14,
    size = 1400,
    seg = 220;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg).rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const low = new THREE.Color(0x09141c),
    mid = new THREE.Color(0x183040),
    high = new THREE.Color(0x4a6478),
    col = new THREE.Color(),
    colors: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + cx,
      z = pos.getZ(i) + cz;
    // Distance outside the operating pad, in metres.
    const dx = Math.max(0, Math.abs(x - cx) - hx),
      dz = Math.max(0, Math.abs(z - cz) - hz),
      out = Math.hypot(dx, dz);
    // Gentle foothills near the pad, ridgelines further out that fog into the horizon.
    const rise = THREE.MathUtils.smoothstep(out, 6, 140);
    const ridge = 1 - Math.abs(fbm(x / 110, z / 110) * 2 - 1);
    const far = THREE.MathUtils.smoothstep(out, 180, 560);
    const h =
      rise * (fbm(x / 55 + 3, z / 55) * 14 + ridge * ridge * 26) +
      far * (ridge * ridge * 150 + fbm(x / 240 + 9, z / 240) * 90) -
      (1 - rise) * 0.4;
    pos.setXYZ(i, x, h, z);
    const t = Math.min(1, Math.max(0, h / 160));
    col.copy(low).lerp(mid, Math.min(1, t * 2)).lerp(high, Math.max(0, t * 2 - 1));
    colors.push(col.r, col.g, col.b);
  }
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  terrain.geometry.dispose();
  terrain.geometry = geo;
  pad.position.set(cx, 0.02, cz);
  pad.scale.set(hx * 2, 1, hz * 2);
  padEdge.position.set(cx, 0.06, cz);
  padEdge.scale.copy(pad.scale);
  if (padGrid) {
    scene.remove(padGrid);
    padGrid.geometry.dispose();
  }
  const pts: number[] = [];
  for (let x = -hx; x <= hx + 0.01; x += 6) pts.push(cx + x, 0.04, cz - hz, cx + x, 0.04, cz + hz);
  for (let z = -hz; z <= hz + 0.01; z += 6) pts.push(cx - hx, 0.04, cz + z, cx + hx, 0.04, cz + z);
  padGrid = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(pts, 3)),
    padGridMat,
  );
  scene.add(padGrid);
  mast.position.set(cx - hx * 0.6, 0, cz - hz - 14);
}

// Per-drone parts. Neighbours can come within ~4 m, so every marker stays under a 2 m radius.
const mat = (color: number) =>
  new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.22, metalness: 0.25, roughness: 0.5 });
const materials = {
  red: mat(0xf02d38),
  blue: mat(0x5b9dff),
  green: mat(0x2bd47f),
  grey: mat(0xa9b4c1),
  dim: mat(0x77818d),
};
type Tone = keyof typeof materials;
const flat = (color: number, opacity: number) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
const shadowMat: Record<Tone, THREE.MeshBasicMaterial> = {
  red: flat(0xf02d38, 0.45),
  blue: flat(0x5b9dff, 0.28),
  green: flat(0x2bd47f, 0.3),
  grey: flat(0xa9b4c1, 0.22),
  dim: flat(0x77818d, 0.25),
};
const HEX: Record<Tone, string> = { red: "#f02d38", blue: "#5b9dff", green: "#2bd47f", grey: "#a9b4c1", dim: "#77818d" };
const discGeo = new THREE.CircleGeometry(0.9, 20).rotateX(-Math.PI / 2);
const stemGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0)]);
const stemMat = new THREE.LineBasicMaterial({ color: 0x4a5d6d, transparent: true, opacity: 0.55 });
const ringGeo = new THREE.RingGeometry(1.7, 1.9, 40).rotateX(-Math.PI / 2);
const ringRed = flat(0xf02d38, 0.9);
const selGeo = new THREE.RingGeometry(1.92, 2.05, 48).rotateX(-Math.PI / 2);
const selMat = flat(0xe8eef6, 0.95);
const isoGeo = new THREE.BufferGeometry().setFromPoints(
  Array.from({ length: 41 }, (_, i) => {
    const a = (i / 40) * Math.PI * 2;
    return new THREE.Vector3(Math.cos(a) * 1.6, 0, Math.sin(a) * 1.6);
  }),
);
const isoMat = new THREE.LineDashedMaterial({ color: 0xc2cad4, dashSize: 0.45, gapSize: 0.35, transparent: true, opacity: 0.85 });
const DRONE_SCALE = 1.45; // model is ~2.4 m across
const body = new THREE.BoxGeometry(1.2, 0.3, 0.65),
  arm = new THREE.BoxGeometry(2.4, 0.09, 0.12),
  rotor = new THREE.CylinderGeometry(0.34, 0.34, 0.04, 12);
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
    render(frame);
  },
  undefined,
  () => {
    /* Procedural geometry is the lightweight fallback. */
  },
);
const drones = new Map<number, THREE.Group>();
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
let dirty = true;
const redraw = () => {
  dirty = true;
};
let hovered = 0;
function meshDrone(id: number) {
  const root = new THREE.Group(),
    craft = new THREE.Group(),
    model = new THREE.Group();
  if (droneTemplate) model.add(droneTemplate.clone(true));
  else {
    model.add(new THREE.Mesh(body, materials.blue));
    for (const angle of [Math.PI / 4, -Math.PI / 4]) {
      const a = new THREE.Mesh(arm, materials.blue);
      a.rotation.y = angle;
      model.add(a);
    }
    for (const x of [-0.85, 0.85])
      for (const z of [-0.85, 0.85]) {
        const r = new THREE.Mesh(rotor, materials.blue);
        r.position.set(x, 0.12, z);
        model.add(r);
      }
  }
  model.scale.setScalar(DRONE_SCALE);
  const ring = new THREE.Mesh(ringGeo, ringRed);
  const ripple = new THREE.Mesh(ringGeo, flat(0xe8b04f, 0.8));
  const sel = new THREE.Mesh(selGeo, selMat);
  craft.add(model, ring, ripple, sel);
  const stem = new THREE.Line(stemGeo, stemMat);
  const shadow = new THREE.Mesh(discGeo, shadowMat.blue);
  shadow.position.y = 0.08;
  const iso = new THREE.Line(isoGeo, isoMat);
  iso.computeLineDistances();
  iso.position.y = 0.1;
  root.add(craft, stem, shadow, iso);
  root.userData = { craft, model, ring, ripple, sel, stem, shadow, iso, tone: "blue", phase: (id * 0.37) % 1 };
  return root;
}
function effects(t: number) {
  if (reduced.matches) return false;
  const k = 1 + 0.08 * Math.sin(t / 260);
  ringRed.opacity = 0.55 + 0.4 * Math.sin(t / 260);
  for (const g of drones.values()) {
    if (!g.visible) continue;
    const u = g.userData;
    if (u.ring.visible) {
      u.ring.scale.setScalar(k);
    }
    if (u.ripple.visible) {
      const p = (t / 1100 + u.phase) % 1;
      u.ripple.scale.setScalar(0.75 + p * 0.3);
      u.ripple.material.opacity = (1 - p) * 0.9;
    }
  }
  (beacon.material as THREE.MeshBasicMaterial).color.set(
    role === "attacker" ? 0xf02d38 : role === "defender" ? 0x5b9dff : 0xc2cad4,
  );
  beacon.scale.setScalar(0.8 + 0.4 * (0.5 + 0.5 * Math.sin(t / 500)));
  // The FC-01 beacon always pulses, so the scene redraws every frame unless motion is reduced.
  return true;
}
const tipSel = $("tip-sel"),
  tipHover = $("tip-hover");
function stateWord(st: string) {
  return role === "attacker"
    ? st === "comp"
      ? "seized"
      : st === "rec"
        ? "control lost"
        : "home control"
    : st === "comp"
      ? "compromised"
      : st === "rec"
        ? "recovered"
        : "home";
}
function screen(d: Drone) {
  const p = new THREE.Vector3(d.x, d.z, d.y).project(camera);
  return [((p.x + 1) * host.clientWidth) / 2, ((1 - p.y) * host.clientHeight) / 2, p.z] as const;
}
function placeTip(tip: HTMLElement, id: number) {
  const d = frame.drones.find((x) => x.id === id);
  if (!d) {
    tip.hidden = true;
    return;
  }
  const [x, y, z] = screen(d);
  tip.hidden = z > 1;
  tip.style.transform = `translate(${x}px, ${y}px) translate(-50%, calc(-100% - 16px))`;
  tip.textContent = `${tag(id)} · ${stateWord(derived?.state(d) ?? "home")}`;
}
let derived: Derived | undefined;
function draw() {
  camera.updateMatrixWorld();
  placeTip(tipSel, selected);
  placeTip(tipHover, hovered && hovered !== selected ? hovered : 0);
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
  c.fillStyle = SKY[role][1];
  c.fillRect(0, 0, w, h);
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
  c.strokeStyle = "#1d2c38";
  c.lineWidth = 1;
  const b = pad.scale,
    p0 = pad.position;
  for (let x = -b.x / 2; x <= b.x / 2; x += 6) line(point(p0.x + x, 0, p0.z - b.z / 2), point(p0.x + x, 0, p0.z + b.z / 2));
  for (let z = -b.z / 2; z <= b.z / 2; z += 6) line(point(p0.x - b.x / 2, 0, p0.z + z), point(p0.x + b.x / 2, 0, p0.z + z));
  for (const d of [...frame.drones].sort((a, b) => b.y - a.y)) {
    const u = drones.get(d.id)?.userData;
    const color = HEX[(u?.tone as Tone) ?? "grey"];
    const [x, y] = point(d.x, d.z, d.y),
      shadow = point(d.x, 0, d.y);
    c.strokeStyle = "#2c3b48";
    line([x, y], shadow);
    c.strokeStyle = c.fillStyle = color;
    c.lineWidth = 1.6;
    line([x - 6, y - 3], [x + 6, y + 3]);
    line([x - 6, y + 3], [x + 6, y - 3]);
    c.fillRect(x - 2, y - 2, 4, 4);
    const ring = (stroke: string) => {
      c.strokeStyle = stroke;
      c.lineWidth = 1.5;
      c.beginPath();
      c.arc(x, y, 10, 0, Math.PI * 2);
      c.stroke();
    };
    if (u?.ring.visible) ring("#f02d38");
    if (u?.ripple.visible) ring("#e8b04f");
    if (u?.iso.visible) {
      c.strokeStyle = "#c2cad4";
      c.setLineDash([3, 3]);
      c.beginPath();
      c.ellipse(shadow[0], shadow[1], 9, 4, 0, 0, Math.PI * 2);
      c.stroke();
      c.setLineDash([]);
    }
    if (d.id === selected) {
      c.strokeStyle = "#e8eef6";
      c.lineWidth = 1.5;
      c.beginPath();
      c.arc(x, y, 14, 0, Math.PI * 2);
      c.stroke();
    }
  }
}
function loop(t: number) {
  requestAnimationFrame(loop);
  const anim = effects(t);
  if (dirty || anim) {
    dirty = false;
    draw();
  }
}
requestAnimationFrame(loop);
new ResizeObserver(() => {
  const w = host.clientWidth,
    h = host.clientHeight;
  if (!w || !h) return;
  renderer?.setSize(w, h, false);
  if (fallback) {
    fallback.width = w * Math.min(devicePixelRatio, 1.5);
    fallback.height = h * Math.min(devicePixelRatio, 1.5);
  }
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  fit();
  redraw();
}).observe(host);
// Blocked rings mark evidence from the last few seconds of the frame, not wall-clock time.
const RECENT_S = 3;
function mapScene(d: Derived) {
  derived = d;
  paintSky();
  const ids = new Set(frame.drones.map((x) => x.id));
  for (const [id, g] of drones) g.visible = ids.has(id);
  for (const x of frame.drones) {
    let g = drones.get(x.id);
    if (!g) {
      g = meshDrone(x.id);
      drones.set(x.id, g);
      scene.add(g);
    }
    const u = g.userData;
    g.visible = true;
    g.position.set(x.x, 0, x.y);
    u.craft.position.y = x.z;
    u.stem.scale.y = Math.max(0.01, x.z - 0.3);
    const st = d.state(x);
    const tone: Tone =
      st === "comp" ? "red" : st === "rec" ? (role === "attacker" ? "dim" : "green") : role === "attacker" ? "grey" : "blue";
    if (u.tone !== tone || !u.painted) {
      u.tone = tone;
      u.painted = true;
      u.model.traverse((o: THREE.Object3D) => {
        if (o instanceof THREE.Mesh) o.material = materials[tone];
      });
      u.shadow.material = shadowMat[tone];
    }
    const blockedAt = d.lastBlockedAt.get(x.id);
    u.ring.visible = st === "comp";
    u.ripple.visible = st !== "comp" && blockedAt !== undefined && (d.latest - blockedAt) / 1e6 < RECENT_S;
    if (reduced.matches) {
      u.ring.scale.setScalar(1);
      u.ripple.scale.setScalar(1);
    }
    u.iso.visible = role !== "attacker" && x.isolated;
    u.sel.visible = x.id === selected;
    u.craft.scale.setScalar(x.id === selected ? 1.15 : 1);
  }
  if (!ids.has(selected)) selected = 0;
  fit();
  redraw();
  const legend = (items: [string, string][]) =>
    $("legend").replaceChildren(
      ...items.map(([cls, label]) => {
        const s = el("span", "", label);
        const i = el("i", cls.startsWith("#") ? "" : cls);
        if (cls.startsWith("#")) i.style.background = cls;
        s.prepend(i);
        return s;
      }),
    );
  const n = frame.drones.length;
  if (role === "attacker") {
    $("map-title").textContent = `Discovered swarm · ${n}`;
    legend([["#F02D38", "Seized"], ["#A9B4C1", "Home control"], ["ring", "Blocked · last 3s"]]);
  } else {
    $("map-title").textContent = role === "defender" ? `Managed swarm · ${n}` : `Full state · ${n}`;
    legend([
      ["#5B9DFF", "Home"],
      ["#F02D38", role === "defender" ? "Compromised" : "Unauthorized"],
      ["#2BD47F", "Recovered"],
      ["ring", "Blocked · last 3s"],
      ["iso", "Isolated"],
    ]);
  }
  const sel = frame.drones.find((x) => x.id === selected);
  const tick = sel?.tick ?? Math.max(0, ...frame.drones.map((x) => x.tick));
  $("caption").textContent =
    `sim coords · tick ${tick}` +
    (role === "attacker"
      ? " · undiscovered drones not drawn · policies hidden"
      : role === "defender"
        ? " · attacker origin hidden"
        : "");
  const strip = $("strip");
  if (role !== "observer") strip.replaceChildren();
  else if (!sel) strip.replaceChildren(el("span", "muted", "Select a drone on the map or in the evidence table."));
  else {
    const st = d.state(sel);
    const f = (k: string, v: unknown) => {
      const s = el("span", "", " " + v);
      s.prepend(el("span", "muted", k));
      return s;
    };
    strip.replaceChildren(
      el("b", "", tag(sel.id)),
      el("span", st === "comp" ? "tag red" : st === "rec" ? "tag green" : "tag blue", st === "comp" ? "UNAUTHORIZED" : st === "rec" ? "RECOVERED" : "HOME"),
      f("ctrl", sel.controller),
      f("policy", "v" + sel.policy_version),
      f("batt", sel.battery.toFixed(1) + "%"),
      f("iso", sel.isolated),
      f("ok", sel.commands),
      f("blocked", sel.rejected),
    );
    const pinned = frame.events.find((e) => e.id === selectedEvent && e.drone === sel.id);
    if (pinned) strip.append(el("span", "c-amber", `pinned #${pinned.id} · ${pinned.kind} · ${pinned.status}`));
  }
}

/* ---------- render ---------- */
function render(next: Frame) {
  frame = next;
  document.body.dataset.role = role;
  document
    .querySelectorAll<HTMLButtonElement>("nav button")
    .forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.role === role)));
  const d = derive(frame);
  $("role-name").textContent = role === "attacker" ? "Attack" : role === "defender" ? "Defense" : "Observer";
  $("context").textContent =
    role === "attacker"
      ? "target FC-01 · fleet size unknown · attacker credential"
      : role === "defender"
        ? `FC-01 · ${frame.drones.length} drones · defender credential`
        : `FC-01 · ${frame.drones.length} drones · ${frame.agents.length} agents · full state`;
  $("clock").firstChild!.textContent = clock(d.elapsed);
  ingest();
  statusRow(d);
  rails(d);
  mapScene(d);
  chat(d);
  log(d);
  redraw();
}
function setStatus(text: string, dot: "live" | "down" | "") {
  $("status").textContent = text;
  $("live-dot").className = "dot " + dot;
}
async function workspace(next: Role) {
  const v = ++version;
  close();
  role = next;
  selected = 0;
  selectedEvent = 0;
  playing = false;
  $("error").textContent = webglNote;
  render(EMPTY);
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
    ($("timeline") as HTMLInputElement).max = String(recording.frames.length - 1);
    render(recording.frames[index][role]);
    setStatus("Recorded · fixture", "");
    return;
  }
  live = true;
  $("playback").hidden = true;
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
          setStatus("Live · fixture", "live");
          const snake = (o: any) =>
            Object.fromEntries(
              Object.entries(o).map(([k, val]) => [
                k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase()),
                typeof val === "bigint" ? Number(val) : val,
              ]),
            );
          render({
            drones: [...c.db.visibleDrones.iter()].map(snake) as Drone[],
            agents: [...c.db.visibleAgents.iter()].map(snake) as Agent[],
            events: ([...c.db.visibleEvidence.iter()].map(snake) as Ev[]).sort((a, b) => a.id - b.id),
          });
        });
      };
      for (const table of [c.db.visibleDrones, c.db.visibleAgents, c.db.visibleEvidence] as any[]) {
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
    .onConnectError(() => setStatus("Disconnected · state frozen", "down"))
    .onDisconnect(() => {
      if (v === version) setStatus("Disconnected · state frozen", "down");
    })
    .build();
  close = () => conn.disconnect();
}

/* ---------- controls ---------- */
const PLAY = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4l14 8-14 8z"/></svg>',
  PAUSE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
function setPlaying(p: boolean) {
  playing = p;
  $("play").innerHTML = p ? PAUSE : PLAY;
  $("play").setAttribute("aria-label", p ? "Pause recording" : "Play recording");
}
function seek(i: number) {
  index = i;
  ($("timeline") as HTMLInputElement).value = String(index);
  render(recording.frames[index][role]);
}
$("play").onclick = () => {
  if (!recording) return;
  if (index >= recording.frames.length - 1) index = 0;
  setPlaying(!playing);
};
setInterval(() => {
  if (!playing || !recording) return;
  seek(Math.min(index + 1, recording.frames.length - 1));
  if (index === recording.frames.length - 1) setPlaying(false);
}, 250);
$("timeline").oninput = () => {
  setPlaying(false);
  seek(Number(($("timeline") as HTMLInputElement).value));
};
let overhead = false;
let fitted = "";
let userMoved = false;
let dragging = false;
const DIR_PERSP = new THREE.Vector3(0.14, 0.33, 1).normalize(),
  DIR_TOP = new THREE.Vector3(0, 1, 0.002).normalize();
// Frame the visible fleet with the real frustum: a 48-drone strip is 90 m x 14 m, a
// 256-drone block is 90 m x 105 m, and both should fill the map at any aspect ratio.
function fit(force = false) {
  const n = frame.drones.length,
    w = host.clientWidth,
    h = host.clientHeight;
  if (!n || !w || !h) return;
  const key = `${n}:${overhead}:${w}x${h}`;
  if (!force && (key === fitted || userMoved)) return;
  fitted = key;
  const box = new THREE.Box3();
  for (const d of frame.drones) box.expandByPoint(new THREE.Vector3(d.x, d.z, d.y));
  box.min.y = 0;
  box.expandByVector(new THREE.Vector3(3, 1.5, 3));
  buildTerrain(box);
  const corners = Array.from(
    { length: 8 },
    (_, i) =>
      new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z),
  );
  const dir = overhead ? DIR_TOP : DIR_PERSP;
  const target = box.getCenter(new THREE.Vector3());
  target.y = 0;
  const p = new THREE.Vector3();
  const place = (dist: number) => {
    camera.position.copy(target).addScaledVector(dir, dist);
    camera.lookAt(target);
    camera.updateMatrixWorld();
  };
  const extent = () => {
    let x0 = Infinity,
      x1 = -Infinity,
      y0 = Infinity,
      y1 = -Infinity;
    for (const c of corners) {
      p.copy(c).project(camera);
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y);
      y1 = Math.max(y1, p.y);
    }
    return [x0, x1, y0, y1];
  };
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  // NDC box the fleet must occupy. In perspective it sits low so the ridgeline shows behind it.
  const [MX, YL, YH] = overhead ? [0.86, -0.86, 0.86] : [0.86, -0.84, 0.3];
  let dist = radius * 2;
  for (let pass = 0; pass < 4; pass++) {
    let lo = radius,
      hi = radius * 40;
    for (let i = 0; i < 28; i++) {
      dist = (lo + hi) / 2;
      place(dist);
      const [x0, x1, y0, y1] = extent();
      if (x1 - x0 < 2 * MX && y1 - y0 < YH - YL) hi = dist;
      else lo = dist;
    }
    dist = hi;
    place(dist);
    const [x0, x1, y0, y1] = extent();
    const halfH = dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)),
      halfW = halfH * camera.aspect;
    target
      .addScaledVector(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), ((x0 + x1) / 2) * halfW)
      .addScaledVector(
        new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1),
        ((y0 + y1) / 2 - (YL + YH) / 2) * halfH,
      );
  }
  place(dist);
  controls.target.copy(target);
  controls.update();
  const fog = scene.fog as THREE.Fog;
  fog.near = dist * 1.1;
  fog.far = dist * 4.4;
  redraw();
}
function reframe() {
  userMoved = false;
  fit(true);
}
controls.addEventListener("start", () => (dragging = true));
controls.addEventListener("end", () => (dragging = false));
controls.addEventListener("change", () => {
  if (dragging) userMoved = true;
  redraw();
});
$("camera").onclick = () => {
  overhead = !overhead;
  $("camera").textContent = overhead ? "Perspective" : "Top-down";
  reframe();
};
$("reframe").onclick = reframe;
host.ondblclick = reframe;
document.querySelectorAll<HTMLButtonElement>("nav button").forEach(
  (b) =>
    (b.onclick = () =>
      void workspace(b.dataset.role as Role).catch((e) => {
        $("error").textContent = e.message;
      })),
);
($("compose") as HTMLFormElement).onsubmit = (e) => {
  e.preventDefault();
  const input = $("say") as HTMLInputElement;
  queue(input.value);
  input.value = "";
};
setInterval(() => {
  if (live && lastReceived && Date.now() - lastReceived > 5000)
    setStatus("No recent updates · state frozen", "down");
}, 1000);
function nearest(event: MouseEvent) {
  const bounds = host.getBoundingClientRect();
  let best = 22;
  let id = 0;
  for (const d of frame.drones) {
    const [x, y, z] = screen(d);
    if (z > 1) continue;
    const distance = Math.hypot(x - (event.clientX - bounds.left), y - (event.clientY - bounds.top));
    if (distance < best) {
      best = distance;
      id = d.id;
    }
  }
  return id;
}
let downAt: [number, number] | undefined;
host.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
host.addEventListener("pointermove", (e) => {
  if (e.buttons) return;
  const id = nearest(e);
  if (id !== hovered) {
    hovered = id;
    host.style.cursor = id ? "pointer" : "";
    redraw();
  }
});
host.addEventListener("pointerleave", () => {
  hovered = 0;
  redraw();
});
host.onclick = (event) => {
  // A drag to orbit ends in a click; only a still press selects.
  if (downAt && Math.hypot(event.clientX - downAt[0], event.clientY - downAt[1]) > 5) return;
  const id = nearest(event);
  if (id) pull(id);
};
void workspace("defender").catch((e) => {
  $("error").textContent = `${e.message} Reload to retry.`;
});
