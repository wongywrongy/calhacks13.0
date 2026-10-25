import goals from "../../shared/fleet-goals.json" with { type: "json" };
export type Goal = keyof typeof goals;
export function validGoal(role: string, goal: unknown): goal is Goal {
  return typeof goal === "string" && Object.hasOwn(goals, goal) && goals[goal as Goal].role === role;
}
export function goalActions(role: string, goal: unknown, actions: string[]) {
  return validGoal(role, goal) ? actions.filter(action => (goals[goal].actions as string[]).includes(action)) : [];
}
export function goalSatisfied(goal: Goal, drone: any, health: any, discovered: boolean, receipt: any) {
  switch (goal) {
    case "recon": return discovered;
    case "capture": return drone.controller === "attacker";
    case "spread": return receipt?.kind === "spread" && receipt.simulation?.succeeded > 0;
    case "contain": return drone.isolated;
    case "harden": return health?.readiness >= 90;
    case "recover": case "restore": return drone.controller === "defender" && !health?.contamination && (goal !== "restore" || !drone.isolated);
  }
}
