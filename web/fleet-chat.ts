// Keep reply content as text; the renderer creates the list elements safely.
export function replyBlocks(text: string) {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const bullet = /^(?:[-*•]|\d+[.)])\s+/;
  const explicit = lines.some((line) => bullet.test(line));
  const statements = !explicit && lines.length === 1
    ? [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(lines[0])].map((s) => s.segment.trim()).filter(Boolean)
    : lines;
  const blocks: { list: boolean; lines: string[] }[] = [];
  for (const statement of statements) {
    const list = explicit ? bullet.test(statement) : statements.length > 2;
    const value = list ? statement.replace(bullet, "") : statement;
    const previous = blocks.at(-1);
    if (previous?.list === list) previous.lines.push(value);
    else blocks.push({ list, lines: [value] });
  }
  return blocks;
}

export type ChatTransport = {
  snapshot(): Promise<any>;
  submit(key: string, message: string, target: number, epoch: number, generation: number): Promise<any>;
  newChat(epoch: number, generation: number): Promise<any>;
  close(): void;
};
export type Worker = {
  agentId: number;
  name?: string;
  specialty?: string;
  target: number;
  objective: string;
  state: string;
  operationId: string;
  deployedAt?: number;
  error?: string;
  reason?: string;
  stage?: string;
};
export type Operation = {
  id: string;
  messageId?: number;
  turnId?: string;
  deployment?: { summary: string; assignments: { agentId: number; name: string; target: number; summary: string }[] };
  outcome?: { status: string; summary: string; succeeded: number; total: number; evidenceIds: number[] };
  role: string;
  state: string;
  message: string;
  epoch: number;
  createdAt: number;
  models?: { coordinator: string; specialist: string };
  tasks: { agentId: number; target: number; objective: string }[];
  workers: Worker[];
  results: {
    agentId: number;
    intent?: string;
    observation?: { anomaly?: boolean }[];
    verifiedEffectEvidenceId?: number;
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
  kind?: string;
  replyTo?: number;
  turnId?: string;
  operation: string;
  speaker: string;
  text: string;
  target: number;
  at: number;
};
export const activeOperation = (op?: Operation) =>
  !!op && ["planning", "running"].includes(op.state);
export type ConversationTurn = { id: string; messageId?: number; operationId?: string; state: string; createdAt: number; updatedAt: number; intent?: string; error?: string; metric?: { status: string; stage: string; epoch?: number } };
export class OperationChat {
  messages: ChatMessage[] = [];
  operations: Operation[] = [];
  turns: ConversationTurn[] = [];
  get pendingTurn() { return this.turns.find((t) => ["queued", "running"].includes(t.state) && Date.now() - t.createdAt < 31000); }
  sending = false;
  lastUpdated = 0;
  fleet: { active: boolean; epoch: number } | null = null;
  conversation = 1;
  private closed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: { key: string; message: string; target?: number; epoch: number; conversation: number };
  private abort = new AbortController();
  private storageKey: string;
  private cursor = 0;
  private requestSequence = 0;
  private lastApplied = 0;
  private transport?: ChatTransport;
  private sandbox: string;
  private role: string;
  private changed: () => void;
  private failed: (message: string) => void;
  get operation() {
    const current = this.operations.filter((o) => !this.fleet || o.epoch === this.fleet.epoch);
    return current.find(activeOperation) ?? current.at(-1);
  }
  constructor(
    sandbox: string,
    role: string,
    changed: () => void,
    failed: (message: string) => void,
    epoch: number,
    conversation = 1,
    transport?: ChatTransport,
  ) {
    this.fleet = { active: true, epoch };
    this.transport = transport;
    this.conversation = conversation;
    this.sandbox = sandbox;
    this.role = role;
    this.changed = changed;
    this.failed = failed;
    this.storageKey = `sudoko.message:${sandbox}:${role}`;
    try {
      const p = JSON.parse(localStorage.getItem(this.storageKey) || "null");
      if (p && typeof p.key === "string" && typeof p.message === "string" && p.epoch === epoch && (p.conversation ?? 1) === conversation)
        this.pending = { ...p, conversation };
      else localStorage.removeItem(this.storageKey);
    } catch {}
  }
  async resume() {
    await this.poll();
    if (!this.closed && this.pending) {
      try {
        await this.submit(this.pending.message, this.pending.target);
      } catch (e) {
        if (!this.closed) this.failed(e instanceof Error ? e.message : "Message unavailable");
      }
    }
  }
  async submit(message: string, target?: number) {
    if (this.closed || this.sending) return;
    const epoch = this.fleet!.epoch, conversation = this.conversation;
    if (/^(?:stop|cancel|pause)[.!]?$/i.test(message.trim())) this.clearPending();
    if (
      this.pending &&
      (this.pending.message !== message || this.pending.target !== target)
    )
      throw Error("Retry the pending message before submitting another.");
    this.sending = true;
    try {
      this.pending ??= { key: crypto.randomUUID(), message, target, epoch, conversation };
      localStorage.setItem(this.storageKey, JSON.stringify(this.pending));
      const request = ++this.requestSequence;
      const r = this.transport ? Response.json(await this.transport.submit(this.pending.key, message, target ?? 0, epoch, conversation)) : await fetch("/api/chat/messages", {
        method: "POST",
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(12000)]),
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-sudoko-role": this.role,
          "idempotency-key": this.pending.key,
        },
        body: JSON.stringify({ message, sandbox: this.sandbox, target, epoch, conversation }),
      });
      const body = await r.json();
      if (this.closed || this.fleet?.epoch !== epoch || this.conversation !== conversation) return;
      if (!r.ok) {
        if (r.status < 500) this.clearPending();
        throw Error(body.error || `Message failed (${r.status})`);
      }
      this.clearPending();
      this.update(body, request);
    } catch (error) {
      if (!this.closed && this.fleet?.epoch === epoch && this.conversation === conversation) throw error;
    } finally {
      if (this.fleet?.epoch === epoch && this.conversation === conversation) this.sending = false;
    }
  }
  private clearPending() {
    this.pending = undefined;
    localStorage.removeItem(this.storageKey);
  }
  advanceEpoch(epoch: number) {
    if (epoch <= (this.fleet?.epoch ?? 0)) return;
    this.operations = [];
    this.turns = [];
    this.cursor = 0;
    this.sending = false;
    this.lastUpdated = 0;
    this.clearPending();
    this.fleet = { active: true, epoch };
  }
  advanceConversation(generation: number) {
    if (generation <= this.conversation) return;
    this.conversation = generation;
    this.messages = [];
    this.operations = [];
    this.turns = [];
    this.cursor = 0;
    this.sending = false;
    this.clearPending();
  }
  async newChat() {
    const request = ++this.requestSequence;
    const response = this.transport ? Response.json(await this.transport.newChat(this.fleet!.epoch, this.conversation)) : await fetch("/api/chat/new", {
      method: "POST", credentials: "same-origin",
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(12000)]),
      headers: { "content-type": "application/json", "x-sudoko-role": this.role },
      body: JSON.stringify({ epoch: this.fleet!.epoch, conversation: this.conversation }),
    });
    const body = await response.json();
    if (!response.ok) throw Error(body.error || "New Chat failed");
    this.update(body, request);
  }
  private update(body: { conversation?: number; messages: ChatMessage[]; operations: Operation[]; turns?: ConversationTurn[]; fleet?: { active: boolean; epoch: number } | null }, request: number) {
    if (this.closed || !body.fleet || body.fleet.epoch < this.fleet!.epoch) return false;
    if ((body.conversation ?? 1) < this.conversation) return false;
    if (body.fleet.epoch === this.fleet!.epoch && (body.conversation ?? 1) === this.conversation && request < this.lastApplied) return false;
    this.lastApplied = request;
    this.advanceEpoch(body.fleet.epoch);
    this.advanceConversation(body.conversation ?? 1);
    const messages = new Map(this.messages.map((m) => [m.id, m]));
    for (const m of body.messages) messages.set(m.id, m);
    this.messages = [...messages.values()].sort((a, b) => a.id - b.id);
    this.operations = body.operations;
    this.turns = body.turns ?? [];
    this.lastUpdated = Date.now();
    if (body.fleet !== undefined) this.fleet = body.fleet;
    this.changed();
    return true;
  }
  private async poll() {
    const epoch = this.fleet!.epoch;
    try {
      let more = true;
      while (more && !this.closed) {
        const request = ++this.requestSequence;
        const r = this.transport ? Response.json(await this.transport.snapshot()) : await fetch(`/api/chat/conversation?after=${this.cursor}&conversation=${this.conversation}`, {
          credentials: "same-origin",
          signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(12000)]),
          headers: { "x-sudoko-role": this.role },
        });
        const body = await r.json();
        if (!r.ok)
          throw Error(body.error || `Conversation unavailable (${r.status})`);
        if (!this.update(body, request)) break;
        this.cursor = body.after;
        more = body.more;
      }
    } catch (e) {
      if (!this.closed && this.fleet?.epoch === epoch)
        this.failed(
          e instanceof Error ? e.message : "Conversation unavailable",
        );
    }
    if (!this.closed) this.timer = setTimeout(() => void this.poll(), this.pendingTurn || activeOperation(this.operation) ? 250 : 750);
  }
  close() {
    this.closed = true;
    this.abort.abort();
    this.transport?.close();
    clearTimeout(this.timer);
  }
}
