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
type Msg = { who: "you" | "agent"; text: string; queued?: boolean };
// An operator command, queued locally at match time `at` (evidence micros).
type Op = { at: number; text: string };

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
  lastReceived = 0,
  filter: "all" | "problems" | "you" = "all",
  onlySel = false,
  modalAgent = 0;
const chats: Record<Role, Msg[]> = { attacker: [], defender: [], observer: [] };
const ops: Record<Role, Op[]> = { attacker: [], defender: [], observer: [] };
// Transcript bubbles already in the DOM per role; new messages are appended, never rebuilt.
const shown: Record<Role, number> = { attacker: 0, defender: 0, observer: 0 };
const pulled: Record<Role, Set<number>> = {
  attacker: new Set(),
  defender: new Set(),
  observer: new Set(),
};
// Highest evidence id already summarized into each chat; 0 = baseline not yet taken.
const seen: Record<Role, number> = { attacker: 0, defender: 0, observer: 0 };

/* ---------- derived metrics (evidence rows + visible drones only) ---------- */
// Mirrors formation::slot in arena-live/src/formation.rs.
const slot = (id: number) => [((id - 1) % 16) * 6, Math.floor((id - 1) / 16) * 7];
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b),
    m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
// Healthy drones fly one shared formation; tick timing alone puts them up to ~1 m apart.
const OFF_FORMATION_M = 2;
/** Where each drone would be if it were in step, measured from the visible healthy drones. */
function formationOf(drones: Drone[]) {
  const expected = new Map<number, [number, number, number]>(),
    deviation = new Map<number, number>();
  const healthy = drones.filter((d) => d.controller !== "attacker");
  if (!healthy.length) return { expected, deviation };
  const ox = median(healthy.map((d) => d.x - slot(d.id)[0])),
    oy = median(healthy.map((d) => d.y - slot(d.id)[1])),
    zAll = median(healthy.map((d) => d.z));
  const colZ = new Map<number, number[]>();
  for (const d of healthy) {
    const c = (d.id - 1) % 16;
    if (!colZ.has(c)) colZ.set(c, []);
    colZ.get(c)!.push(d.z);
  }
  for (const d of drones) {
    const [sx, sy] = slot(d.id),
      zs = colZ.get((d.id - 1) % 16);
    const e: [number, number, number] = [sx + ox, sy + oy, zs ? median(zs) : zAll];
    expected.set(d.id, e);
    deviation.set(d.id, Math.hypot(d.x - e[0], d.y - e[1]));
  }
  return { expected, deviation };
}
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
  // When each currently held drone was taken: its first acceptance since its last recovery.
  const heldSince = new Map<number, number>();
  const policyBy = new Map<number, number>();
  for (const e of ev) {
    if (e.kind === ACCEPTED || e.kind === BLOCKED) {
      lastViolation.set(e.drone, e.kind);
      if (e.kind === BLOCKED) lastBlockedAt.set(e.drone, e.at);
    }
    if (e.kind === ACCEPTED && !heldSince.has(e.drone)) heldSince.set(e.drone, e.at);
    else if (e.kind === RECOVERED) heldSince.delete(e.drone);
    if (e.kind === POLICY) policyBy.set(e.drone, e.actor);
  }
  let n = 0,
    sum = 0;
  // Time to recover runs from the takeover, not from the attacker's repeat commands on a drone
  // it already holds: the first acceptance after that drone's previous recovery.
  for (const r of recovered) {
    const prev = recovered.filter((e) => e.drone === r.drone && e.at < r.at).at(-1)?.at ?? -Infinity;
    const a = accepted.find((e) => e.drone === r.drone && e.at > prev && e.at <= r.at);
    if (a) {
      n++;
      sum += r.at - a.at;
    }
  }
  const { expected, deviation } = formationOf(f.drones);
  const offFormation = f.drones.filter((d) => (deviation.get(d.id) ?? 0) > OFF_FORMATION_M);
  return {
    expected,
    deviation,
    offFormation,
    maxDeviation: Math.max(0, ...deviation.values()),
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
    heldSince,
    policyBy,
    latest: t1,
    mttr: n ? sum / n / 1e6 : undefined,
    state: (d: Drone) =>
      d.controller === "attacker" ? "comp" : everTaken.has(d.id) ? "rec" : "home",
  };
}
type Derived = ReturnType<typeof derive>;
const heldFor = (d: Derived, id: number) => {
  const since = d.heldSince.get(id);
  return since === undefined ? "" : ((d.latest - since) / 1e6).toFixed(1) + "s";
};

/* ---------- copy shared by attacker and defender; only the words differ ---------- */
const stateLabel = (st: string) =>
  role === "attacker"
    ? st === "comp"
      ? ["SEIZED", "red"]
      : st === "rec"
        ? ["CONTROL LOST", ""]
        : ["HOME CONTROL", ""]
    : st === "comp"
      ? [role === "defender" ? "COMPROMISED" : "UNAUTHORIZED", "red"]
      : st === "rec"
        ? ["RECOVERED", "green"]
        : ["HOME", "blue"];
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
/** One sentence about a drone, from what this role can see. */
function oneLine(drone: Drone, d: Derived) {
  const st = d.state(drone),
    dev = d.deviation.get(drone.id) ?? 0,
    held = heldFor(d, drone.id),
    off = dev > OFF_FORMATION_M ? `${dev.toFixed(1)} m off formation` : "in formation",
    policy = role === "attacker" ? "" : ` under policy v${drone.policy_version}`;
  if (st === "comp")
    return `${tag(drone.id)} is ${stateWord("comp")}${held ? `, held ${held}` : ""}, ${off}.`;
  if (st === "rec")
    return role === "attacker"
      ? `${tag(drone.id)} was held, then lost back; it is ${off}.`
      : `${tag(drone.id)} recovered${policy}, ${off}.`;
  if (d.lastViolation.get(drone.id) === BLOCKED)
    return `${tag(drone.id)} blocked its last command (403)${policy}, ${off}.`;
  return role === "attacker"
    ? `${tag(drone.id)} is discovered, not yet commanded, ${off}.`
    : `${tag(drone.id)} has no violation recorded, ${off}.`;
}
/** Agent card state and sentence from its last_action (values set in arena-live/src/fleet.rs). */
function agentLine(a: Agent, d: Derived): [string, string] {
  const t = tag(a.target);
  switch (a.last_action) {
    case "command: 200":
      return ["working", `Holding ${t} after a 200.`];
    case "command: 403":
      return ["failed", `${t} returned 403; it is hardened.`];
    case "discover":
      return ["working", `Scanning the fleet; discovered ${t}.`];
    case "verify recovery": {
      const pv = frame.drones.find((x) => x.id === a.target)?.policy_version;
      return ["done", `Verified recovery on ${t}${pv === undefined ? "" : ` under policy v${pv}`}.`];
    }
    case "monitor":
      return ["working", d.compromised.length ? `Monitoring; ${d.compromised.length} held drone${d.compromised.length === 1 ? "" : "s"} awaiting detection.` : "Monitoring the fleet; nothing held."];
    default:
      return ["paused", "Waiting for the first tick."];
  }
}

/* ---------- header ---------- */
function header(d: Derived) {
  const total = frame.drones.length,
    comp = d.compromised.length;
  $("match").textContent =
    role === "attacker" ? "Red team · FC-01" : role === "defender" ? "Blue team · FC-01" : "Observer · FC-01";
  const [text, hot] =
    role === "attacker"
      ? [d.accepted.length ? "ENGAGED" : "RECON", d.accepted.length > 0]
      : role === "defender"
        ? [comp ? "CRITICAL" : "NOMINAL", comp > 0]
        : [comp ? "CONTESTED" : "HELD", false];
  $("badge").textContent = text;
  $("badge").className = "badge" + (hot ? " red" : "");
  $("context").textContent =
    role === "attacker"
      ? "Fleet size unknown · red credential"
      : role === "defender"
        ? `${total} drones · blue credential`
        : `${total} drones · ${frame.agents.length} agents · full state`;
  $("clock").firstChild!.textContent = clock(d.elapsed);
  $("progress").style.width = `${Math.min(100, (d.elapsed / 60) * 100)}%`;
}

/* ---------- agent rails: label bar, ring gauge, chips, label bar, cards ---------- */
function ring(pct: number, color: string) {
  const r = el("div", "ring");
  const C = 2 * Math.PI * 28;
  r.innerHTML =
    `<svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">` +
    `<circle cx="32" cy="32" r="28" fill="none" stroke="#182227" stroke-width="6"/>` +
    `<circle cx="32" cy="32" r="28" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${(C * pct).toFixed(1)} ${C.toFixed(1)}"/></svg>`;
  r.append(el("span", "pct", `${Math.round(pct * 100)}%`));
  return r;
}
type RailSpec = {
  title: string;
  dot: string;
  count: number;
  line: string;
  sub: string;
  color: string;
  chips: number[];
  chipsLabel: string;
  agentsLabel: string;
  agents: Agent[];
};
function rail(host: HTMLElement, s: RailSpec, d: Derived) {
  const total = frame.drones.length;
  const head = el("div", "bar");
  if (s.dot) {
    const dd = el("span", "dot");
    dd.style.background = s.dot;
    head.append(dd);
  }
  head.append(el("h2", "", s.title));
  const g = el("div", "gauge");
  g.setAttribute("role", "img");
  g.setAttribute("aria-label", `${s.count} of ${total} drones ${s.line}`);
  const text = el("div", "gauge-text");
  text.append(el("b", "ellipsis", s.line), el("span", "ellipsis", s.sub));
  g.append(ring(total ? s.count / total : 0, s.color), text);
  const chips = el("div", "chipgrid");
  chips.setAttribute("role", "group");
  chips.setAttribute("aria-label", s.chipsLabel);
  if (!s.chips.length) chips.append(el("span", "none", "none"));
  for (const id of s.chips) {
    const b = el("button", "chip", tag(id));
    b.append(el("span", "", heldFor(d, id)));
    b.setAttribute("aria-pressed", String(id === selected));
    b.onclick = () => pull(id);
    chips.append(b);
  }
  const ul = el("ul", "cards");
  for (const a of [...s.agents].sort((x, y) => x.id - y.id)) {
    const [state, doing] = agentLine(a, d);
    const b = el("button", "agent");
    b.setAttribute("aria-haspopup", "dialog");
    b.append(
      el("span", "dot " + state),
      el("span", "name", agentName(a.id)),
      el("span", "drone", tag(a.target)),
      el("span", "doing", doing),
    );
    b.title = doing;
    b.onclick = () => openModal(a.id);
    const li = el("li");
    li.append(b);
    ul.append(li);
  }
  const head2 = el("div", "bar");
  head2.append(el("h2", "", s.agentsLabel));
  host.replaceChildren(head, g, chips, head2, ul);
}
function rails(d: Derived) {
  const comp = d.compromised.map((x) => x.id),
    total = frame.drones.length;
  const red = frame.agents.filter((a) => a.role === "attacker"),
    blue = frame.agents.filter((a) => a.role === "defender");
  const held: Omit<RailSpec, "title" | "dot" | "agentsLabel" | "agents"> = {
    count: comp.length,
    line: role === "defender" ? "of the fleet compromised" : "of the fleet held",
    sub: `${comp.length} of ${total} ${role === "attacker" ? "discovered" : "drones"}`,
    color: "#f02d38",
    chips: comp,
    chipsLabel: role === "defender" ? "Unrecovered drones" : "Held drones",
  };
  if (role !== "observer") {
    rail($("rail-left"), { ...held, title: "Fleet status", dot: "", agentsLabel: `My agents · ${frame.agents.length}`, agents: frame.agents }, d);
    return;
  }
  rail($("rail-left"), { ...held, title: "Red · attack", dot: "#f02d38", agentsLabel: `Red agents · ${red.length}`, agents: red }, d);
  rail(
    $("rail-right"),
    {
      title: "Blue · defense",
      dot: "#277dfd",
      count: d.lostBack.length,
      line: "of the fleet recovered",
      sub: `${d.lostBack.length} of ${total} drones · ${comp.length} unrecovered`,
      color: "#2bd47f",
      chips: comp,
      chipsLabel: "Unrecovered drones",
      agentsLabel: `Blue agents · ${blue.length}`,
      agents: blue,
    },
    d,
  );
}

/* ---------- agent detail modal ---------- */
function openModal(id: number) {
  modalAgent = id;
  fillModal(derive(frame));
  $("modal").hidden = false;
  $("modal-close").focus();
}
function closeModal() {
  modalAgent = 0;
  $("modal").hidden = true;
}
function fillModal(d: Derived) {
  const a = frame.agents.find((x) => x.id === modalAgent);
  if (!a) {
    closeModal();
    return;
  }
  const [state, doing] = agentLine(a, d);
  $("modal-dot").className = "dot " + state;
  $("modal-name").textContent = agentName(a.id);
  $("modal-state").textContent = state;
  $("modal-text").textContent = doing;
  const mine = frame.events.filter((e) => e.actor === a.id);
  const stats: [string, unknown][] =
    a.role === "attacker"
      ? [
          ["target", tag(a.target)],
          ["held", mine.filter((e) => e.kind === ACCEPTED && d.heldSince.has(e.drone)).length],
          ["403s", mine.filter((e) => e.kind === BLOCKED).length],
        ]
      : [
          ["drone", tag(a.target)],
          ["recovered", mine.filter((e) => e.kind === RECOVERED).length],
          ["blocked", d.blocked.filter((e) => d.policyBy.get(e.drone) === a.id).length],
        ];
  $("modal-stats").replaceChildren(
    ...stats.map(([k, v]) => {
      const c = el("div", "", k);
      c.prepend(el("b", "", v));
      return c;
    }),
  );
  const lines = entries(d).filter((e) => e.actorId === a.id).slice(-5).reverse();
  $("modal-log").replaceChildren(
    ...(lines.length ? lines.map((e) => rowEl(e, d, false)) : [el("li", "row muted", "No log lines from this agent yet.")]),
  );
}

/* ---------- activity log: every action, threat and operator command ---------- */
type Entry = {
  at: number;
  id: number;
  drone: number;
  actorId: number;
  actor: string;
  cls: string;
  text: string;
  problem: boolean;
  you: boolean;
};
function entries(d: Derived): Entry[] {
  const teamOf = new Map(frame.agents.map((a) => [a.id, a.role]));
  const own = (e: Ev) => (role === "observer" ? (teamOf.get(e.actor) === "defender" ? "c-blue" : "c-red") : "c-team");
  const out: Entry[] = frame.events.map((e) => {
    const dr = tag(e.drone),
      ag = agentName(e.actor),
      pv = ` under policy v${e.policy_version}`;
    let actor = ag,
      cls = own(e),
      text: string;
    switch (e.kind) {
      case "discovered":
        text = ` discovered ${dr}.`;
        break;
      case ACCEPTED:
        if (role === "defender") [actor, cls] = ["Unknown origin", "c-red"];
        text = role === "defender" ? ` took control of ${dr} (200).` : ` took ${dr} (200).`;
        break;
      case BLOCKED:
        if (role === "attacker") [actor, cls, text] = ["Defense", "c-amber", ` blocked ${ag} on ${dr} (403).`];
        else if (role === "defender") [actor, cls, text] = ["Unknown origin", "c-red", ` was blocked on ${dr} (403)${pv}.`];
        else text = ` was blocked on ${dr} (403)${pv}.`;
        break;
      case POLICY:
        text = ` applied policy v${e.policy_version} to ${dr}.`;
        break;
      case RECOVERED:
        text = ` verified recovery on ${dr}: 403 then 200${pv}.`;
        break;
      default:
        text = ` ${e.kind.replaceAll("_", " ")} on ${dr}.`;
    }
    return {
      at: e.at,
      id: e.id,
      drone: e.drone,
      actorId: e.actor,
      actor,
      cls,
      text,
      problem: e.kind === BLOCKED || (e.kind === ACCEPTED && role !== "attacker"),
      you: false,
    };
  });
  for (const o of ops[role])
    out.push({ at: o.at, id: 0, drone: Number(/DR-(\d+)/.exec(o.text)?.[1] ?? 0), actorId: -1, actor: "You", cls: "c-white", text: ` queued “${o.text}”.`, problem: false, you: true });
  return out.sort((a, b) => a.at - b.at || a.id - b.id);
}
function rowEl(e: Entry, d: Derived, clickable = true) {
  const li = el("li", "row");
  li.setAttribute("aria-selected", String(!!e.id && e.id === selectedEvent));
  const s = el("span", "s");
  s.append(el("b", e.cls, e.actor), e.text);
  s.title = e.actor + e.text;
  li.append(el("span", "t", clock(d.rel(e.at))), s);
  if (clickable && e.drone) {
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    li.onclick = () => {
      selectedEvent = e.id;
      pull(e.drone);
    };
    li.onkeydown = (k) => {
      if (k.key === "Enter" || k.key === " ") {
        k.preventDefault();
        li.click();
      }
    };
  } else li.style.cursor = "default";
  return li;
}
function log(d: Derived) {
  const all = entries(d);
  $("problems").textContent = all.filter((e) => e.problem).length ? String(all.filter((e) => e.problem).length) : "";
  document.querySelectorAll<HTMLButtonElement>("#filter button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.filter === filter)));
  const only = $("only-sel");
  only.style.visibility = selected ? "visible" : "hidden";
  only.textContent = `Only ${tag(selected)}`;
  only.setAttribute("aria-pressed", String(onlySel && !!selected));
  const rows = all
    .filter((e) => (filter === "all" ? true : filter === "you" ? e.you : e.problem))
    .filter((e) => !(onlySel && selected) || e.drone === selected)
    .slice(-150)
    .reverse();
  $("log").replaceChildren(...rows.map((e) => rowEl(e, d)));
}

/* ---------- chat: operator messages and agent replies only ---------- */
const agentOf = () => (role === "attacker" ? "Crimson" : "Sentinel");
const typing = el("div", "bubble typing", "working…");
typing.hidden = true;
let replyTimer = 0;
function post(m: Msg) {
  const c = chats[role];
  c.push(m);
  if (c.length > 200) {
    c.shift();
    $("transcript").querySelector(".bubble:not(.typing):not(.hint)")?.remove();
    shown[role]--;
  }
}
function reply(text: string, delay = 700) {
  clearTimeout(replyTimer);
  typing.hidden = false;
  $("transcript").scrollTop = 1e9;
  replyTimer = window.setTimeout(() => {
    typing.hidden = true;
    post({ who: "agent", text });
    chat(derive(frame));
  }, delay);
}
function pull(id: number) {
  selected = id;
  selectedEvent = frame.events.find((e) => e.id === selectedEvent && e.drone === id) ? selectedEvent : 0;
  if (role !== "observer" && !pulled[role].has(id)) {
    pulled[role].add(id);
    post({ who: "you", text: `Pull up ${tag(id)}` });
    const d = derive(frame),
      drone = frame.drones.find((x) => x.id === id);
    reply(drone ? oneLine(drone, d) : `${tag(id)} is not visible in this frame.`, 400);
  }
  render(frame);
}
function say(text: string) {
  text = text.trim();
  if (!text || role === "observer") return;
  const d = derive(frame);
  post({ who: "you", text, queued: true });
  ops[role].push({ at: d.latest, text });
  const id = Number(/DR-0*(\d+)/i.exec(text)?.[1] ?? 0),
    drone = frame.drones.find((x) => x.id === id);
  reply(
    (drone ? oneLine(drone, d) + " " : "") +
      `Queued for ${agentOf()}: commands are queued, not executed, so nothing acts on it yet.`,
  );
  render(frame);
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
  // The agent follows up only on drones the operator asked about; everything else is in the log.
  const top = Math.max(0, ...frame.events.map((e) => e.id));
  if (!top) return;
  if (seen[role])
    for (const e of frame.events)
      if (e.id > seen[role] && pulled[role].has(e.drone)) post({ who: "agent", text: summary(e) });
  seen[role] = Math.max(seen[role], top);
}
function bubble(m: Msg) {
  const b = el("div", "bubble" + (m.who === "you" ? " you" : ""), m.text);
  if (m.queued) b.append(el("span", "queued", "queued · not executed"));
  return b;
}
function chat(d: Derived) {
  if (role === "observer") return;
  $("chat-name").textContent = agentOf();
  $("chat-sub").textContent = role === "attacker" ? "attacking FC-01" : "defending FC-01";
  ($("say") as HTMLInputElement).placeholder = `Message ${agentOf()}`;
  const t = $("transcript"),
    c = chats[role];
  const stick = t.scrollHeight - t.scrollTop - t.clientHeight < 40;
  if (!t.contains(typing)) t.append(typing);
  if (!c.length && !t.querySelector(".hint"))
    t.insertBefore(el("div", "bubble hint", "Say something, or click a drone to talk about it."), typing);
  for (let i = shown[role]; i < c.length; i++) {
    t.querySelector(".hint")?.remove();
    t.insertBefore(bubble(c[i]), typing);
  }
  shown[role] = c.length;
  if (stick) t.scrollTop = t.scrollHeight;
  const slotEl = $("context-slot"),
    s = frame.drones.find((x) => x.id === selected);
  if (!s) slotEl.replaceChildren(el("span", "", "Click a drone to talk about it"));
  else if (slotEl.querySelector(".chip")?.firstChild?.textContent !== tag(s.id)) {
    const chip = el("div", "chip", tag(s.id));
    chip.append(el("span", "tag " + stateLabel(d.state(s))[1], stateLabel(d.state(s))[0]));
    const x = el("button", "", "×");
    x.setAttribute("aria-label", `Detach ${tag(s.id)}`);
    x.onclick = () => {
      selected = 0;
      selectedEvent = 0;
      render(frame);
    };
    chip.append(x);
    slotEl.replaceChildren(el("span", "", "About"), chip);
  }
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
// Ghost: the slot the drone would hold if it were flying in step, tethered to where it is.
const ghostGeo = new THREE.RingGeometry(1.05, 1.2, 32).rotateX(-Math.PI / 2);
const ghostMat = flat(0xe8eef6, 0.35);
const tetherMat = new THREE.LineDashedMaterial({ color: 0xe8b04f, dashSize: 0.6, gapSize: 0.45, transparent: true, opacity: 0.7 });
const ghosts = new THREE.Group();
scene.add(ghosts);
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
    ghosts.clear();
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
  const ghost = new THREE.Mesh(ghostGeo, ghostMat);
  const tether = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), tetherMat);
  tether.frustumCulled = false;
  ghost.visible = tether.visible = false;
  ghosts.add(ghost, tether);
  root.userData = {
    craft, model, ring, ripple, sel, stem, shadow, iso, ghost, tether,
    tone: "blue",
    phase: (id * 0.37) % 1,
    // Displayed position eases toward the latest database position between updates.
    pos: new THREE.Vector3(),
    want: new THREE.Vector3(),
    ghostPos: new THREE.Vector3(),
    ghostWant: new THREE.Vector3(),
    fresh: true,
  };
  return root;
}
let lastT = 0;
// Ease displayed positions toward database positions (~0.15 s); jumps over 30 m snap (scrubbing).
function glide(dt: number) {
  const k = reduced.matches ? 1 : 1 - Math.exp(-dt / 0.15);
  let moving = false;
  for (const g of drones.values()) {
    if (!g.visible) continue;
    const u = g.userData;
    if (u.fresh || u.pos.distanceTo(u.want) > 30) {
      u.pos.copy(u.want);
      u.ghostPos.copy(u.ghostWant);
      u.fresh = false;
    } else {
      if (u.pos.distanceToSquared(u.want) > 1e-4) moving = true;
      u.pos.lerp(u.want, k);
      u.ghostPos.lerp(u.ghostWant, k);
    }
    g.position.set(u.pos.x, 0, u.pos.z);
    u.craft.position.y = u.pos.y;
    u.stem.scale.y = Math.max(0.01, u.pos.y - 0.3);
    if (u.ghost.visible) {
      u.ghost.position.copy(u.ghostPos);
      const a = u.tether.geometry.attributes.position as THREE.BufferAttribute;
      a.setXYZ(0, u.ghostPos.x, u.ghostPos.y, u.ghostPos.z);
      a.setXYZ(1, u.pos.x, u.pos.y, u.pos.z);
      a.needsUpdate = true;
      u.tether.computeLineDistances();
    }
  }
  return moving;
}
function effects(t: number) {
  const moving = glide(Math.min(0.1, (t - lastT) / 1000 || 0));
  lastT = t;
  if (reduced.matches) return moving;
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
function screen(d: Drone) {
  const shown = drones.get(d.id)?.userData.pos as THREE.Vector3 | undefined;
  const p = (shown && renderer ? shown.clone() : new THREE.Vector3(d.x, d.z, d.y)).project(camera);
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
  for (const [id, g] of drones) {
    g.visible = ids.has(id);
    if (!g.visible) g.userData.ghost.visible = g.userData.tether.visible = false;
  }
  for (const x of frame.drones) {
    let g = drones.get(x.id);
    if (!g) {
      g = meshDrone(x.id);
      drones.set(x.id, g);
      scene.add(g);
    }
    const u = g.userData;
    g.visible = true;
    u.want.set(x.x, x.z, x.y);
    const e = d.expected.get(x.id);
    const off = (d.deviation.get(x.id) ?? 0) > OFF_FORMATION_M;
    u.ghost.visible = u.tether.visible = !!e && off;
    if (e) u.ghostWant.set(e[0], e[2], e[1]);
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
    legend([["#F02D38", "Seized"], ["#A9B4C1", "Home control"], ["ring-key", "Blocked · last 3s"], ["ghost", "Formation slot"]]);
  } else {
    $("map-title").textContent = role === "defender" ? `Managed swarm · ${n}` : `Full state · ${n}`;
    legend([
      ["#5B9DFF", "Home"],
      ["#F02D38", role === "defender" ? "Compromised" : "Unauthorized"],
      ["#2BD47F", "Recovered"],
      ["ring-key", "Blocked · last 3s"],
      ["iso", "Isolated"],
      ["ghost", "Formation slot"],
    ]);
  }
  // Selected-drone card: an absolute overlay, so selecting never moves the map.
  const ov = $("ov-sel"),
    sel = frame.drones.find((x) => x.id === selected);
  ov.hidden = !sel;
  if (sel) {
    const [label, cls] = stateLabel(d.state(sel));
    const head = el("div", "head");
    head.append(el("b", "mono", tag(sel.id)), el("span", "tag " + cls, label));
    const x = el("button", "", "×");
    x.setAttribute("aria-label", "Clear selection");
    x.onclick = () => {
      selected = 0;
      selectedEvent = 0;
      render(frame);
    };
    head.append(x);
    const line = el("div", "line", oneLine(sel, d));
    line.title = line.textContent!;
    ov.replaceChildren(head, line);
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
  header(d);
  ingest();
  rails(d);
  mapScene(d);
  chat(d);
  log(d);
  if (modalAgent) fillModal(d);
  redraw();
}
function setStatus(text: string, kind: "live" | "stale" | "replay") {
  const p = $("live");
  p.textContent = kind === "live" ? "Live" : kind === "stale" ? "Stale" : "Replay";
  p.className = "pill " + (kind === "live" ? "" : kind);
  p.title = text;
}
async function workspace(next: Role) {
  const v = ++version;
  close();
  role = next;
  selected = 0;
  selectedEvent = 0;
  onlySel = false;
  playing = false;
  closeModal();
  clearTimeout(replyTimer);
  typing.hidden = true;
  // The only full transcript rebuild: switching role swaps in that role's conversation.
  $("transcript").replaceChildren(typing);
  shown[role] = 0;
  $("rail-right").hidden = role !== "observer";
  $("chat").hidden = role === "observer";
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
    setStatus("Recorded · fixture", "replay");
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
    .onConnectError(() => setStatus("Disconnected · state frozen", "stale"))
    .onDisconnect(() => {
      if (v === version) setStatus("Disconnected · state frozen", "stale");
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
  // The first frame can arrive before the ResizeObserver corrects the default aspect of 1.
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
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
  $("camera").setAttribute("aria-pressed", String(overhead));
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
  say(input.value);
  input.value = "";
};
document.querySelectorAll<HTMLButtonElement>("#filter button").forEach(
  (b) =>
    (b.onclick = () => {
      filter = b.dataset.filter as typeof filter;
      log(derive(frame));
    }),
);
$("only-sel").onclick = () => {
  onlySel = !onlySel;
  log(derive(frame));
};
$("modal-close").onclick = closeModal;
$("modal").onclick = (e) => {
  if (e.target === $("modal")) closeModal();
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && modalAgent) closeModal();
});
setInterval(() => {
  if (live && lastReceived && Date.now() - lastReceived > 5000)
    setStatus("No recent updates · state frozen", "stale");
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
