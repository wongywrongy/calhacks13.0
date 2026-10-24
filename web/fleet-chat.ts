export type Operation = {
  id: string;
  role: string;
  state: string;
  message: string;
  epoch: number;
  tasks: { agentId: number; target: number; objective: string }[];
  results: {
    agentId: number;
    target?: number;
    step?: number;
    kind?: string;
    status: string;
    evidenceId?: number;
    outcome?: string;
    responseStatus?: number;
    verificationEvidenceIds?: number[];
    error?: string;
  }[];
  inferences: {
    agentId: number;
    stage: string;
    model: string;
    status: string;
    error?: string;
  }[];
};
export const activeOperation = (op?: Operation) =>
  !!op && ["planning", "running"].includes(op.state);
export class OperationChat {
  operation?: Operation;
  sending = false;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: { id?: string; key: string; message: string };
  private storageKey: string;
  private sandbox: string;
  private changed: (op: Operation) => void;
  private failed: (message: string) => void;
  constructor(
    sandbox: string,
    role: string,
    changed: (op: Operation) => void,
    failed: (message: string) => void,
  ) {
    this.sandbox = sandbox;
    this.changed = changed;
    this.failed = failed;
    this.storageKey = `sudoko.operation:${sandbox}:${role}`;
    try {
      const p = JSON.parse(localStorage.getItem(this.storageKey) || "null");
      if (p && typeof p.key === "string" && typeof p.message === "string")
        this.pending = p;
    } catch {}
  }
  async resume() {
    if (this.pending?.id) await this.poll();
    else if (this.pending) await this.submit(this.pending.message);
  }
  async submit(message: string) {
    if (this.sending || activeOperation(this.operation))
      throw Error(
        "An operation is active. Stop it before sending a new objective.",
      );
    if (this.pending && !this.pending.id && this.pending.message !== message)
      throw Error("Retry the pending objective before submitting another.");
    this.sending = true;
    try {
      if (!this.pending || this.pending.id)
        this.pending = { key: crypto.randomUUID(), message };
      localStorage.setItem(this.storageKey, JSON.stringify(this.pending));
      const op = await this.request("/api/chat/operations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": this.pending.key,
        },
        body: JSON.stringify({ message, sandbox: this.sandbox }),
      });
      this.pending.id = op.id;
      localStorage.setItem(this.storageKey, JSON.stringify(this.pending));
      this.update(op);
      this.schedule();
    } finally {
      this.sending = false;
    }
  }
  async stop() {
    if (!this.pending?.id) return;
    this.update(
      await this.request(`/api/chat/operations/${this.pending.id}/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
  }
  private async request(path: string, init?: RequestInit): Promise<Operation> {
    const r = await fetch(path, { ...init, credentials: "same-origin" });
    const body = await r.json();
    if (!r.ok)
      throw Error(body.error || `Operation request failed (${r.status})`);
    return body;
  }
  private update(op: Operation) {
    if (!this.closed) {
      this.operation = op;
      this.changed(op);
    }
  }
  private schedule() {
    if (!this.closed && activeOperation(this.operation))
      this.timer = setTimeout(() => void this.poll(), 750);
  }
  private async poll() {
    try {
      this.update(
        await this.request(`/api/chat/operations/${this.pending!.id}`),
      );
    } catch (e) {
      if (!this.closed)
        this.failed(
          e instanceof Error ? e.message : "Operation status unavailable",
        );
    }
    this.schedule();
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }
}

// These lines describe persisted plans and receipts, never inferred success from prose.
export function operationLines(op: Operation): string[] {
  const lines = [
    `Operation ${op.id} · ${op.state} · reducer simulation`,
    `Objective: ${op.message}`,
  ];
  for (const task of op.tasks)
    lines.push(
      `Assignment · Agent ${task.agentId} → DR-${String(task.target).padStart(3, "0")}: ${task.objective}`,
    );
  for (const call of op.inferences.filter(
    (c) => activeOperation(op) && ["queued", "running"].includes(c.status),
  ))
    lines.push(
      `${call.agentId ? `Agent ${call.agentId}` : "Coordinator"} · ${call.status}`,
    );
  for (const r of op.results)
    lines.push(
      r.status === "executed"
        ? `Agent ${r.agentId} · ${r.kind}: ${r.outcome}${r.responseStatus ? ` (${r.responseStatus})` : ""}${r.evidenceId ? ` · evidence #${r.evidenceId}` : ""}${r.verificationEvidenceIds?.length ? ` · probes ${r.verificationEvidenceIds.map((id) => "#" + id).join(", ")}` : ""}`
        : `${r.agentId ? `Agent ${r.agentId}` : "Coordinator"} · ${r.status}: ${r.error || "execution failed"}`,
    );
  return lines;
}
