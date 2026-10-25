export type BattleHealth = { drone: number; contamination: number; operational: boolean; readiness: number };
export type BattleOption = { role: string; drone: number; actions: string[]; reachable: number[]; blocker: string };
export type AttemptActivity = { key: string; epoch: number; operation: string; role: string; agent: number; target: number; kind: string; stage: string; at: number; report: string };
export type AgentTask = { agent: number; epoch: number; role: string; operation: string; name: string; specialty: string; target: number; goal: string; state: string; stage: string; summary: string; updated_at: number; finished_at: number };
export type TeamActivity = { role: string; operation: string; objective: string; targets: number[]; stage: string; summary: string; active_agents: number };
export const taskActive = (task: AgentTask) => ["queued", "running"].includes(task.state);
export function attemptReport(attempt: AttemptActivity): any {
  try { return JSON.parse(attempt.report); } catch { return {}; }
}
export function attemptOutcome(attempt: AttemptActivity, events: {id:number;actor:number;drone:number;at:number}[] = []) {
  const report = attemptReport(attempt), effects: any[] = report.results ?? [];
  const interrupted = /interrupt/i.test(report.summary ?? "");
  const attacking=["command","spread"].includes(attempt.kind);
  const ownership = effects.some(e => e.beforeController !== undefined && e.beforeController !== e.controller) || attacking && report.succeeded>0;
  const contained = effects.some(e => !e.beforeIsolated && e.isolated) || attempt.kind==="isolate" && report.succeeded>0;
  const recovered = effects.some(e => e.beforeContamination > 0 && e.contamination === 0) || attempt.kind==="verify" && report.succeeded>0;
  const restored=attempt.kind==="release" && report.succeeded>0;
  const foothold = effects.some(e => e.openedRoutes?.length > 0);
  const failed = !report.succeeded && !report.partial;
  const label = interrupted ? "Interrupted" : restored ? "Mission restored" : recovered ? "Recovered" : ownership ? "Control changed" : contained ? "Contained" : foothold ? "New route" : failed ? "Failed" : report.partial ? "Partial result" : "Resolved";
  const major = interrupted || ownership || contained || recovered || restored || foothold || attacking && report.partial>0 || failed && ["command", "spread", "verify"].includes(attempt.kind);
  const evidenceIds: number[]=effects.flatMap(e=>e.evidenceIds ?? []);
  // Existing reports predate effect IDs; one reducer transaction shares a timestamp.
  if(!evidenceIds.length){const targets=new Set(effects.map(e=>e.target));for(const e of events)if(e.actor===attempt.agent&&targets.has(e.drone)&&e.at===attempt.at)evidenceIds.push(e.id);}
  return { report, label, major, failed, evidenceIds };
}
export function groupActivity<T extends { major?: boolean; group?: string }>(rows: T[]) {
  const groups = new Map<string,T[]>();
  for (const row of rows) { const key=row.group ?? "routine"; const group=groups.get(key) ?? []; group.push(row); groups.set(key,group); }
  return [...groups.entries()].map(([key,items]) => ({key, items, major:items.some(i=>i.major), collapsed:items.length>1 || !items[0]?.major}));
}
type Suggestion = { text: string; target: number };
const tag = (id: number) => "DR-" + String(id).padStart(3,"0");
export function stateSuggestions(state: { role: string; selected: number; drones: {id:number; controller:string; isolated:boolean}[]; battle: BattleHealth[]; options: BattleOption[]; teams: TeamActivity[]; attempts: AttemptActivity[] }): Suggestion[] {
  const team=state.teams.find(t=>t.role===state.role);
  if (team?.operation) return [{text:"Explain the current operation",target:0},{text:"What evidence supports the current attempt?",target:0}];
  const choices=state.options.filter(o=>o.role===state.role).sort((a,b)=>Number(b.drone===state.selected)-Number(a.drone===state.selected)||a.drone-b.drone);
  const drone=(id:number)=>state.drones.find(d=>d.id===id);
  const health=(id:number)=>state.battle.find(h=>h.drone===id);
  const out:Suggestion[]=[];
  const offer=(text:string,target:number)=>{if(out.length<3&&!out.some(s=>s.text===text))out.push({text,target});};
  const last=[...state.attempts].filter(a=>a.stage==="resolved"&&a.role===state.role).sort((a,b)=>b.at-a.at)[0];
  if(state.role==="attacker") {
    const relay=choices.find(o=>o.actions.includes("spread")&&o.reachable.length);
    if(relay){offer(`Which drones are newly reachable from ${tag(relay.drone)}?`,relay.drone);offer(`Attempt spread through ${tag(relay.drone)}`,relay.drone);}
    const entry=choices.find(o=>o.actions.includes("command")&&drone(o.drone)?.controller!=="attacker");
    if(entry)offer(`Attempt entry on ${tag(entry.drone)}`,entry.drone);
    if(!relay&&last&&/isolat|route|interrupt/i.test(attemptReport(last).summary ?? ""))offer("Which alternative connections remain?",0);
    if(!state.drones.length)offer("Discover two catalog drones",0);
  } else if(state.role==="defender") {
    const threat=choices.find(o=>(health(o.drone)?.contamination ?? 0)>0||drone(o.drone)?.controller==="attacker");
    if(threat){
      if(threat.actions.includes("verify")){offer(`What evidence supports recovery of ${tag(threat.drone)}?`,threat.drone);offer(`Attempt recovery on ${tag(threat.drone)}`,threat.drone);}
      else if(threat.actions.includes("isolate"))offer(`Attempt to isolate ${tag(threat.drone)}`,threat.drone);
      else if(threat.actions.includes("harden"))offer(`Attempt to harden ${tag(threat.drone)}`,threat.drone);
    }
    const ready=choices.find(o=>o.actions.includes("release"));
    if(ready)offer(`Attempt to return ${tag(ready.drone)} to the mission`,ready.drone);
    const unguarded=choices.find(o=>o.actions.includes("harden")&&!drone(o.drone)?.isolated);
    if(!threat&&unguarded)offer(`What defenses protect ${tag(unguarded.drone)}?`,unguarded.drone);
  }
  if(last&&attemptOutcome(last).failed)offer(`Explain the last ${last.kind} attempt`,last.target);
  if(out.length<2)offer("What does the current evidence show?",0);
  return out.slice(0,3);
}
