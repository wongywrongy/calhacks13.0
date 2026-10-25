export const explainFleetError = (code?: string) => ({
  stale_policy: "The drone’s policy changed before this action could apply.",
  operation_expired: "The operation reached its time limit before the action could apply.",
  operation_timeout: "The operation reached its time limit.",
  provider_timeout: "The decision provider did not respond in time.",
  provider_rate_limit: "The decision provider is temporarily limiting requests.",
  provider_refused: "The decision provider declined this request.",
  provider_not_configured: "The decision provider is not configured.",
  invalid_plan_size: "The plan must contain one to four useful specialists.",
  "Duplicate assignment": "The plan assigned the same target and objective twice.",
  "Invalid evidence reference": "The decision cited evidence outside its supplied observations.",
  provider_malformed_output: "The decision provider returned an invalid response.",
  provider_truncated_output: "The decision provider’s response was incomplete.",
  provider_transport_error: "The decision provider could not be reached.",
  provider_http_error: "The decision provider returned an error.",
  evidence_missing: "The backend did not return the required evidence.",
  cancelled: "The operation was stopped.",
}[code?.split(":")[0] ?? ""] ?? "The action was rejected; the backend did not provide a specific reason.");

type Receipt = {
  type?: string; completed?: number; total?: number; agentId: number; target?: number; status: string; outcome?: string; kind?: string;
  simulation?: { simulated: boolean; summary: string; succeeded: number; partial: number; total: number; results?: { target: number; success: boolean; partial: boolean }[] };
  verifiedEffectEvidenceId?: number; evidenceId?: number; verificationEvidenceIds?: number[]; responseStatus?: number;
};
export function fleetOutcome(op: { state: string; role: string; tasks: { agentId: number }[]; results: Receipt[] }) {
  const mission = op.results.findLast(r => r.type === "mission");
  if (mission) {
    const status: Record<string,string> = {verified_success:"Completed",partial_completion:"Partially completed",blocked:"Blocked",budget_exhausted:"Budget exhausted",deadline_exhausted:"Deadline exhausted",execution_failure:"Execution failed",cancellation:"Stopped"};
    const effects = op.results.filter(r => r.status === "executed" && r.evidenceId);
    const succeeded = mission.completed ?? 0, total = mission.total ?? op.tasks.length;
    return {status:status[mission.outcome ?? ""] ?? "Failed", summary:`${succeeded} of ${total} assignment objectives verified in the synthetic simulation. ${mission.outcome === "execution_failure" ? "Provider or execution failure is separate from simulated outcomes." : total > succeeded ? `${total-succeeded} remain unresolved.` : ""}`.trim(), succeeded, total,
      evidenceIds:[...new Set(effects.flatMap(r => [r.evidenceId!, ...(r.verificationEvidenceIds ?? [])]))]};
  }
  const simulated = op.results.filter((r) => r.status === "executed" && r.evidenceId && r.simulation?.simulated);
  if (simulated.length) {
    const effects = simulated.filter((r) => (op.role === "attacker" ? ["command", "spread"] : ["isolate", "harden", "verify", "release"]).includes(r.kind ?? ""));
    const completed = new Set(effects.filter((r) => r.simulation!.succeeded > 0 && (op.role === "attacker" || ["verify", "release"].includes(r.kind ?? ""))).map((r) => r.agentId));
    const succeeded = completed.size;
    const partial = effects.some((r) => r.simulation!.partial > 0 || r.simulation!.succeeded > 0 && (r.simulation!.succeeded < r.simulation!.total || !completed.has(r.agentId)));
    const status = op.state === "planning" ? "Planning" : op.state === "running" ? "Running" : op.state === "cancelled" ? "Stopped"
      : succeeded === op.tasks.length && succeeded > 0 && !partial && op.state === "completed" ? "Completed" : succeeded > 0 || partial ? "Partially completed" : "Failed";
    const lines = new Map<string, number>(), seen = new Set<number>();
    for (const r of effects.length ? effects : simulated) {
      if (seen.has(r.evidenceId!)) continue;
      seen.add(r.evidenceId!);
      const target = r.target ? `DR-${String(r.target).padStart(3, "0")} · ` : "";
      const line = `${target}${r.kind?.replaceAll("_", " ") ?? "attempt"}: ${r.simulation!.summary}`;
      lines.set(line, (lines.get(line) ?? 0) + 1);
    }
    const summary = "Simulated outcomes:\n" + [...lines].slice(-6).map(([line, count]) => `- ${line}${count > 1 ? ` (${count} attempts)` : ""}`).join("\n")
      + (lines.size > 6 ? `\n- ${lines.size - 6} earlier outcomes in Details.` : "");
    return { status, summary, succeeded, total: op.tasks.length,
      evidenceIds: [...new Set(effects.flatMap((r) => [r.evidenceId!, ...(r.verificationEvidenceIds ?? [])]))] };
  }
  const measured = op.results.filter((r) => r.status === "executed" && !!r.evidenceId);
  const successful = measured.filter((r) => op.role === "defender"
    ? r.outcome === "participation_restored" && r.responseStatus === 200 || r.outcome === "recovery_verified" && r.responseStatus === 200 && r.verificationEvidenceIds?.length === 2
    : !!r.verifiedEffectEvidenceId || r.outcome === "unauthorized_command_accepted" && r.responseStatus === 200);
  const succeeded = new Set(successful.map((r) => r.agentId)).size;
  const targets = new Set(successful.map((r) => r.target)).size;
  const status = op.state === "planning" ? "Planning" : op.state === "running" ? "Running"
    : op.state === "cancelled" ? "Stopped"
    : succeeded === op.tasks.length && succeeded > 0 && op.state === "completed" ? "Completed"
    : succeeded > 0 ? "Partially completed" : "Failed";
  const resilience = measured.some((r) => r.outcome?.startsWith("challenge_") || r.outcome?.startsWith("defense_") || r.outcome === "participation_restored");
  const summary = resilience ? targets ? op.role === "defender" ? `Verified participation restored on ${targets} ${targets === 1 ? "drone" : "drones"}.` : `Measured mission disruption on ${targets} ${targets === 1 ? "drone" : "drones"}.` : "No successful mission effect or restoration was verified." : targets ? op.role === "defender"
    ? `Recovered ${targets} ${targets === 1 ? "drone" : "drones"}. Unauthorized commands were rejected, and legitimate control passed verification.`
    : `Gained control of ${targets} ${targets === 1 ? "drone" : "drones"}; unauthorized commands were accepted.`
    : measured.some((r) => r.outcome === "unauthorized_command_blocked")
      ? "Unauthorized commands were rejected. No takeover was verified."
      : "No successful outcome was verified.";
  const evidence = successful.length ? successful : measured.filter((r) => r.outcome === "unauthorized_command_blocked");
  return { status, summary, succeeded, total: op.tasks.length,
    evidenceIds: [...new Set(evidence.flatMap((r) => [r.evidenceId!, ...(r.verificationEvidenceIds ?? []), ...(r.verifiedEffectEvidenceId ? [r.verifiedEffectEvidenceId] : [])]))] };
}
