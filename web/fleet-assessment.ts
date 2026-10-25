import { attemptReport, taskActive, type AttemptActivity, type AgentTask } from "./fleet-activity.ts";

type Evidence = { id: number; drone: number; actor: number; kind: string; status: number; policy_version: number; at: number };
// Summarize subscribed simulation records only; model explanations are not evidence.
export function fleetAssessment(state: {
  drones: { id: number; controller: string; isolated: boolean; policy_version: number }[];
  battle: { drone: number; contamination: number; operational: boolean }[];
  attempts: AttemptActivity[]; events: Evidence[]; tasks: AgentTask[];
}) {
  const drones = new Map(state.drones.map(d => [d.id,d])), health = new Map(state.battle.map(h => [h.drone,h]));
  const known = new Set(drones.keys()), tested = new Set<number>();
  for (const attempt of state.attempts) {
    if (attempt.role !== "attacker" || attempt.stage !== "resolved" || !["command", "spread"].includes(attempt.kind)) continue;
    for (const effect of attemptReport(attempt).results ?? []) if (effect.eligible && known.has(effect.target)) tested.add(effect.target);
  }
  const exposed = state.drones.filter(d => d.controller === "attacker" || (health.get(d.id)?.contamination ?? 0) > 0);
  const checkKey = (e: Evidence) => `${e.drone}:${e.actor}:${e.at}:${e.policy_version}`;
  const checks = new Set(state.events.map(e => `${checkKey(e)}:${e.kind}:${e.status}`));
  const paired = state.events.filter(e => e.kind === "recovery_verified" && e.status === 200 &&
    checks.has(`${checkKey(e)}:verification_unauthorized:403`) && checks.has(`${checkKey(e)}:verification_authorized:200`));
  const currentPaired = paired.filter(e => {const d=drones.get(e.drone);return d?.policy_version === e.policy_version && d.controller === "defender" && health.get(e.drone)?.contamination === 0;});
  const findings = new Map<number, Evidence>();
  for (const e of state.events) if (known.has(e.drone) && ["unauthorized_command_accepted", "limited_access", "unauthorized_command_blocked", "policy_applied", "recovery_verified", "mission_restored"].includes(e.kind) && (findings.get(e.drone)?.id ?? -1) < e.id) findings.set(e.drone, e);
  return {
    total: known.size, tested: tested.size, untested: known.size-tested.size,
    testedIds: [...tested], recoveredIds: [...new Set(paired.filter(e => known.has(e.drone)).map(e => e.drone))],
    exposed: exposed.length, isolated: state.drones.filter(d => d.isolated).length,
    available: state.battle.filter(h => known.has(h.drone) && h.operational).length,
    paired: new Set(currentPaired.map(e => e.drone)).size,
    verifiedRecoveries: new Set(paired.filter(e => known.has(e.drone)).map(e => e.drone)).size,
    active: state.tasks.filter(taskActive).length,
    unresolved: state.tasks.filter(t => ["failed", "blocked", "exhausted"].includes(t.state)).length,
    cancelled: state.tasks.filter(t => t.state === "cancelled").length,
    findings: [...findings.values()].sort((a,b) => b.id-a.id),
    next: !known.size ? "Waiting for fleet observations; no assessment is available yet." : exposed.length ? "Defend: contain affected drones, verify recovery, then restore participation."
      : state.drones.some(d => d.isolated) ? "Defend: return clean isolated drones to mission participation; recovery alone leaves them unavailable."
      : tested.size < known.size ? "Attack: investigate untested targets. Unobserved weaknesses remain unknown."
      : "Review resisted attempts and recovery evidence. This bounded sample does not establish fleet security.",
  };
}
