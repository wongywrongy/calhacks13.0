import { explainFleetError, fleetOutcome } from "../sandbox/src/fleet-outcome.ts";
import { OperationChat, activeOperation, type Worker, type ChatMessage } from "./fleet-chat.ts";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { droneGeometry, FleetLines, ViewportResolution } from "./fleet-render.ts";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { display, FlockClock, linkFade, neighbours, type Formation } from "./flock.ts";
import { DbConnection } from "./module_bindings/index.ts";

type Role = "attacker" | "defender" | "observer";
type Drone = {
  id: number;
  epoch: number;
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
  epoch: number;
  role: string;
  step: number;
  target: number;
  last_action: string;
  name?: string;
  specialty?: string;
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
type Mission = { epoch: number; state: string; delivered_ms: number; goal_ms: number; lost_ms: number; unnecessary_isolation_ms: number; detection_us: number; detections: number; recovery_us: number; recoveries: number };
type ResilienceDrone = { drone: number; delivered_ms: number; anomaly: boolean };
type Frame = { mission?: Mission; resilience?: ResilienceDrone[]; budgets?: { role: string; remaining: number }[]; epoch?: number; conversation?: number; active?: boolean; drones: Drone[]; agents: Agent[]; events: Ev[] };
type Msg = { who: "you" | "agent"; text: string; id: number };
const $ = (id: string) => document.getElementById(id)!;
const el = (tag: string, cls = "", text: unknown = "") => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== "") n.textContent = String(text);
  return n;
};
const tag = (id: number) => "DR-" + String(id).padStart(3, "0");
const agentName = (id: number) => frame.agents.find((a) => a.id === id)?.name || workerFor(id)?.name || "Agent " + String(id).padStart(2, "0");
const clock = (s: number) => Number.isFinite(s)
  ? `${s < 0 ? "−" : ""}${Math.floor(Math.abs(s) / 60)}:${String(Math.floor(Math.abs(s) % 60)).padStart(2, "0")}` : "Time unavailable";
const eventTime = (at: number) => Number.isFinite(at) && at > 0
  ? new Date(at / 1000).toISOString().slice(11, 19) + " UTC" : "Time unavailable";
const agentLabel = (id: number) => {
  const name = agentName(id), w = workerFor(id);
  const duplicates = frame.agents.filter((a) => agentName(a.id) === name);
  return duplicates.length > 1 ? `${name} · ${tag(w?.target ?? frame.agents.find((a) => a.id === id)!.target)} · ${w?.operationId.slice(0, 6) ?? id}` : name;
};
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
  stateConnected = false,
  lastReceived = 0,
  filter: "all" | "problems" | "you" = "all",
  onlySel = false,
  modalAgent = 0;
let operationChat: OperationChat | undefined;
let renderedMessages: ChatMessage[] | undefined;
let resilienceMode = false;
let modelDriven = false,
  fleetEpoch = 0,
  coordinatorModel = "",
  inferenceLabel = "Bitdeer",
  sandboxName = "",
  demoMode = false,
  chatError = "",
  resetting = false;
const workerFor = (id: number): Worker | undefined =>
  operationChat?.operations
    .filter((o) => o.epoch === fleetEpoch)
    .flatMap((o) => o.workers)
    .findLast((w) => w.agentId === id);
const assignedTarget = (a: Agent) => workerFor(a.id)?.target ?? a.target;

/* ---------- derived metrics (evidence rows + visible drones only) ---------- */
// Mirrors formation::slot in arena-live/src/formation.rs.
const slot = (id: number) => [
  ((id - 1) % 16) * 6,
  Math.floor((id - 1) / 16) * 7,
];
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
    const e: [number, number, number] = [
      sx + ox,
      sy + oy,
      zs ? median(zs) : zAll,
    ];
    expected.set(d.id, e);
    deviation.set(d.id, Math.hypot(d.x - e[0], d.y - e[1]));
  }
  return { expected, deviation };
}
function derive(f: Frame) {
  const ev = [...f.events].sort((a, b) => a.at - b.at || a.id - b.id);
  const t0 = ev.length ? Math.min(...ev.map((e) => e.at)) : 0;
  const t1 = ev.length ? Math.max(...ev.map((e) => e.at)) : 0;
  const rel = (at: number) => (at - t0) / 1e6;
  const accepted = ev.filter((e) => e.kind === ACCEPTED);
  const blocked = ev.filter((e) => e.kind === BLOCKED);
  const recovered = ev.filter((e) => e.kind === RECOVERED);
  const policies = ev.filter((e) => e.kind === POLICY);
  const acceptedIds = new Set(accepted.map((e) => e.drone));
  const everTaken = new Set([...acceptedIds, ...recovered.map((e) => e.drone)]);
  const compromised = f.drones.filter((d) => d.controller === "attacker" || !!f.resilience?.find((r) => r.drone === d.id)?.anomaly);
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
    if (e.kind === ACCEPTED && !heldSince.has(e.drone))
      heldSince.set(e.drone, e.at);
    else if (e.kind === RECOVERED) heldSince.delete(e.drone);
    if (e.kind === POLICY) policyBy.set(e.drone, e.actor);
  }
  let n = 0,
    sum = 0;
  // Time to recover runs from the takeover, not from the attacker's repeat commands on a drone
  // it already holds: the first acceptance after that drone's previous recovery.
  for (const r of recovered) {
    const prev =
      recovered.filter((e) => e.drone === r.drone && e.at < r.at).at(-1)?.at ??
      -Infinity;
    const a = accepted.find(
      (e) => e.drone === r.drone && e.at > prev && e.at <= r.at,
    );
    if (a) {
      n++;
      sum += r.at - a.at;
    }
  }
  const { expected, deviation } = formationOf(f.drones);
  const offFormation = f.drones.filter(
    (d) => (deviation.get(d.id) ?? 0) > OFF_FORMATION_M,
  );
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
      compromised.some((x) => x.id === d.id)
        ? "comp"
        : everTaken.has(d.id)
          ? "rec"
          : "home",
  };
}
type Derived = ReturnType<typeof derive>;
const heldFor = (d: Derived, id: number) => {
  const since = d.heldSince.get(id);
  return since === undefined ? "" : ((d.latest - since) / 1e6).toFixed(1) + "s";
};

/* ---------- copy shared by attacker and defender; only the words differ ---------- */
const stateLabel = (st: string) =>
  resilienceMode ? st === "comp" ? ["DISRUPTED", "red"] : ["PARTICIPATING", "blue"] : role === "attacker"
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
  if (resilienceMode) return st === "comp" ? "disrupted" : "participating";
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
  if (frame.mission) {
    const state = frame.resilience?.find((r) => r.drone === drone.id);
    return `${tag(drone.id)} · ${drone.isolated ? "quarantined" : state?.anomaly ? "anomaly observed" : "participating"} · ${((state?.delivered_ms ?? 0) / 1000).toFixed(1)} of 45 survey packets delivered.`;
  }
  const st = d.state(drone),
    dev = d.deviation.get(drone.id) ?? 0,
    held = heldFor(d, drone.id),
    off =
      dev > OFF_FORMATION_M
        ? `${dev.toFixed(1)} m off formation`
        : "in formation",
    policy =
      role === "attacker" ? "" : ` under policy v${drone.policy_version}`;
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
  if (modelDriven) {
    const w = workerFor(a.id);
    return w
      ? [
          w.state,
          `${tag(w.target)} · ${w.error ? explainFleetError(w.error) : w.objective}`,
        ]
      : ["paused", "No active assignment."];
  }
  const t = tag(assignedTarget(a));
  switch (a.last_action) {
    case "command: 200":
      return ["working", `Holding ${t} after a 200.`];
    case "command: 403":
      return ["failed", `${t} returned 403; it is hardened.`];
    case "discover":
      return ["working", `Scanning the fleet; discovered ${t}.`];
    case "verify recovery": {
      const pv = frame.drones.find((x) => x.id === a.target)?.policy_version;
      return [
        "done",
        `Verified recovery on ${t}${pv === undefined ? "" : ` under policy v${pv}`}.`,
      ];
    }
    case "monitor":
      return [
        "working",
        d.compromised.length
          ? `Monitoring; ${d.compromised.length} held drone${d.compromised.length === 1 ? "" : "s"} awaiting detection.`
          : "Monitoring the fleet; nothing held.",
      ];
    default:
      return ["paused", "Waiting for the first tick."];
  }
}

/* ---------- header ---------- */
function header(d: Derived) {
  const total = frame.drones.length,
    comp = d.compromised.length;
  $("match").textContent =
    role === "attacker"
      ? "Red team · FC-01"
      : role === "defender"
        ? "Blue team · FC-01"
        : "Observer · FC-01";
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
  $("clock").firstChild!.textContent = modelDriven
    ? "Sandbox"
    : clock(d.elapsed);
  $("clock").querySelector("span")!.textContent = modelDriven ? "" : " / 1:00";
  $("clock").parentElement!.hidden = demoMode;
  $("reset-sandbox").hidden = $("reset-swarm").hidden = !demoMode || role === "observer";
  $("new-chat").hidden = !operationChat;
  $("progress").parentElement!.style.visibility = modelDriven
    ? "hidden"
    : "visible";
  $("progress").style.width = `${Math.min(100, (d.elapsed / 60) * 100)}%`;
  if (resilienceMode) {
    $("match").textContent = role === "attacker" ? "Challenge team" : role === "defender" ? "Defense team" : "Observer";
    $("context").textContent = "Synthetic resilience simulation · 6 drones";
    $("badge").textContent = frame.mission?.state.toUpperCase() ?? "READY";
    $("reset-swarm").textContent = "Reset Arena";
    $("reset-swarm").title = "Stop both teams and clear chats, policies, budgets and mission state";
    $("reset-sandbox").hidden = true;
  }
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
  if (frame.mission) {
    const m = frame.mission;
    g.setAttribute("aria-label", `Mission ${Math.floor(100 * m.delivered_ms / m.goal_ms)} percent complete`);
    const stats = el("div", "gauge-text resilience-metrics");
    stats.append(el("b", "", `Survey mission · ${Math.floor(100 * m.delivered_ms / m.goal_ms)}%`), el("span", "", `${(m.delivered_ms / 1000).toFixed(1)} / ${m.goal_ms / 1000} packets · ${m.state}`));
    stats.append(el("span", "", `Lost work: ${(m.lost_ms / 1000).toFixed(1)} drone-seconds`));
    if (role !== "attacker") {
      stats.append(el("span", "", `Detection: ${m.detections ? (m.detection_us / m.detections / 1e6).toFixed(2) + "s" : "unmeasured"}`),
        el("span", "", `Recovery (incl. expiry): ${m.recoveries ? (m.recovery_us / m.recoveries / 1e6).toFixed(2) + "s" : "unmeasured"}`),
        el("span", "", `Unnecessary isolation: ${(m.unnecessary_isolation_ms / 1000).toFixed(1)}s`));
    }
    const budget = frame.budgets?.find((b) => b.role === role);
    if (budget) stats.append(el("span", "", `Action budget: ${budget.remaining} / 40`));
    g.replaceChildren(stats);
  }
  const chips = el("div", "chipgrid");
  chips.setAttribute("role", "group");
  chips.setAttribute("aria-label", s.chipsLabel);
  if (!s.chips.length) chips.append(el("span", "none", resilienceMode ? "No anomalies observed" : "No drones held"));
  for (const id of s.chips) {
    const b = el("button", "chip", tag(id));
    b.append(el("span", "", heldFor(d, id)));
    b.setAttribute("aria-pressed", String(id === selected));
    b.onclick = () => pull(id);
    chips.append(b);
  }
  const ul = el("ul", "cards");
  if (!s.agents.length) {
    const empty = el("li", "empty-agents");
    empty.append(el("b", "", "No agents deployed"), el("span", "", "Send an objective through chat to deploy specialists."));
    ul.append(empty);
  }
  for (const a of [...s.agents].sort((x, y) => x.id - y.id)) {
    const [state, doing] = agentLine(a, d);
    const b = el("button", "agent");
    b.setAttribute("aria-haspopup", "dialog");
    b.dataset.agentId = String(a.id);
    b.dataset.state = state;
    b.dataset.operationId = workerFor(a.id)?.operationId ?? "";
    b.append(
      el("span", "dot " + state),
      el("span", "name", agentLabel(a.id)),
      el("span", "drone", tag(assignedTarget(a))),
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
  const nodes = [head, g, chips, head2, ul];
  if (host.children.length !== nodes.length) host.replaceChildren(...nodes);
  else
    nodes.forEach((node, i) => {
      if (host.children[i].outerHTML !== node.outerHTML)
        host.children[i].replaceWith(node);
    });
}
function rails(d: Derived) {
  const comp = d.compromised.map((x) => x.id),
    total = frame.drones.length;
  const red = frame.agents.filter((a) => a.role === "attacker"),
    blue = frame.agents.filter((a) => a.role === "defender");
  const held: Omit<RailSpec, "title" | "dot" | "agentsLabel" | "agents"> = {
    count: comp.length,
    line:
      role === "defender" ? "of the fleet compromised" : "of the fleet held",
    sub: `${comp.length} of ${total} ${role === "attacker" ? "discovered" : "drones"}`,
    color: "#f02d38",
    chips: comp,
    chipsLabel: role === "defender" ? "Unrecovered drones" : "Held drones",
  };
  if (role !== "observer") {
    rail(
      $("rail-left"),
      {
        ...held,
        title: "Fleet status",
        dot: "",
        agentsLabel: `My agents · ${frame.agents.length}`,
        agents: frame.agents,
      },
      d,
    );
    return;
  }
  rail(
    $("rail-left"),
    {
      ...held,
      title: "Red · attack",
      dot: "#f02d38",
      agentsLabel: `Red agents · ${red.length}`,
      agents: red,
    },
    d,
  );
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
// Replace only changed sections so live updates preserve open details, focus and scroll.
function patchContent(host: HTMLElement, nodes: HTMLElement[]) {
  const detail = host.firstElementChild;
  if (detail instanceof HTMLDetailsElement && nodes[0] instanceof HTMLDetailsElement && nodes.length === 1) {
    detail.querySelector("summary")!.textContent = nodes[0].querySelector("summary")!.textContent;
    detail.querySelector("pre")!.textContent = nodes[0].querySelector("pre")!.textContent;
    return;
  }
  const probe = el("div");
  probe.append(...nodes);
  const opened = Array.from(host.querySelectorAll<HTMLDetailsElement>("details")).map((d) => d.open);
  probe.querySelectorAll<HTMLDetailsElement>("details").forEach((d, i) => d.open = opened[i] ?? false);
  if (host.innerHTML === probe.innerHTML) return;
  const top = host.scrollTop;
  host.replaceChildren(...Array.from(probe.childNodes));
  host.querySelectorAll<HTMLDetailsElement>("details").forEach((d, i) => d.open = opened[i] ?? false);
  host.scrollTop = top;
}
function technicalDetails(value: unknown, label = "Full assignment and technical evidence") {
  const details = document.createElement("details");
  details.append(el("summary", "", label), el("pre", "", JSON.stringify(value, null, 2)));
  return details;
}
function openModal(id: number) {
  modalAgent = id;
  fillModal(derive(frame));
  $("modal").hidden = false;
  $("modal-close").focus();
}
function closeModal() {
  const id = modalAgent;
  modalAgent = 0;
  $("modal").hidden = true;
  document.querySelector<HTMLButtonElement>(`.agent[data-agent-id="${id}"]`)?.focus({ preventScroll: true });
}
function fillModal(d: Derived) {
  const scroll = $("modal-name").closest<HTMLElement>(".dialog")!;
  const top = scroll.scrollTop;
  const a = frame.agents.find((x) => x.id === modalAgent);
  if (!a) { closeModal(); return; }
  const w = workerFor(a.id);
  const op = operationChat?.operations.find((o) => o.id === w?.operationId);
  const results = op?.results.filter((r) => r.agentId === a.id) ?? [];
  const last = results.at(-1);
  const mine = entries(d).filter((e) => e.actorId === a.id && (!w || !e.operationId || e.operationId === w.operationId));
  const [state, doing] = agentLine(a, d);
  const status = op ? fleetOutcome({ ...op, tasks: [{ agentId: a.id }], results,
    state: state === "working" ? "running" : state === "paused" ? "cancelled" : state === "failed" ? "failed" : "completed" }).status : state;
  $("modal-dot").className = "dot " + state;
  $("modal-name").textContent = agentLabel(a.id);
  $("modal-state").textContent = status;
  $("modal-specialty").textContent = w?.specialty ?? a.specialty ?? a.role;
  const assignment = op?.deployment?.assignments.find((t) => t.agentId === a.id);
  $("modal-text").textContent = assignment ? `${assignment.summary} ${tag(assignment.target)}.` : w?.objective ?? doing;
  const target = w?.target ?? assignedTarget(a);
  const drone = frame.drones.find((x) => x.id === target);
  const targetButton = el("button", "chip", tag(target));
  targetButton.onclick = () => { pull(target); closeModal(); };
  patchContent($("modal-target"), [targetButton]);
  let result = w?.error ? explainFleetError(w.error) : last?.outcome === RECOVERED
    ? "Recovered this drone; unauthorized commands were rejected and legitimate control passed verification."
    : last?.outcome === ACCEPTED ? "Gained control; the unauthorized command was accepted."
    : last?.outcome === BLOCKED ? "The unauthorized command was rejected (403)."
    : last?.outcome === POLICY ? "Containment policy applied; recovery has not been verified by this agent."
    : last?.error ? explainFleetError(last.error)
    : state === "working" ? "Working on the assigned task." : "No successful outcome was verified for this agent.";
  const other = d.recovered.filter((e) => e.drone === target && e.actor !== a.id).at(-1);
  const current = drone ? `Current drone state: ${drone.controller === "attacker" ? "compromised" : "authorized control"}.${other && drone.controller !== "attacker" ? ` Recovery was verified by ${agentLabel(other.actor)}.` : ""}` : "Current drone state is unavailable.";
  $("modal-result").textContent = result;
  $("modal-current").textContent = current;
  patchContent($("modal-log"), mine.length ? mine.slice(-30).map((e) => rowEl(e, d, false)) : [el("li", "row muted", "No activity from this agent yet.")]);
  patchContent($("modal-details"), [technicalDetails({ agentId: a.id, operationId: w?.operationId,
    assignment: w, results, inferences: op?.inferences.filter((i) => i.agentId === a.id),
    evidence: frame.events.filter((e) => e.actor === a.id) })]);
  scroll.scrollTop = top;
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
  operationId?: string;
  actionId?: string;
  evidenceIds?: number[];
  status?: string;
};
function entries(d: Derived): Entry[] {
  const teamOf = new Map(frame.agents.map((a) => [a.id, a.role]));
  const own = (e: Ev) =>
    role === "observer"
      ? teamOf.get(e.actor) === "defender"
        ? "c-blue"
        : "c-red"
      : "c-team";
  const out: Entry[] = frame.events.map((e) => {
    const dr = tag(e.drone),
      ag = agentLabel(e.actor),
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
        text =
          role === "defender"
            ? ` took control of ${dr} (200).`
            : ` took ${dr} (200).`;
        break;
      case BLOCKED:
        if (role === "attacker")
          [actor, cls, text] = [
            "Defense",
            "c-amber",
            ` blocked ${ag} on ${dr} (403).`,
          ];
        else if (role === "defender")
          [actor, cls, text] = [
            "Unknown origin",
            "c-red",
            ` was blocked on ${dr} (403)${pv}.`,
          ];
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
      problem:
        e.kind === BLOCKED || (e.kind === ACCEPTED && role !== "attacker"),
      you: false,
    };
  });
  for (const t of operationChat?.turns ?? []) if (t.state === "failed" && t.error && (!t.metric?.epoch || t.metric.epoch === fleetEpoch)) out.push({
    at: t.updatedAt * 1000, id: 0, drone: 0, actorId: 0, actor: agentOf(), cls: "c-team",
    text: ` request failed · ${t.error}`, problem: true, you: false, status: "failed",
  });
  for (const o of (operationChat?.operations ?? []).filter((o) => o.epoch === fleetEpoch))
    for (const w of o.workers) out.push({
      at: (w.deployedAt ?? o.createdAt) * 1000, id: 0, drone: w.target, actorId: w.agentId,
      actor: agentLabel(w.agentId), cls: "c-team",
      text: ` deployed · ${w.specialty || "specialist"} · ${tag(w.target)}`,
      problem: false, you: true, operationId: o.id, status: "deployed",
    });
  for (const o of (operationChat?.operations ?? []).filter(
    (o) => o.epoch === fleetEpoch,
  ))
    for (const r of o.results) {
      const evidenceIds = [
        r.evidenceId,
        ...(r.verificationEvidenceIds ?? []),
      ].filter((id): id is number => !!id);
      const status =
        r.status === "executed"
          ? r.outcome === RECOVERED
            ? "verified"
            : r.responseStatus === 403
              ? "blocked"
              : "executed"
          : r.status;
      const existing = out.find((e) => e.id && e.id === r.evidenceId);
      if (existing) {
        Object.assign(existing, {
          operationId: o.id,
          actionId: r.actionId,
          evidenceIds,
          status,
        });
        existing.text += ` · ${status} · evidence #${r.evidenceId}`;
        continue;
      }
      out.push({
        at: (r.at ?? o.createdAt) * 1000,
        id: r.evidenceId ?? 0,
        drone: r.target ?? 0,
        actorId: r.agentId,
        actor: r.agentId ? agentLabel(r.agentId) : agentOf(),
        cls: "c-team",
        text: ` · ${status}: ${r.error ? explainFleetError(r.error) : r.outcome ?? r.kind ?? "decision"}${r.evidenceId ? ` · evidence #${r.evidenceId}` : ""}`,
        problem: status === "failed" || status === "blocked",
        you: false,
        operationId: o.id,
        actionId: r.actionId,
        evidenceIds,
        status,
      });
    }
  return out.sort((a, b) => a.at - b.at || a.id - b.id);
}
function rowEl(e: Entry, d: Derived, clickable = true) {
  const li = el("li", "row");
  li.dataset.operationId = e.operationId ?? "";
  li.dataset.actionId = e.actionId ?? "";
  li.dataset.evidenceIds = (e.evidenceIds ?? (e.id ? [e.id] : [])).join(",");
  li.dataset.status = e.status ?? "executed";
  li.dataset.agentId = String(e.actorId);
  li.setAttribute("aria-selected", String(!!e.id && e.id === selectedEvent));
  const s = el("span", "s");
  s.append(el("b", e.cls, e.actor), e.text);
  s.title = e.actor + e.text;
  li.append(el("span", "t", eventTime(e.at)), s);
  li.dataset.timestamp = String(e.at);
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
  $("problems").textContent = all.filter((e) => e.problem).length
    ? String(all.filter((e) => e.problem).length)
    : "";
  document
    .querySelectorAll<HTMLButtonElement>("#filter button")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.filter === filter)),
    );
  const only = $("only-sel");
  only.style.visibility = selected ? "visible" : "hidden";
  only.textContent = `Only ${tag(selected)}`;
  only.setAttribute("aria-pressed", String(onlySel && !!selected));
  const rows = all
    .filter((e) =>
      filter === "all" ? true : filter === "you" ? e.you : e.problem,
    )
    .filter((e) => !(onlySel && selected) || e.drone === selected)
    .slice(-150)
    .reverse();
  const nodes = rows.map((e) => rowEl(e, d));
  if ($("log").innerHTML !== nodes.map((n) => n.outerHTML).join(""))
    $("log").replaceChildren(...nodes);
}

/* ---------- chat: operator messages and agent replies only ---------- */
const agentOf = () => (role === "attacker" ? "Crimson" : "Sentinel");
const typing = el("div", "bubble typing", "working…");
typing.hidden = true;
function pull(id: number) {
  selected = id;
  selectedEvent = frame.events.find(
    (e) => e.id === selectedEvent && e.drone === id,
  )
    ? selectedEvent
    : 0;
  render(frame);
}
async function say(text: string) {
  text = text.trim();
  if (!text || role === "observer" || resetting) return;
  if (!operationChat) {
    chatError = "Chat requires a live authenticated backend session.";
    chat(derive(frame));
    return;
  }
  if (operationChat.sending) return;
  chatError = "";
  const client = operationChat;
  const sending = client.submit(text, selected || undefined);
  chat(derive(frame));
  try {
    await sending;
  } catch (e) {
    if (client !== operationChat || resetting) return;
    chatError = e instanceof Error ? e.message : "Message failed";
    if (!($("say") as HTMLInputElement).value)
      ($("say") as HTMLInputElement).value = text;
  }
  if (client === operationChat && !resetting) render(frame);
}
function bubble(m: Msg) {
  const b = el("div", "bubble" + (m.who === "you" ? " you" : ""), m.text);
  b.dataset.messageId = String(m.id);
  return b;
}
function chat(d: Derived) {
  if (role === "observer") return;
  $("chat-name").textContent = agentOf();
  const op = operationChat?.operation;
  const turn = operationChat?.pendingTurn;
  const latestTurn = operationChat?.turns.at(-1);
  $("chat-sub").textContent = chatError || (turn ? "Planning" : latestTurn?.state === "failed" && (!op || latestTurn.createdAt > op.createdAt) ? "Failed" : op ? (op.outcome ?? fleetOutcome(op)).status : "Awaiting objective");
  $("provider").textContent = modelDriven ? `${inferenceLabel} · ${op?.models?.coordinator || coordinatorModel}` : "Fixture decisions";
  ($("say") as HTMLInputElement).disabled = (modelDriven && !operationChat) || !!operationChat?.sending;
  ($("say") as HTMLInputElement).placeholder = `Message ${agentOf()}`;
  const t = $("transcript");
  const stick = t.scrollHeight - t.scrollTop - t.clientHeight < 40;
  const messages = operationChat?.messages ?? [];
  if (renderedMessages !== messages || !t.querySelector(".interaction, .hint")) {
    renderedMessages = messages;
    const currentIds = new Set(messages.filter((m) => m.speaker === "operator").map((m) => String(m.id)));
    for (const group of Array.from(t.querySelectorAll<HTMLElement>("[data-origin-id]"))) if (!currentIds.has(group.dataset.originId!)) group.remove();
    if (!messages.length) {
      if (!t.querySelector(".hint")) t.replaceChildren(el("div", "bubble hint", "Ask about the fleet, or send an objective to deploy specialists."));
    } else t.querySelector(".hint")?.remove();
    for (const user of messages.filter((m) => m.speaker === "operator")) {
      let group = t.querySelector<HTMLElement>(`[data-origin-id="${user.id}"]`);
      if (!group) {
        group = el("section", "interaction");
        group.dataset.originId = String(user.id);
        group.append(bubble({ who: "you", text: user.text, id: user.id }), el("div", "interaction-progress"), el("div", "interaction-response"), el("div", "interaction-outcome"), el("div", "interaction-details"));
        t.append(group);
      }
      const linked = messages.filter((m) => m.replyTo === user.id && m.speaker !== "operator");
      const ownTurn = operationChat?.turns.find((v) => v.messageId === user.id);
      const ownOp = operationChat?.operations.find((v) => v.messageId === user.id);
      group.dataset.turnId = ownTurn?.id ?? "";
      group.dataset.operationId = ownOp?.id ?? "";
      const pending = activeOperation(ownOp) || !!ownTurn && ["queued", "running"].includes(ownTurn.state);
      const progress = group.querySelector<HTMLElement>(".interaction-progress")!;
      progress.hidden = !pending;
      progress.setAttribute("role", "status");
      progress.textContent = ownOp?.state === "running" ? `Running · ${ownOp.workers.filter((w) => w.state === "working").length} agents working` : "Planning · Preparing your request…";
      const response: HTMLElement[] = [];
      const reply = linked.find((m) => m.kind === "answer");
      if (ownOp?.deployment?.assignments.length) {
        const card = el("div", "bubble deployment");
        if (reply) card.dataset.messageId = String(reply.id);
        card.append(el("p", "", ownOp.deployment.summary));
        const list = el("ul");
        for (const a of ownOp.deployment.assignments) list.append(el("li", "", `${a.name} → ${tag(a.target)} · ${a.summary}`));
        card.append(list);
        response.push(card);
      } else if (!ownOp && reply) response.push(bubble({ who: "agent", text: ownTurn?.error ? explainFleetError(ownTurn.error) : reply.text, id: reply.id }));
      if (resilienceMode && ownOp) for (const r of ownOp.results.filter((r) => r.status === "executed" && r.kind !== "wait").slice(-6)) {
        const action = el("div", "bubble action-card");
        action.dataset.actionId = r.actionId ?? "";
        action.append(el("b", "", `${tag(r.target ?? 0)} · ${r.kind?.replaceAll("_", " ")}`));
        const observed = Array.isArray(r.observation) ? r.observation[0] : undefined;
        action.append(el("p", "", `Intent: ${r.intent ?? ownOp.message}`), el("p", "", `Observation: ${observed ? observed.anomaly ? "Anomaly observed" : "No anomaly observed" : "Target not yet observed"}`),
          el("p", "", `Action: ${r.kind?.replaceAll("_", " ")}`),
          el("p", "", `Verified outcome: ${r.verifiedEffectEvidenceId ? "Mission work reduced" : r.outcome?.endsWith("_scheduled") ? "Event scheduled; mission impact unverified" : r.outcome?.replaceAll("_", " ")} (${r.responseStatus ?? "no response"})`));
        response.push(action);
      }
      patchContent(group.querySelector<HTMLElement>(".interaction-response")!, response);
      const outcomes: HTMLElement[] = [];
      if (ownOp && !activeOperation(ownOp)) {
        const outcome = ownOp.outcome ?? fleetOutcome(ownOp);
        const card = el("div", "bubble outcome");
        card.dataset.status = outcome.status;
        card.append(el("b", "", outcome.status), el("p", "", outcome.summary));
        if (outcome.succeeded < outcome.total) card.append(el("p", "", `${outcome.succeeded} of ${outcome.total} assignments succeeded.`));
        const error = ownOp.workers.find((w) => w.error)?.error ?? ownOp.results.find((r) => r.error)?.error;
        if (error) card.append(el("p", "", explainFleetError(error)));
        if (outcome.evidenceIds.length) card.append(el("span", "evidence", `Evidence ${outcome.evidenceIds.map((id) => "#" + id).join(" · ")}`));
        outcomes.push(card);
      }
      patchContent(group.querySelector<HTMLElement>(".interaction-outcome")!, outcomes);
      const detailData = { turn: ownTurn, operation: ownOp, messages: [user, ...linked] };
      patchContent(group.querySelector<HTMLElement>(".interaction-details")!, [technicalDetails(detailData, "Details and evidence")]);
    }
  }
  typing.hidden = !operationChat?.sending;
  typing.textContent = "Sending…";
  if (!t.contains(typing)) t.append(typing);

  if (stick) t.scrollTop = t.scrollHeight;
  const slotEl = $("context-slot"),
    s = frame.drones.find((x) => x.id === selected);
  if (!s)
    slotEl.replaceChildren(el("span", "", "Click a drone to talk about it"));
  else if (
    slotEl.querySelector(".chip")?.firstChild?.textContent !== tag(s.id)
  ) {
    const chip = el("div", "chip", tag(s.id));
    chip.append(
      el("span", "tag " + stateLabel(d.state(s))[1], stateLabel(d.state(s))[0]),
    );
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
let resolution = new ViewportResolution(devicePixelRatio);
try {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(resolution.ratio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.append(renderer.domElement);
} catch {
  fallback = document.createElement("canvas");
  host.append(fallback);
}
const webglNote = renderer
  ? ""
  : "WebGL unavailable · using the interactive projected map.";
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
    .replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\nvHeight = position.y;",
    );
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
const padGridMat = new THREE.LineBasicMaterial({
  color: 0x1d2c38,
  transparent: true,
  opacity: 0.9,
});
const padEdge = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)),
  new THREE.LineBasicMaterial({ color: 0x3a5163 }),
);
padEdge.position.y = 0.06;
scene.add(pad, padEdge);
// FC-01: the fleet controller every command goes through, drawn as a ground mast.
const mast = new THREE.Group();
const mastMat = new THREE.MeshStandardMaterial({
  color: 0x2b3a48,
  roughness: 0.7,
  metalness: 0.4,
});
const mastBase = new THREE.Mesh(
  new THREE.CylinderGeometry(2.2, 2.6, 1.2, 8),
  mastMat,
);
mastBase.position.y = 0.6;
const mastPole = new THREE.Mesh(
  new THREE.CylinderGeometry(0.18, 0.28, 16, 6),
  mastMat,
);
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
  const key = [box.min.x, box.max.x, box.min.z, box.max.z]
    .map((v) => Math.round(v / 6))
    .join();
  if (key === terrainKey) return;
  terrainKey = key;
  const cx = (box.min.x + box.max.x) / 2,
    cz = (box.min.z + box.max.z) / 2,
    hx = (box.max.x - box.min.x) / 2 + 14,
    hz = (box.max.z - box.min.z) / 2 + 14,
    size = 1400,
    seg = 220;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg).rotateX(
    -Math.PI / 2,
  );
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
    col
      .copy(low)
      .lerp(mid, Math.min(1, t * 2))
      .lerp(high, Math.max(0, t * 2 - 1));
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
  for (let x = -hx; x <= hx + 0.01; x += 6)
    pts.push(cx + x, 0.04, cz - hz, cx + x, 0.04, cz + hz);
  for (let z = -hz; z <= hz + 0.01; z += 6)
    pts.push(cx - hx, 0.04, cz + z, cx + hx, 0.04, cz + z);
  padGrid = new THREE.LineSegments(
    new THREE.BufferGeometry().setAttribute(
      "position",
      new THREE.Float32BufferAttribute(pts, 3),
    ),
    padGridMat,
  );
  scene.add(padGrid);
  mast.position.set(cx - hx * 0.6, 0, cz - hz - 14);
}

const sceneryBox = new THREE.Box3(new THREE.Vector3(-3, 0, -3), new THREE.Vector3(93, 14, 24));
buildTerrain(sceneryBox);

// Per-drone parts. Neighbours can come within ~4 m, so every marker stays under a 2 m radius.
const mat = (color: number) =>
  new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.22,
    metalness: 0.25,
    roughness: 0.5,
  });
const materials = {
  red: mat(0xf02d38),
  blue: mat(0x5b9dff),
  green: mat(0x2bd47f),
  grey: mat(0xa9b4c1),
  dim: mat(0x77818d),
};
type Tone = keyof typeof materials;
const flat = (color: number, opacity: number) =>
  new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
const shadowMat: Record<Tone, THREE.MeshBasicMaterial> = {
  red: flat(0xf02d38, 0.45),
  blue: flat(0x5b9dff, 0.28),
  green: flat(0x2bd47f, 0.3),
  grey: flat(0xa9b4c1, 0.22),
  dim: flat(0x77818d, 0.25),
};
const HEX: Record<Tone, string> = {
  red: "#f02d38",
  blue: "#5b9dff",
  green: "#2bd47f",
  grey: "#a9b4c1",
  dim: "#77818d",
};
const discGeo = new THREE.CircleGeometry(0.9, 20).rotateX(-Math.PI / 2);
const stemMat = new THREE.LineBasicMaterial({
  color: 0x4a5d6d,
  transparent: true,
  opacity: 0.55,
});
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
const isoMat = new THREE.LineDashedMaterial({
  color: 0xc2cad4,
  dashSize: 0.45,
  gapSize: 0.35,
  transparent: true,
  opacity: 0.85,
});
const isoTemplate = new THREE.Line(isoGeo, isoMat).computeLineDistances();
// Ghost: the slot the drone would hold if it were flying in step, tethered to where it is.
const ghostGeo = new THREE.RingGeometry(1.05, 1.2, 32).rotateX(-Math.PI / 2);
const ghostMat = flat(0xe8eef6, 0.35);
const tetherMat = new THREE.LineDashedMaterial({
  color: 0xe8b04f,
  dashSize: 0.6,
  gapSize: 0.45,
  transparent: true,
  opacity: 0.7,
});
const ghosts = new THREE.Group();
scene.add(ghosts);
const DRONE_SCALE = 1.45; // model is ~2.4 m across
const body = new THREE.BoxGeometry(1.2, 0.3, 0.65),
  arm = new THREE.BoxGeometry(2.4, 0.09, 0.12),
  rotor = new THREE.CylinderGeometry(0.34, 0.34, 0.04, 12);
const procedural = new THREE.Group();
procedural.add(new THREE.Mesh(body, materials.blue));
for (const angle of [Math.PI / 4, -Math.PI / 4]) {
  const a = new THREE.Mesh(arm, materials.blue);
  a.rotation.y = angle;
  procedural.add(a);
}
for (const x of [-0.85, 0.85])
  for (const z of [-0.85, 0.85]) {
    const r = new THREE.Mesh(rotor, materials.blue);
    r.position.set(x, 0.12, z);
    procedural.add(r);
  }
let sharedDrone = droneGeometry(procedural);
body.dispose(); arm.dispose(); rotor.dispose();
const batches = new Map<Tone, { body: THREE.InstancedMesh; shadow: THREE.InstancedMesh }>();
let instanceCapacity = 0;
const instancePose = new THREE.Object3D();
function ensureInstances(count: number) {
  if (!renderer || count <= instanceCapacity) return;
  instanceCapacity = Math.max(64, 2 ** Math.ceil(Math.log2(count)));
  for (const pair of batches.values())
    for (const mesh of [pair.body, pair.shadow]) { scene.remove(mesh); mesh.dispose(); }
  batches.clear();
  for (const tone of Object.keys(materials) as Tone[]) {
    const body = new THREE.InstancedMesh(sharedDrone, materials[tone], instanceCapacity);
    const shadow = new THREE.InstancedMesh(discGeo, shadowMat[tone], instanceCapacity);
    for (const mesh of [body, shadow]) {
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Instances move independently; stale aggregate bounds would hide drones after updates.
      mesh.frustumCulled = false;
      scene.add(mesh);
    }
    batches.set(tone, { body, shadow });
  }
}
// Reuse the inspected blockout, flattening its nine parts once rather than cloning per drone.
new GLTFLoader().load(
  "/assets/swarm-blockout.glb",
  (gltf) => {
    const source = gltf.scene.getObjectByName("HERO_drone");
    if (source) {
      source.removeFromParent();
      source.position.set(0, 0, 0);
      const previous = sharedDrone;
      sharedDrone = droneGeometry(source);
      for (const pair of batches.values()) pair.body.geometry = sharedDrone;
      previous.dispose();
      gltf.scene.add(source);
      redraw();
    }
    const geometries = new Set<THREE.BufferGeometry>(), loadedMaterials = new Set<THREE.Material>();
    gltf.scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      geometries.add(o.geometry);
      for (const material of Array.isArray(o.material) ? o.material : [o.material]) loadedMaterials.add(material);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of loadedMaterials) material.dispose();
  },
  undefined,
  () => { /* Procedural geometry remains the fallback. */ },
);
const drones = new Map<number, THREE.Group>();
function clearDrones() {
  for (const g of drones.values()) {
    scene.remove(g);
    g.userData.ripple.material.dispose();
    g.userData.tether.geometry.dispose();
  }
  drones.clear();
  ghosts.clear();
  links = [];
  linkKey = "";
  for (const pair of batches.values()) pair.body.count = pair.shadow.count = 0;
}
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
  const ring = new THREE.Mesh(ringGeo, ringRed);
  const ripple = new THREE.Mesh(ringGeo, flat(0xe8b04f, 0.8));
  const sel = new THREE.Mesh(selGeo, selMat);
  craft.add(model, ring, ripple, sel);
  const iso = isoTemplate.clone();
  iso.position.y = 0.1;
  root.add(craft, iso);
  const ghost = new THREE.Mesh(ghostGeo, ghostMat);
  const tether = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(),
    ]),
    tetherMat,
  );
  tether.geometry.setAttribute("lineDistance", new THREE.BufferAttribute(new Float32Array(2), 1).setUsage(THREE.DynamicDrawUsage));
  (tether.geometry.getAttribute("position") as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
  tether.frustumCulled = false;
  ghost.visible = tether.visible = false;
  ghosts.add(ghost, tether);
  root.userData = {
    id,
    craft,
    model,
    ring,
    ripple,
    sel,
    iso,
    ghost,
    tether,
    tone: "blue",
    phase: (id * 0.37) % 1,
    // Displayed position eases toward the latest database position between updates.
    // Displayed position = flock warp of the eased database position (raw/want), in Three axes.
    pos: new THREE.Vector3(),
    raw: new THREE.Vector3(),
    want: new THREE.Vector3(),
    ghostPos: new THREE.Vector3(),
    ghostRaw: new THREE.Vector3(),
    ghostWant: new THREE.Vector3(),
    clock: new FlockClock(lastT / 1000),
    comp: false,
    trail: new Float64Array(TRAIL_POINTS * 4), // x, y, z, time; circular buffer
    trailHead: 0,
    trailCount: 0,
    fresh: true,
  };
  return root;
}
let lastT = 0;
/* ---------- flock: display-only warp of the slot grid (web/flock.ts) ---------- */
// Formation origin eases toward the measured one so a changing median never snaps the shape.
const form: Formation = { ox: 0, oy: 0, rows: 3 },
  formWant: Formation = { ox: 0, oy: 0, rows: 3 };
/** Database axes [x, y, z] -> displayed Three position, optionally posing the model. */
function place(
  raw: THREE.Vector3,
  id: number,
  clock: FlockClock,
  out: THREE.Vector3,
  model?: THREE.Object3D,
) {
  const pose = reduced.matches
    ? display([raw.x, raw.z, raw.y], id, form)
    : display([raw.x, raw.z, raw.y], id, form, clock.t, clock.sync);
  out.set(pose.x, pose.z, pose.y);
  model?.rotation.set(pose.pitch, pose.yaw, pose.roll);
  return out;
}
const TRAIL_S = 2, TRAIL_POINTS = 42;
const trails = new FleetLines(), net = new FleetLines(), stems = new FleetLines(stemMat);
const stemColor = new THREE.Color(0xffffff);
scene.add(trails, net, stems);
let links: [THREE.Group, THREE.Group][] = [];
let linkKey = "";
const toneRGB = (tone: Tone) => materials[tone].color;
function flockLines(now: number) {
  trails.begin(drones.size * (TRAIL_POINTS - 1) * 2);
  if (!reduced.matches)
    for (const g of drones.values()) {
      if (!g.visible) continue;
      const u = g.userData, tr: Float64Array = u.trail, c = toneRGB(u.tone);
      const last = (u.trailHead + u.trailCount - 1) % TRAIL_POINTS;
      if (!u.trailCount || now - tr[last * 4 + 3] >= 0.05) {
        if (u.trailCount === TRAIL_POINTS) {
          u.trailHead = (u.trailHead + 1) % TRAIL_POINTS;
          u.trailCount--;
        }
        const at = ((u.trailHead + u.trailCount++) % TRAIL_POINTS) * 4;
        tr[at] = u.pos.x; tr[at + 1] = u.pos.y; tr[at + 2] = u.pos.z; tr[at + 3] = now;
      }
      while (u.trailCount && now - tr[u.trailHead * 4 + 3] > TRAIL_S) {
        u.trailHead = (u.trailHead + 1) % TRAIL_POINTS;
        u.trailCount--;
      }
      for (let i = 1; i < u.trailCount; i++) {
        const a = ((u.trailHead + i - 1) % TRAIL_POINTS) * 4,
          b = ((u.trailHead + i) % TRAIL_POINTS) * 4;
        trails.segment(tr[a], tr[a + 1], tr[a + 2], tr[b], tr[b + 1], tr[b + 2], c,
          0.5 * (1 - (now - tr[a + 3]) / TRAIL_S), 0.5 * (1 - (now - tr[b + 3]) / TRAIL_S));
      }
    }
  trails.end();
  net.begin(links.length * 2);
  const red = toneRGB("red");
  for (const [ag, bg] of links) {
    const a = ag.userData, b = bg.userData;
    const fade = linkFade(a.pos.distanceTo(b.pos) / Math.max(1, a.ghostPos.distanceTo(b.ghostPos)));
    if (fade <= 0) continue;
    const hot = a.comp || b.comp;
    net.segment(a.pos.x, a.pos.y, a.pos.z, b.pos.x, b.pos.y, b.pos.z,
      hot ? red : toneRGB("grey"), fade * (hot ? 0.5 : 0.14));
  }
  net.end();
}
function updateInstances() {
  ensureInstances(drones.size);
  for (const pair of batches.values()) pair.body.count = pair.shadow.count = 0;
  stems.begin(drones.size * 2);
  for (const g of drones.values()) {
    if (!g.visible) continue;
    const u = g.userData;
    stems.segment(u.pos.x, 0, u.pos.z, u.pos.x, Math.max(0.01, u.pos.y - 0.3), u.pos.z, stemColor, 1);
    const pair = batches.get(u.tone);
    if (!pair) continue;
    instancePose.position.copy(u.pos);
    instancePose.quaternion.copy(u.model.quaternion);
    instancePose.scale.setScalar(DRONE_SCALE * u.craft.scale.x);
    instancePose.updateMatrix();
    pair.body.setMatrixAt(pair.body.count++, instancePose.matrix);
    instancePose.position.set(u.pos.x, 0.08, u.pos.z);
    instancePose.quaternion.identity();
    instancePose.scale.setScalar(1);
    instancePose.updateMatrix();
    pair.shadow.setMatrixAt(pair.shadow.count++, instancePose.matrix);
  }
  stems.end();
  for (const pair of batches.values())
    for (const mesh of [pair.body, pair.shadow]) {
      mesh.visible = mesh.count > 0;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16);
      mesh.instanceMatrix.needsUpdate = true;
    }
}
// Ease database positions (~0.15 s); jumps over 30 m snap (scrubbing). Display adds the flock warp.
function glide(dt: number, now: number) {
  const k = reduced.matches ? 1 : 1 - Math.exp(-dt / 0.15);
  form.ox += (formWant.ox - form.ox) * k;
  form.oy += (formWant.oy - form.oy) * k;
  form.rows = formWant.rows;
  let moving = false;
  for (const g of drones.values()) {
    if (!g.visible) continue;
    const u = g.userData;
    if (u.fresh || u.raw.distanceTo(u.want) > 30) {
      u.raw.copy(u.want);
      u.ghostRaw.copy(u.ghostWant);
      u.trailHead = u.trailCount = 0;
      u.fresh = false;
    } else {
      if (u.raw.distanceToSquared(u.want) > 1e-4) moving = true;
      u.raw.lerp(u.want, k);
      u.ghostRaw.lerp(u.ghostWant, k);
    }
    u.clock.step(dt, now, u.comp);
    place(u.raw, u.id, u.clock, u.pos, u.model);
    place(u.ghostRaw, u.id, u.clock, u.ghostPos);
    g.position.set(u.pos.x, 0, u.pos.z);
    u.craft.position.y = u.pos.y;
    if (u.ghost.visible) {
      u.ghost.position.copy(u.ghostPos);
      const a = u.tether.geometry.attributes.position as THREE.BufferAttribute;
      a.setXYZ(0, u.ghostPos.x, u.ghostPos.y, u.ghostPos.z);
      a.setXYZ(1, u.pos.x, u.pos.y, u.pos.z);
      a.needsUpdate = true;
      const distance = u.tether.geometry.getAttribute("lineDistance") as THREE.BufferAttribute;
      distance.setX(1, u.ghostPos.distanceTo(u.pos));
      distance.needsUpdate = true;
    }
  }
  if (renderer) {
    flockLines(now);
    updateInstances();
  }
  return moving;
}
function effects(t: number) {
  const moving = glide(Math.min(0.25, (t - lastT) / 1000 || 0), t / 1000);
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
  const p = (renderer ? shown(d) : new THREE.Vector3(d.x, d.z, d.y)).project(camera);
  return [
    ((p.x + 1) * host.clientWidth) / 2,
    ((1 - p.y) * host.clientHeight) / 2,
    p.z,
  ] as const;
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
  for (let x = -b.x / 2; x <= b.x / 2; x += 6)
    line(
      point(p0.x + x, 0, p0.z - b.z / 2),
      point(p0.x + x, 0, p0.z + b.z / 2),
    );
  for (let z = -b.z / 2; z <= b.z / 2; z += 6)
    line(
      point(p0.x - b.x / 2, 0, p0.z + z),
      point(p0.x + b.x / 2, 0, p0.z + z),
    );
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
  if (document.hidden) { lastT = t; return; }
  if (reduced.matches && !dirty) return;
  if (renderer && !reduced.matches && lastT && resolution.sample(t - lastT))
    renderer.setPixelRatio(resolution.ratio);
  const anim = effects(t);
  if (dirty || anim) {
    dirty = false;
    draw();
  }
}
requestAnimationFrame(loop);
reduced.addEventListener("change", () => {
  for (const g of drones.values()) g.userData.trailHead = g.userData.trailCount = 0;
  redraw();
});
document.addEventListener("visibilitychange", () => {
  lastT = 0;
  resolution.sample(0);
  redraw();
});
new ResizeObserver(() => {
  const w = host.clientWidth,
    h = host.clientHeight;
  if (!w || !h) return;
  resolution = new ViewportResolution(devicePixelRatio);
  renderer?.setPixelRatio(resolution.ratio);
  renderer?.setSize(w, h, false);
  if (fallback) {
    fallback.width = w * Math.min(devicePixelRatio, 1.5);
    fallback.height = h * Math.min(devicePixelRatio, 1.5);
  }
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  fit(true);
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
    if (!g.visible)
      g.userData.ghost.visible = g.userData.tether.visible = false;
  }
  formWant.rows = 1;
  for (const x of frame.drones) {
    let g = drones.get(x.id);
    if (!g) {
      g = meshDrone(x.id);
      drones.set(x.id, g);
      scene.add(g);
    }
    const u = g.userData;
    g.visible = true;
    u.comp = d.state(x) === "comp";
    u.want.set(x.x, x.z, x.y);
    const e = d.expected.get(x.id);
    if (e) {
      formWant.ox = e[0] - slot(x.id)[0];
      formWant.oy = e[1] - slot(x.id)[1];
    }
    formWant.rows = Math.max(formWant.rows, Math.floor((x.id - 1) / 16) + 1);
    const off = (d.deviation.get(x.id) ?? 0) > OFF_FORMATION_M;
    u.ghost.visible = u.tether.visible = !!e && off;
    if (e) u.ghostWant.set(e[0], e[2], e[1]);
    const st = d.state(x);
    const tone: Tone =
      st === "comp"
        ? "red"
        : st === "rec"
          ? role === "attacker"
            ? "dim"
            : "green"
          : role === "attacker"
            ? "grey"
            : "blue";
    u.tone = tone;
    const blockedAt = d.lastBlockedAt.get(x.id);
    u.ring.visible = st === "comp";
    u.ripple.visible =
      st !== "comp" &&
      blockedAt !== undefined &&
      (d.latest - blockedAt) / 1e6 < RECENT_S;
    if (reduced.matches) {
      u.ring.scale.setScalar(1);
      u.ripple.scale.setScalar(1);
    }
    u.iso.visible = role !== "attacker" && x.isolated;
    u.sel.visible = x.id === selected;
    u.craft.scale.setScalar(x.id === selected ? 1.15 : 1);
  }
  if (!ids.has(selected)) selected = 0;
  const nextLinkKey = [...ids].sort((a, b) => a - b).join(",");
  if (linkKey !== nextLinkKey) {
    linkKey = nextLinkKey;
    links = [];
    for (const id of ids)
      for (const other of neighbours(id, ids)) links.push([drones.get(id)!, drones.get(other)!]);
  }
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
    legend([
      ["#F02D38", "Seized"],
      ["#A9B4C1", "Home control"],
      ["ring-key", "Blocked · last 3s"],
      ["ghost", "Formation slot"],
    ]);
  } else {
    $("map-title").textContent =
      role === "defender" ? `Managed swarm · ${n}` : `Full state · ${n}`;
    legend([
      ["#5B9DFF", "Home"],
      ["#F02D38", role === "defender" ? "Compromised" : "Unauthorized"],
      ["#2BD47F", "Recovered"],
      ["ring-key", "Blocked · last 3s"],
      ["iso", "Isolated"],
      ["ghost", "Formation slot"],
    ]);
  }
  if (resilienceMode) {
    $("map-title").textContent = `Synthetic survey fleet · ${n}`;
    legend([["#5B9DFF", "Participating"], ["#F02D38", "Anomaly observed"], ["iso", "Quarantined"], ["ghost", "Formation slot"]]);
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
function adoptEpoch(epoch: number) {
  if (!Number.isSafeInteger(epoch) || epoch <= fleetEpoch) return;
  fleetEpoch = epoch;
  operationChat?.advanceEpoch(epoch);
  typing.hidden = true;
  chatError = "";
  $("error").textContent = webglNote;
  ($("say") as HTMLInputElement).value = "";
  selected = selectedEvent = hovered = 0;
  onlySel = false;
  filter = "all";
  closeModal();
  clearDrones();
  fitted = "";
  userMoved = false;
  frame = EMPTY;
}
function render(next: Frame) {
  if (resetting) return;
  const epoch = next.epoch ?? next.drones[0]?.epoch ?? next.agents[0]?.epoch;
  if (epoch !== undefined && epoch < fleetEpoch) return;
  if (epoch !== undefined) adoptEpoch(epoch);
  if (next.conversation !== undefined) operationChat?.advanceConversation(next.conversation);
  frame = next;
  resilienceMode = !!next.mission;
  document.body.dataset.role = role;
  document.body.dataset.resilience = String(resilienceMode);
  document
    .querySelectorAll<HTMLButtonElement>("nav button")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.role === role)),
    );
  const d = derive(frame);
  header(d);
  rails(d);
  mapScene(d);
  chat(d);
  log(d);
  if (modalAgent) fillModal(d);
  redraw();
}
function setStatus(text: string, kind: "live" | "stale" | "replay") {
  const p = $("live");
  p.textContent = kind === "live" && modelDriven
    ? operationChat?.fleet?.active === false ? "Fleet ended"
      : `Live · ${operationChat?.operation ? (operationChat.operation.outcome ?? fleetOutcome(operationChat.operation)).status : "Awaiting objective"}`
    : kind === "live" ? "Live" : kind === "stale" ? text.startsWith("Disconnected") ? "Disconnected" : "Stale" : "Replay";
  p.className = "pill " + (kind === "live" ? "" : kind);
  p.title = text;
}
async function workspace(next: Role) {
  if (resetting) return;
  if (next === role && operationChat) return;
  const v = ++version;
  fitted = "";
  userMoved = false;
  close();
  stateConnected = false;
  setStatus("Connecting…", "stale");
  lastReceived = 0;
  operationChat?.close();
  operationChat = undefined;
  role = next;
  chatError = "";
  ($("say") as HTMLInputElement).value = "";
  selected = 0;
  selectedEvent = 0;
  onlySel = false;
  playing = false;
  closeModal();
  typing.hidden = true;
  // The only full transcript rebuild: switching role swaps in that role's conversation.
  $("transcript").replaceChildren(typing);
  $("rail-right").hidden = role !== "observer";
  $("chat").hidden = role === "observer";
  $("error").textContent = webglNote;
  render(EMPTY);
  if (recording) {
    render(recording.frames[index][role]);
    setStatus("Recorded · fixture", "replay");
    return;
  }
  const response = await fetch(`/fleet-config?role=${role}`);
  if (!response.ok) {
    const link = el(
      "a",
      "",
      "Sign in with a granted SpacetimeDB viewer identity",
    );
    link.setAttribute("href", "/signin");
    $("error").replaceChildren(link);
    return;
  }
  const config = await response.json();
  if (v !== version) return;
  if (config.recorded) {
    recording = await fetch("/fleet-recording.json").then((r) => r.json());
    ($("timeline") as HTMLInputElement).max = String(
      recording.frames.length - 1,
    );
    render(recording.frames[index][role]);
    setStatus("Recorded · fixture", "replay");
    return;
  }
  live = true;
  resilienceMode = !!config.resilience;
  $("playback").hidden = true;
  role = config.role;
  sessionStorage.setItem("sudoko.role", role);
  adoptEpoch(config.epoch);
  modelDriven = !!config.authenticated;
  demoMode = !!config.demo;
  sandboxName = config.sandbox;
  coordinatorModel = config.models?.coordinator || "";
  inferenceLabel = config.engine === "mocked" ? "Mocked decisions" : "Bitdeer";
  $("rail-right").hidden = role !== "observer";
  $("chat").hidden = role === "observer";
  document
    .querySelectorAll<HTMLButtonElement>("nav button")
    .forEach(
      (b) =>
        (b.disabled =
          !!config.authenticated &&
          !(config.switchableRoles ?? [role]).includes(b.dataset.role)),
    );
  if (config.chat) {
    $("transcript").replaceChildren(typing);
    operationChat = new OperationChat(
      config.sandbox,
      role,
      () => {
        if (v !== version || resetting) return;
        chatError = "";
        if (operationChat?.fleet) adoptEpoch(operationChat.fleet.epoch);
        render(frame);
      },
      (message) => {
        if (v !== version || resetting) return;
        chatError = message;
        chat(derive(frame));
      },
      config.epoch,
      config.conversation,
    );
    void operationChat.resume();
  }
  let attempt = 0;
  const pollState = () => {
    ++attempt;
    close();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    close = () => { stopped = true; clearTimeout(timer); };
    const poll = async () => {
      try {
        const response = await fetch("/api/chat/state", {
          signal: AbortSignal.timeout(8000),
          headers: { "x-sudoko-role": role },
        });
        if (!response.ok) throw Error("Fleet state unavailable");
        const snapshot: Frame = await response.json();
        if (stopped || v !== version) return;
        stateConnected = true;
        lastReceived = Date.now();
        render(snapshot);
        setStatus("Connected · authoritative snapshots every second", "live");
      } catch {
        if (stopped || v !== version) return;
        stateConnected = false;
        setStatus("Disconnected · state frozen", "stale");
      }
      if (!stopped && v === version) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
  };
  const connect = (uri: string) => {
    const current = ++attempt;
    const conn = DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(config.database)
      .withToken(config.token)
      .onConnect((c) => {
        if (v !== version || current !== attempt) {
          c.disconnect();
          return;
        }
        stateConnected = true;
        let queued = false;
        const update = () => {
          if (queued) return;
          queued = true;
          // One redraw per animation frame; each reducer transaction arrives as its own message.
          requestAnimationFrame(() => {
            queued = false;
            if (v !== version || current !== attempt) return;
            lastReceived = Date.now();
            setStatus(
              config.authenticated ? "Live · model operations" : "Live · fixture",
              "live",
            );
            const snake = (o: any) =>
              Object.fromEntries(
                Object.entries(o).map(([k, val]) => [
                  k.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase()),
                  typeof val === "bigint" ? Number(val) : val,
                ]),
              );
            const session = [...c.db.visibleFleetSession.iter()][0];
            if (!session) return;
            render({
              epoch: Number(session.epoch),
              conversation: Number(session.conversation),
              active: session.active,
              mission: [...c.db.visibleResilienceMission.iter()].map(snake)[0] as Mission | undefined,
              resilience: [...c.db.visibleResilienceDrones.iter()].map(snake) as ResilienceDrone[],
              budgets: [...c.db.visibleResilienceBudget.iter()].map(snake) as { role: string; remaining: number }[],
              drones: [...c.db.visibleDrones.iter()].map(snake) as Drone[],
              agents: [...c.db.visibleAgents.iter()].map((a) => ({ ...snake(a), ...snake([...c.db.visibleAgentProfiles.iter()].find((p) => p.id === a.id) ?? {}) })) as Agent[],
              events: ([...c.db.visibleEvidence.iter()].map(snake) as Ev[]).sort(
                (a, b) => a.id - b.id,
              ),
            });
          });
        };
        for (const table of [
          c.db.visibleFleetSession,
          c.db.visibleDrones,
          c.db.visibleAgents,
          c.db.visibleAgentProfiles,
          c.db.visibleEvidence,
          c.db.visibleResilienceMission,
          c.db.visibleResilienceDrones,
          c.db.visibleResilienceBudget,
        ] as any[]) {
          table.onInsert(update);
          table.onUpdate(update);
          table.onDelete(update);
        }
        c.subscriptionBuilder()
          .onApplied(update)
          .subscribe([
            "SELECT * FROM visible_fleet_session",
            "SELECT * FROM visible_drones",
            "SELECT * FROM visible_agents",
            "SELECT * FROM visible_agent_profiles",
            "SELECT * FROM visible_evidence",
            "SELECT * FROM visible_resilience_mission",
            "SELECT * FROM visible_resilience_drones",
            "SELECT * FROM visible_resilience_budget",
          ]);
      })
      .onConnectError(() => {
        if (v !== version || current !== attempt) return;
        stateConnected = false;
        setStatus("Disconnected · state frozen", "stale");
        pollState();
      })
      .onDisconnect(() => {
        if (v === version && current === attempt) {
          stateConnected = false;
          setStatus("Disconnected · state frozen", "stale");
          pollState();
        }
      })
      .build();
    close = () => conn.disconnect();
  };
  connect(config.uri);
}

/* ---------- controls ---------- */
const PLAY =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4l14 8-14 8z"/></svg>',
  PAUSE =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
function setPlaying(p: boolean) {
  playing = p;
  $("play").innerHTML = p ? PAUSE : PLAY;
  $("play").setAttribute(
    "aria-label",
    p ? "Pause recording" : "Play recording",
  );
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
/** Displayed position of a drone: the live one when known, else the static flock shape. */
function shown(d: Drone) {
  const u = drones.get(d.id)?.userData;
  if (u && !u.fresh) return (u.pos as THREE.Vector3).clone();
  const p = display([d.x, d.y, d.z], d.id, form);
  return new THREE.Vector3(p.x, p.z, p.y);
}
function fit(force = false) {
  const n = frame.drones.length,
    w = host.clientWidth,
    h = host.clientHeight;
  if (!w || !h) return;
  const key = `${role}:${fleetEpoch}:${n}:${overhead}:${w}x${h}`;
  if (!force && userMoved) return;
  if (!force && key === fitted) {
    // Follow an escaping swarm only before the user takes control of the camera.
    const outside = frame.drones.some((d) => {
      const p = shown(d).project(camera);
      return Math.abs(p.x) > 0.92 || p.y < -0.84 || p.y > 0.86 || p.z > 1;
    });
    if (!outside) return;
  }
  fitted = key;
  // The first frame can arrive before the ResizeObserver corrects the default aspect of 1.
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const box = n ? new THREE.Box3() : sceneryBox.clone();
  for (const d of frame.drones) box.expandByPoint(shown(d));
  box.min.y = 0;
  // Margin covers the flow waves (±3.5 m lateral, ±4.5 m altitude) on top of the static shape.
  box.expandByVector(new THREE.Vector3(10, 8, 12));
  buildTerrain(n ? box : sceneryBox);
  const corners = Array.from(
    { length: 8 },
    (_, i) =>
      new THREE.Vector3(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
      ),
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
      .addScaledVector(
        new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0),
        ((x0 + x1) / 2) * halfW,
      )
      .addScaledVector(
        new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1),
        ((y0 + y1) / 2 - (YL + YH) / 2) * halfH,
      );
  }
  place(dist);
  controls.maxDistance = Math.max(900, dist * 2);
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
async function resetFleet(demo: boolean) {
  if (!demoMode || resetting) return;
  if (demo && !confirm("Reset the shared demo for both roles? This stops all agents, restores the fleet, and clears both conversations.")) return;
  resetting = true;
  const name = resilienceMode ? "Reset Arena" : demo ? "Reset Demo" : "Reset Swarm";
  const status = $("reset-status");
  status.textContent = `${name}: resetting…`;
  for (const id of ["reset-swarm", "reset-sandbox", "new-chat", "say", "send"]) ($(id) as HTMLButtonElement).disabled = true;
  ++version;
  close();
  operationChat?.close();
  operationChat = undefined;
  let feedback: string;
  try {
    const response = await fetch(demo ? "/api/chat/reset-demo" : "/api/chat/reset", {
      method: "POST", signal: AbortSignal.timeout(30000),
      headers: { "content-type": "application/json", "x-sudoko-role": role },
      body: JSON.stringify({ epoch: fleetEpoch, ...(demo ? { confirm: true } : {}) }),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || `${name} failed`);
    feedback = resilienceMode || demo ? "Arena reset verified. Both chats are fresh." : "Swarm reset verified. Conversations preserved.";
  } catch (error) {
    feedback = error instanceof Error ? error.message : `${name} failed`;
  } finally {
    resetting = false;
    for (const id of ["reset-swarm", "reset-sandbox", "new-chat", "say", "send"]) ($(id) as HTMLButtonElement).disabled = false;
    try { await workspace(role); }
    catch (error) { feedback = `${feedback!} Could not reconnect: ${error instanceof Error ? error.message : "connection failed"}`; }
    status.textContent = feedback!;
  }
}
$("reset-swarm").onclick = () => void resetFleet(false);
$("reset-sandbox").onclick = () => void resetFleet(true);
$("new-chat").onclick = async () => {
  const client = operationChat;
  if (!client || resetting) return;
  const button = $("new-chat") as HTMLButtonElement;
  button.disabled = true;
  button.textContent = "Starting…";
  try {
    await client.newChat();
    if (client !== operationChat) return;
    ($("say") as HTMLInputElement).value = "";
    $("reset-status").textContent = "New chat started. Shared fleet preserved.";
  } catch (error) {
    $("reset-status").textContent = error instanceof Error ? error.message : "New Chat failed";
  } finally {
    button.disabled = false;
    button.textContent = "New Chat";
  }
};
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
  if (e.key === "Tab" && modalAgent) {
    const controls = Array.from($("modal").querySelectorAll<HTMLElement>("button, summary, [tabindex='0']")).filter((n) => n.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
  }
});
setInterval(() => {
  if (!live || resetting) return;
  if (!stateConnected) { setStatus("Disconnected · state frozen", "stale"); return; }
  const updated = modelDriven ? operationChat?.lastUpdated || lastReceived : lastReceived;
  if (updated && Date.now() - updated > 5000)
    setStatus("No recent backend updates · state frozen", "stale");
  else setStatus("Connected · role-scoped state", "live");
}, 1000);
function nearest(event: MouseEvent) {
  const bounds = host.getBoundingClientRect();
  let best = 22;
  let id = 0;
  for (const d of frame.drones) {
    const [x, y, z] = screen(d);
    if (z > 1) continue;
    const distance = Math.hypot(
      x - (event.clientX - bounds.left),
      y - (event.clientY - bounds.top),
    );
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
  if (
    downAt &&
    Math.hypot(event.clientX - downAt[0], event.clientY - downAt[1]) > 5
  )
    return;
  const id = nearest(event);
  if (id) pull(id);
};
const savedRole = sessionStorage.getItem("sudoko.role");
void workspace(
  savedRole === "defender" || savedRole === "observer" ? savedRole : "attacker",
).catch((e) => {
  $("error").textContent = `${e.message} Reload to retry.`;
});
