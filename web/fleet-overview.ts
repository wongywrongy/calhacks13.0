import { fleetAssessment } from "./fleet-assessment.ts";
import { attemptOutcome } from "./fleet-activity.ts";

export type OverviewFrame = Parameters<typeof fleetAssessment>[0] & { epoch?: number; active?: boolean };
type Evidence = OverviewFrame["events"][number];
const hit = (e: Evidence) => e.kind === "unauthorized_command_accepted" && e.status === 200 || e.kind === "limited_access" && e.status === 206;
const blocked = (e: Evidence) => e.kind === "unauthorized_command_blocked" && e.status === 403;
const tag = (id: number) => "DR-" + String(id).padStart(3, "0");
const time = (at: number) => new Date(at / 1000).toISOString().slice(11, 19);
export function overviewRecords(frame: OverviewFrame) {
  const assessment = fleetAssessment(frame), known = new Set(frame.drones.map(d => d.id));
  const events = [...new Map(frame.events.filter(e => known.has(e.drone)).map(e => [e.id, e])).values()].sort((a,b) => a.id-b.id);
  const groups = new Map<number, string>();
  for (const a of frame.attempts.filter(a => a.role === "attacker" && a.stage === "resolved")) {
    for (const id of attemptOutcome(a, events).evidenceIds) groups.set(id, a.key);
  }
  const checks = new Set(events.map(e => `${e.drone}:${e.actor}:${e.at}:${e.policy_version}:${e.kind}:${e.status}`));
  const paired = (e: Evidence) => e.kind === "recovery_verified" && e.status === 200 &&
    checks.has(`${e.drone}:${e.actor}:${e.at}:${e.policy_version}:verification_unauthorized:403`) &&
    checks.has(`${e.drone}:${e.actor}:${e.at}:${e.policy_version}:verification_authorized:200`);
  const incidents: { id: string; at: number; targets: number[]; affected: number[]; recovered: number[]; events: Evidence[]; kind: "open" | "recovered" | "blocked" }[] = [];
  const current = new Map<number, typeof incidents[number]>();
  for (const e of events) {
    if (hit(e) || blocked(e)) {
      const id = groups.get(e.id) ?? `e-${e.id}`;
      let incident = incidents.find(i => i.id === id);
      if (!incident) { incident = { id, at: e.at, targets: [], affected: [], recovered: [], events: [], kind: "blocked" }; incidents.push(incident); }
      if (!incident.targets.includes(e.drone)) incident.targets.push(e.drone);
      if (hit(e)) {
        if (!incident.affected.includes(e.drone)) incident.affected.push(e.drone);
        incident.recovered = incident.recovered.filter(id => id !== e.drone);
        incident.kind = "open"; current.set(e.drone, incident);
      }
      incident.events.push(e);
    } else {
      if (!["policy_applied", "verification_unauthorized", "verification_authorized", "recovery_verified", "mission_restored", "recovery_partial"].includes(e.kind)) continue;
      for (const incident of incidents.filter(i => i.affected.includes(e.drone) && (!i.recovered.includes(e.drone) || e.kind === "mission_restored" && current.get(e.drone) === i))) {
        incident.events.push(e);
        if (paired(e) && !incident.recovered.includes(e.drone)) {
          incident.recovered.push(e.drone);
          if (incident.affected.every(id => incident.recovered.includes(id))) incident.kind = "recovered";
        }
      }
    }
  }
  const affected = new Set(events.filter(hit).map(e => e.drone));
  return { ...assessment, incidents: incidents.reverse(), everAffected: affected.size,
    open: incidents.filter(i => i.kind === "open").length,
    cells: frame.drones.map(d => {
      const partial = (frame.battle.find(h => h.drone === d.id)?.contamination ?? 0) > 0;
      const session = events.some(e => e.drone === d.id && hit(e));
      const now = d.controller === "attacker" ? "compromised" : partial ? "partial" : assessment.recoveredIds.includes(d.id) ? "recovered" : assessment.testedIds.includes(d.id) ? "blocked" : "untested";
      return { id: d.id, now, session: session ? "affected" : assessment.testedIds.includes(d.id) ? "blocked" : "untested" };
    }).sort((a,b)=>a.id-b.id),
  };
}

const node = (name: string, text = "", cls = "") => { const n = document.createElement(name); n.textContent = text; n.className = cls; return n; };
export class FleetOverview {
  private filter = "all";
  private drone = 0;
  private mode: "now" | "session" = "now";
  private open = new Set<string>();
  private signature = "";
  private frame?: OverviewFrame;
  private connected = false;
  private received = 0;
  private recorded = false;
  private analysis = document.getElementById("overview-analysis");
  private host: HTMLElement;
  constructor(host: HTMLElement) { this.host = host; }
  update(frame: OverviewFrame, connected: boolean, received: number, recorded = false) {
    this.frame = frame; this.connected = connected; this.received = received; this.recorded = recorded;
    const signature = JSON.stringify([frame.epoch, frame.drones.map(d => [d.id,d.controller,d.isolated,d.policy_version]),frame.battle.map(h=>[h.drone,h.contamination,h.operational]),frame.events.length,frame.events.at(-1)?.id,frame.attempts.map(a=>[a.key,a.stage]),frame.tasks.map(t=>[t.agent,t.state,t.updated_at]),connected,recorded]);
    if (signature === this.signature) return;
    if (frame.epoch !== Number(this.host.dataset.epoch)) { this.drone = 0; this.open.clear(); }
    this.host.dataset.epoch = String(frame.epoch);
    this.signature = signature; this.render();
  }
  private render() {
    const focusKey = (document.activeElement as HTMLElement | null)?.dataset.overviewKey;
    const frame = this.frame!;
    const a = overviewRecords(frame);
    const left = node("aside", "", "overview-results"), center = node("section", "", "overview-timeline"), right = node("aside", "", "overview-fleet");
    left.setAttribute("aria-label", "Session results"); center.setAttribute("aria-label", "Incident timeline"); right.setAttribute("aria-label", "Fleet state");
    const heading = (text: string) => node("h2", text, "overview-heading");
    left.append(heading("Results"));
    for (const [label,value,sub] of [
      ["Tested",`${a.tested} of ${a.total}`,"drones attacked at least once"],
      ["Compromised now",String(frame.drones.filter(d=>d.controller==="attacker").length),"drones under attacker control"],
      ["Ever affected",String(a.everAffected),"unique drones hit this session"],
      ["Recovered",`${a.verifiedRecoveries} verified`,"paired denial and legitimate acceptance"],
      ["Open incidents",`${a.open} of ${a.incidents.length}`,"still need a verified response"],
    ]) { const stat = node("div", "", "overview-stat");stat.append(node("span",label),node("strong",value),node("small",sub));left.append(stat); }
    left.append(heading("Session"),node("p",`Session ${frame.epoch ?? "—"}. Earlier sessions are not counted.`),node("p","Every number comes from recorded results. Not tested does not mean safe.","muted"));
    const controls = node("div", "", "overview-controls");controls.append(heading("Incidents"));
    for (const [key,label,count] of [["all","All",a.incidents.length],["open","Open",a.open],["closed","Closed",a.incidents.length-a.open]]) {
      const b = node("button",`${label} ${count}`);b.dataset.overviewKey=`filter-${key}`;b.setAttribute("aria-pressed",String(this.filter === key));b.onclick=()=>{this.filter=String(key);this.render();};controls.append(b);
    }
    const clear = node("button",this.drone ? `${tag(this.drone)} ×` : "Drone · All");clear.dataset.overviewKey="clear";clear.title="Clear drone filter";clear.onclick=()=>{this.drone=0;this.render();};controls.append(clear);center.append(controls);
    const pending=frame.attempts.filter(a=>a.stage!=="resolved").length;
    const notice = this.recorded ? "Recorded · fixture decisions. These results describe this captured session." : this.connected ? `${frame.active === false ? "Session ended" : "Now"} · ${pending} attempts in progress. Results appear when they finish.`
      : `Disconnected · showing last known records${this.received ? " from " + time(this.received*1000) + " UTC" : ""}. Current progress is unknown.`;
    center.append(node("p",notice,"overview-notice"));
    const failures=frame.tasks.filter(t=>["failed","blocked","exhausted","cancelled"].includes(t.state));
    if (failures.length) center.append(node("p",`${failures.length} assignments failed, blocked, exhausted or cancelled. These are work outcomes, not security results.`,"overview-notice"));
    const list=node("ol","","overview-incidents");
    const items=a.incidents.filter(i=>(this.filter==="all" || (i.kind==="open" ? "open" : "closed")===this.filter)&&(!this.drone||i.targets.includes(this.drone)));
    for (const i of items) {
      const li=node("li","",`overview-incident ${i.kind}`), card=node("article","","overview-card"), details=document.createElement("details");details.open=this.open.has(i.id);
      details.ontoggle=()=>{if(details.open)this.open.add(i.id);else this.open.delete(i.id);};
      const summary=node("summary");summary.dataset.overviewKey=`incident-${i.id}`;summary.append(node("span",i.kind.toUpperCase(),"overview-badge"),node("b",`${i.targets.map(tag).join(", ")} · ${i.kind === "open" ? "response needed" : i.kind === "recovered" ? "recovery verified" : "attack blocked"}`),node("span",`${i.events.length} records`,"mono muted"));
      details.append(summary);
      for (const e of i.events) details.append(node("p",`${time(e.at)} · #${e.id} · ${tag(e.drone)} · ${e.kind.replaceAll("_"," ")} (${e.status}) · policy v${e.policy_version}`,"overview-evidence"));
      card.append(details,node("p",i.kind==="open" ? "An accepted attack has no later paired recovery for every affected target." : i.kind==="recovered" ? "Recovery passed both checks. Mission participation is shown separately." : "The unauthorized command was rejected; this observation does not establish security."));
      for(const id of i.affected) {
        const track=node("div","","overview-track");track.append(node("span",tag(id),"mono"));
        for(const [label,done,tone] of [["Affected",true,"red"],["Policy applied",i.events.some(e=>e.drone===id&&e.kind==="policy_applied"),"blue"],["Verified",i.recovered.includes(id),"green"]] as const) track.append(node("span","→","muted"),node("span",label,`overview-stage ${done ? tone : "todo"}`));
        if(i.events.some(e=>e.drone===id&&e.kind==="mission_restored"&&e.status===200))track.append(node("span","→","muted"),node("span","Back in mission","overview-stage green"));
        card.append(track);
      }
      li.append(node("time",time(i.at),"overview-time mono muted"),node("span","","overview-rail"),card);list.append(li);
    }
    if (!items.length) list.append(node("li",a.incidents.length ? "No incidents match this filter." : "No incidents yet. Completed attack results will appear here. Untested drones remain unknown.","overview-empty"));
    center.append(list);
    const modes=node("div","","overview-controls");modes.append(heading("Fleet"));
    for(const mode of ["now","session"] as const){const b=node("button",mode==="now"?"Now":"Session");b.dataset.overviewKey=`mode-${mode}`;b.setAttribute("aria-pressed",String(this.mode===mode));b.onclick=()=>{this.mode=mode;this.render();};modes.append(b);}right.append(modes);
    const grid=node("div","","overview-grid");grid.setAttribute("role","group");grid.setAttribute("aria-label","Fleet formation; select a drone to filter incidents");
    const counts=new Map<string,number>();
    for (const c of a.cells) {
      const state=c[this.mode];counts.set(state,(counts.get(state)??0)+1);
      const b=node("button","",`overview-cell ${state}`);const label=`${tag(c.id)} · ${state === "untested" ? "not tested" : state}`;b.title=label;b.dataset.overviewKey=`drone-${c.id}`;b.setAttribute("aria-label",label);b.setAttribute("aria-pressed",String(this.drone===c.id));
      b.onclick=()=>{this.drone=this.drone===c.id?0:c.id;this.filter="all";this.render();};grid.append(b);
    }
    right.append(grid);
    const legend=node("ul","","overview-legend");for(const [state,n] of counts){const li=node("li");li.append(node("i","",`overview-cell ${state}`),node("span",state === "untested" ? "Not tested" : state),node("b",String(n)));legend.append(li);}right.append(legend,node("p","Select a drone to show its incidents.","muted"),heading("Now"),node("p",this.connected ? `${a.active} active assignments · ${a.isolated} isolated · ${a.available} available for mission.` : "Unknown until the connection returns."));
    if (this.analysis) right.append(this.analysis);
    const scroll=this.host.querySelector(".overview-timeline")?.scrollTop ?? 0;
    this.host.replaceChildren(left,center,right);center.scrollTop=scroll;
    if (focusKey) Array.from(this.host.querySelectorAll<HTMLElement>("[data-overview-key]")).find(n=>n.dataset.overviewKey===focusKey)?.focus({preventScroll:true});
  }
}
