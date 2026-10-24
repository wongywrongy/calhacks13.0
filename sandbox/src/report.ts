function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] : null;
}
export function summarize(snapshot: any, probes: any[], traces: any[]) {
  const metrics: Record<string, unknown> = {};
  for (const team of ['red', 'blue']) {
    const requests = snapshot.events.filter((e: any) => e.kind === 'request' && e.target === team);
    const good = requests.filter((e: any) => e.detail.legitimate);
    const attacks = requests.filter((e: any) => !e.detail.legitimate && !e.detail.probe);
    const checks = probes.filter(p => p.target === team);
    const changes = snapshot.events.filter((e: any) => e.kind === 'rule_change' && e.target === team);
    const mitigations = changes.map((e: any) => {
      const verified = checks.find(p => p.at >= e.at && p.isolation === 'blocked' && p.normal === 'available' &&
        p.attackPolicyVersion === e.detail.after.version && p.legitimatePolicyVersion === e.detail.after.version);
      return { eventId: e.id, rule: e.detail.rule, check: 'isolation-and-availability at the same policy version', verified: Boolean(verified), verificationLatencyMs: verified ? verified.at - e.at : null };
    });
    metrics[team] = {
      workloadPhases: Object.fromEntries(['steady', 'burst', 'recovery'].map(phase => { const rows = good.filter((e: any) => (e.detail.phase ?? 'steady') === phase); return [phase, { requests: rows.length, succeeded: rows.filter((e: any) => e.detail.status >= 200 && e.detail.status < 300).length, p95Ms: percentile(rows.map((e: any) => e.detail.latencyMs), .95) }]; })),
      legitimateRequests: good.length, legitimateSucceeded: good.filter((e: any) => e.detail.status >= 200 && e.detail.status < 300).length,
      legitimateSuccessPct: good.length ? Math.round(10000 * good.filter((e: any) => e.detail.status >= 200 && e.detail.status < 300).length / good.length) / 100 : null,
      legitimateP95Ms: percentile(good.map((e: any) => e.detail.latencyMs), .95),
      attackRequests: attacks.length, secretLeaks: attacks.filter((e: any) => e.detail.secretReleased).length,
      verifiedCaptures: snapshot.events.filter((e: any) => e.kind === 'capture' && e.target === team).length,
      unavailableResponses: good.filter((e: any) => e.detail.status === 503).length,
      blockedLegitimateRequests: good.filter((e: any) => e.detail.status === 403).length,
      isolationProbePasses: checks.filter(p => p.isolation === 'blocked').length, isolationProbeCount: checks.length,
      verifiedReclaims: snapshot.events.filter((e: any) => e.kind === 'reclaim' && e.target === team).length,
      completedHandoffs: snapshot.events.filter((e: any) => e.kind === 'task_completed' && e.team === team).length,
      mitigations,
    };
  }
  return { metrics, agentErrors: traces.filter(t => t.error).length, agentDecisions: traces.filter(t => t.action).length,
    inferenceP95Ms: percentile(traces.filter(t => t.inferenceMs != null).map(t => t.inferenceMs), .95),
    conclusion: 'Fixture results validate mechanics only. Model behavior requires a Bitdeer run. Wall-clock scheduling and model outputs are not deterministic.' };
}
