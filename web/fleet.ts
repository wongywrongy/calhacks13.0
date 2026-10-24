import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
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
  for (const e of ev)
    if (e.kind === ACCEPTED || e.kind === BLOCKED)
      lastViolation.set(e.drone, e.kind);
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
const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 500);
camera.position.set(100, 125, 140);
camera.lookAt(45, 0, 25);
let fallback: HTMLCanvasElement | undefined;
let renderer: THREE.WebGLRenderer | undefined;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  host.append(renderer.domElement);
} catch {
  fallback = document.createElement("canvas");
  host.append(fallback);
}
const webglNote = renderer ? "" : "WebGL unavailable · using the interactive projected map.";
scene.add(new THREE.HemisphereLight(0xcceaff, 0x17232a, 2));
const light = new THREE.DirectionalLight(0xffffff, 2);
light.position.set(30, 60, 20);
scene.add(light);
const ground = new THREE.Mesh(
  new THREE.BoxGeometry(115, 0.5, 125),
  new THREE.MeshStandardMaterial({ color: 0x0a1620, roughness: 1 }),
);
ground.position.set(45, -1, 40);
scene.add(ground);
const grid = new THREE.GridHelper(120, 24, 0x242e3a, 0x182227);
grid.position.set(45, -0.7, 40);
scene.add(grid);
const body = new THREE.BoxGeometry(1.8, 0.6, 1.1),
  arm = new THREE.BoxGeometry(3.8, 0.18, 0.16),
  rotor = new THREE.CylinderGeometry(0.6, 0.6, 0.09, 12);
const mat = (color: number) =>
  new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.45 });
const materials = {
  red: mat(0xf02d38),
  blue: mat(0x5b9dff),
  green: mat(0x2bd47f),
  grey: mat(0xa9b4c1),
  dim: mat(0x4a545f),
};
const ringGeo = new THREE.RingGeometry(2.4, 2.8, 32).rotateX(-Math.PI / 2);
const ringMat = {
  red: new THREE.MeshBasicMaterial({ color: 0xf02d38, side: THREE.DoubleSide, transparent: true }),
  amber: new THREE.MeshBasicMaterial({ color: 0xe8b04f, side: THREE.DoubleSide, transparent: true }),
};
const isoGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(5, 2.4, 5));
const isoMat = new THREE.LineDashedMaterial({ color: 0xc2cad4, dashSize: 0.6, gapSize: 0.5 });
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
let pulseFrame = 0;
let pulseK = 1;
function pulse() {
  pulseFrame = 0;
  if (reduced.matches) return;
  let any = false;
  pulseK = 1.2 + 0.4 * Math.sin(performance.now() / 260);
  for (const g of drones.values()) {
    const ring = g.userData.ring as THREE.Mesh;
    if (!g.visible || !ring.visible) continue;
    any = true;
    ring.scale.setScalar(pulseK);
    (ring.material as THREE.MeshBasicMaterial).opacity = 1.7 - pulseK;
  }
  if (!any) return;
  draw();
  pulseFrame = requestAnimationFrame(pulse);
}
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
  c.strokeStyle = "#182227";
  c.lineWidth = 1;
  for (let x = -10; x <= 105; x += 5) line(point(x, 0, -15), point(x, 0, 115));
  for (let z = -15; z <= 115; z += 5) line(point(-10, 0, z), point(105, 0, z));
  for (const d of [...frame.drones].sort((a, b) => b.y - a.y)) {
    const g = drones.get(d.id);
    const color = "#" + ((g?.userData.color as THREE.MeshStandardMaterial) ?? materials.grey).color.getHexString();
    const [x, y] = point(d.x, d.z, d.y),
      shadow = point(d.x, 0, d.y);
    c.strokeStyle = "#1c2a33";
    line([x, y], shadow);
    c.fillStyle = "#1c2a33";
    c.beginPath();
    c.ellipse(shadow[0], shadow[1], 6, 2, 0, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = c.fillStyle = color;
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
    const ring = g?.userData.ring as THREE.Mesh | undefined;
    if (ring?.visible) {
      c.strokeStyle = "#" + (ring.material as THREE.MeshBasicMaterial).color.getHexString();
      c.lineWidth = 1.5;
      c.beginPath();
      c.arc(x, y, 11 * pulseK, 0, Math.PI * 2);
      c.stroke();
    }
    if ((g?.userData.iso as THREE.LineSegments | undefined)?.visible) {
      c.strokeStyle = "#c2cad4";
      c.setLineDash([3, 3]);
      c.strokeRect(x - 18, y - 18, 36, 36);
      c.setLineDash([]);
    }
    if (d.id === selected) {
      c.strokeStyle = "#e8eef6";
      c.lineWidth = 1.5;
      c.beginPath();
      c.arc(x, y, 16, 0, Math.PI * 2);
      c.stroke();
      c.fillStyle = "#e8eef6";
      c.font = "12px JetBrains Mono, monospace";
      c.fillText(tag(d.id), x + 19, y);
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
  const g = new THREE.Group();
  if (droneTemplate) g.add(droneTemplate.clone(true));
  else {
    g.add(new THREE.Mesh(body, materials.blue));
    for (const angle of [Math.PI / 4, -Math.PI / 4]) {
      const a = new THREE.Mesh(arm, materials.blue);
      a.rotation.y = angle;
      g.add(a);
    }
    for (const x of [-1.3, 1.3])
      for (const z of [-1.3, 1.3]) {
        const r = new THREE.Mesh(rotor, materials.blue);
        r.position.set(x, 0.2, z);
        g.add(r);
      }
  }
  const ring = new THREE.Mesh(ringGeo, ringMat.red);
  ring.name = "ring";
  const iso = new THREE.LineSegments(isoGeo, isoMat);
  iso.computeLineDistances();
  iso.name = "iso";
  g.add(ring, iso);
  g.userData = { ring, iso, color: materials.blue };
  return g;
}
function mapScene(d: Derived) {
  const ids = new Set(frame.drones.map((x) => x.id));
  for (const [id, g] of drones) g.visible = ids.has(id);
  for (const x of frame.drones) {
    let g = drones.get(x.id);
    if (!g) {
      g = meshDrone();
      drones.set(x.id, g);
      scene.add(g);
    }
    g.visible = true;
    g.position.set(x.x, x.z, x.y);
    const st = d.state(x);
    const color =
      st === "comp"
        ? materials.red
        : st === "rec"
          ? role === "attacker" ? materials.dim : materials.green
          : role === "attacker" ? materials.grey : materials.blue;
    g.userData.color = color;
    g.traverse((o) => {
      if (o instanceof THREE.Mesh && o.name !== "ring") o.material = color;
    });
    const ring = g.userData.ring as THREE.Mesh;
    // Only compromised and blocked drones pulse.
    const blockedLast = d.lastViolation.get(x.id) === BLOCKED;
    ring.visible = st === "comp" || blockedLast;
    ring.material = st === "comp" ? ringMat.red : ringMat.amber;
    (g.userData.iso as THREE.LineSegments).visible = role !== "attacker" && x.isolated;
    g.scale.setScalar(x.id === selected ? 1.4 : 1);
  }
  if (!ids.has(selected)) selected = 0;
  fit();
  if (!pulseFrame) pulse();
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
    legend([["#F02D38", "Seized"], ["#A9B4C1", "Home control"], ["ring", "Last command blocked"]]);
  } else {
    $("map-title").textContent = role === "defender" ? `Managed swarm · ${n}` : `Full state · ${n}`;
    legend([
      ["#5B9DFF", "Home"],
      ["#F02D38", role === "defender" ? "Compromised" : "Unauthorized"],
      ["#2BD47F", "Recovered"],
      ["ring", "Blocked violation"],
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
  draw();
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
// Frame the visible fleet; a 48-drone run and a 256-drone run span very different areas.
function fit() {
  const key = `${frame.drones.length}:${overhead}`;
  if (key === fitted || !frame.drones.length) return;
  fitted = key;
  const xs = frame.drones.map((d) => d.x),
    ys = frame.drones.map((d) => d.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2,
    cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const span = Math.max(40, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  if (overhead) camera.position.set(cx, span * 0.95, cy + 0.01);
  else camera.position.set(cx + span * 0.2, span * 0.5, cy + span * 0.65);
  camera.lookAt(cx, 0, cy);
}
$("camera").onclick = () => {
  overhead = !overhead;
  $("camera").textContent = overhead ? "Perspective" : "Top-down";
  fit();
  draw();
};
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
host.onclick = (event) => {
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
  if (id) pull(id);
};
void workspace("defender").catch((e) => {
  $("error").textContent = `${e.message} Reload to retry.`;
});
