export type Worker = {
  agentId: number;
  target: number;
  objective: string;
  state: string;
  operationId: string;
  error?: string;
};
export type Operation = {
  id: string;
  role: string;
  state: string;
  message: string;
  epoch: number;
  createdAt: number;
  tasks: { agentId: number; target: number; objective: string }[];
  workers: Worker[];
  results: {
    agentId: number;
    target?: number;
    step?: number;
    kind?: string;
    status: string;
    actionId?: string;
    at?: number;
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
export type ChatMessage = {
  id: number;
  operation: string;
  speaker: string;
  text: string;
  target: number;
  at: number;
};
export const activeOperation = (op?: Operation) =>
  !!op && ["planning", "running"].includes(op.state);
export class OperationChat {
  messages: ChatMessage[] = [];
  operations: Operation[] = [];
  sending = false;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: { key: string; message: string; target?: number };
  private storageKey: string;
  private cursor = 0;
  private sandbox: string;
  private changed: () => void;
  private failed: (message: string) => void;
  get operation() {
    return this.operations.find(activeOperation) ?? this.operations.at(-1);
  }
  constructor(
    sandbox: string,
    role: string,
    changed: () => void,
    failed: (message: string) => void,
  ) {
    this.sandbox = sandbox;
    this.changed = changed;
    this.failed = failed;
    this.storageKey = `sudoko.message:${sandbox}:${role}`;
    try {
      const p = JSON.parse(localStorage.getItem(this.storageKey) || "null");
      if (p && typeof p.key === "string" && typeof p.message === "string")
        this.pending = p;
    } catch {}
  }
  async resume() {
    if (this.pending) {
      try {
        await this.submit(this.pending.message, this.pending.target);
      } catch (e) {
        this.failed(e instanceof Error ? e.message : "Message unavailable");
      }
    }
    await this.poll();
  }
  async submit(message: string, target?: number) {
    if (this.sending) return;
    if (
      this.pending &&
      (this.pending.message !== message || this.pending.target !== target)
    )
      throw Error("Retry the pending message before submitting another.");
    this.sending = true;
    try {
      this.pending ??= { key: crypto.randomUUID(), message, target };
      localStorage.setItem(this.storageKey, JSON.stringify(this.pending));
      const r = await fetch("/api/chat/messages", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "idempotency-key": this.pending.key,
        },
        body: JSON.stringify({ message, sandbox: this.sandbox, target }),
      });
      const body = await r.json();
      if (!r.ok) {
        if (r.status < 500) this.clearPending();
        throw Error(body.error || `Message failed (${r.status})`);
      }
      this.clearPending();
      this.update(body);
    } finally {
      this.sending = false;
    }
  }
  private clearPending() {
    this.pending = undefined;
    localStorage.removeItem(this.storageKey);
  }
  private update(body: { messages: ChatMessage[]; operations: Operation[] }) {
    if (this.closed) return;
    const ids = new Set(this.messages.map((m) => m.id));
    this.messages.push(...body.messages.filter((m) => !ids.has(m.id)));
    this.messages.sort((a, b) => a.id - b.id);
    this.operations = body.operations;
    this.changed();
  }
  private async poll() {
    try {
      let more = true;
      while (more && !this.closed) {
        const r = await fetch(`/api/chat/conversation?after=${this.cursor}`, {
          credentials: "same-origin",
        });
        const body = await r.json();
        if (!r.ok)
          throw Error(body.error || `Conversation unavailable (${r.status})`);
        this.update(body);
        this.cursor = body.after;
        more = body.more;
      }
    } catch (e) {
      if (!this.closed)
        this.failed(
          e instanceof Error ? e.message : "Conversation unavailable",
        );
    }
    if (!this.closed) this.timer = setTimeout(() => void this.poll(), 750);
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }
}
