import { DbConnection } from "./module_bindings/index.ts";
import { fleetOutcome } from "../sandbox/src/fleet-outcome.ts";
import type { ChatTransport } from "./fleet-chat.ts";
import { VisitorSessionExpired } from "./visitor-session.ts";

const row = (value: any): any => Object.fromEntries(Object.entries(value).map(([key, v]) => [key.replace(/[A-Z]/g, c => "_" + c.toLowerCase()), typeof v === "bigint" ? Number(v) : v]));
export class MaincloudChat implements ChatTransport {
  onChange?: () => void;
  onInvalid?: () => void;
  private conn!: DbConnection;
  private connected = false;
  private closed = false;
  private reconnect?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private revision = 0;
  private config: { uri: string; database: string; token: string; sessionId?: number };
  private constructor(config: { uri: string; database: string; token: string; sessionId?: number }) { this.config = config; }
  static async connect(config: { uri: string; database: string; token: string; sessionId?: number }) {
    if (!config.token) throw new VisitorSessionExpired("Your session credentials are missing.");
    const client = new MaincloudChat(config);
    try { await client.start(); } catch (error) { client.close(); throw error; }
    return client;
  }
  private start() {
    const revision = ++this.revision;
    this.connected = false;
    this.conn?.disconnect(); clearInterval(this.heartbeat);
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { reject(Error("Maincloud connection timed out. Please retry.")); this.conn?.disconnect(); }, 10000);
      const current = () => !this.closed && revision === this.revision;
      const invalid = () => {
        if (!current()) return;
        clearTimeout(timeout); this.close(); this.onInvalid?.();
        reject(new VisitorSessionExpired("Your session expired. Continue to start a new simulation."));
      };
      this.conn = DbConnection.builder().withUri(this.config.uri).withDatabaseName(this.config.database).withToken(this.config.token)
        .onConnect(c => {
          if (!current()) { c.disconnect(); return; }
          for (const table of [c.db.visibleChatMessages,c.db.visibleChatTurns]) {
            const change = () => { if (current()) this.onChange?.(); };
            table.onInsert(change); table.onUpdate(change); table.onDelete(change);
          }
          c.db.visibleFleetSession.onDelete(() => {
            queueMicrotask(() => {
              if (current() && this.config.sessionId && ![...c.db.visibleFleetSession.iter()].some(s => s.sessionId === this.config.sessionId)) invalid();
            });
          });
          c.subscriptionBuilder().onApplied(() => {
            if (!current()) return;
            clearTimeout(timeout);
            const session = [...c.db.visibleFleetSession.iter()][0];
            if (this.config.sessionId && session?.sessionId !== this.config.sessionId) { invalid(); return; }
            this.connected = true; resolve(); this.onChange?.();
            if (this.config.sessionId) {
              const heartbeat = () => { void c.reducers.heartbeatVisitorSession({}).catch(error => {
                if (current() && /session expired|session required/i.test(String(error))) invalid();
              }); };
              heartbeat(); this.heartbeat = setInterval(heartbeat, 60000);
            }
          })
            .onError(ctx => { clearTimeout(timeout); if (current()) reject(ctx.event); })
            .subscribe(["SELECT * FROM visible_fleet_session", "SELECT * FROM visible_chat_messages", "SELECT * FROM visible_chat_operations", "SELECT * FROM visible_chat_turns"]);
        })
        .onConnectError((_ctx, error) => { clearTimeout(timeout); if (current()) { reject(error); this.retry(); } })
        .onDisconnect(() => { clearTimeout(timeout); if (current()) { this.connected = false; clearInterval(this.heartbeat); this.retry(); } })
        .build();
    });
  }
  private retry() {
    if (this.closed || this.reconnect) return;
    this.reconnect = setTimeout(() => { this.reconnect = undefined; void this.start().catch(() => {}); }, 1500);
  }
  async snapshot() {
    if (!this.connected) throw Error("Maincloud disconnected. Reconnecting…");
    const session = [...this.conn.db.visibleFleetSession.iter()].map(row)[0];
    if (!session || this.config.sessionId && session.session_id !== this.config.sessionId) throw new VisitorSessionExpired("Your session expired. Continue to start a new simulation.");
    const messages = [...this.conn.db.visibleChatMessages.iter()].map(row).sort((a,b) => a.id-b.id);
    const turns = [...this.conn.db.visibleChatTurns.iter()].map(row).sort((a,b) => a.created-b.created).map(t => ({ id:t.id, state:t.state, createdAt:t.created, updatedAt:t.updated, ...JSON.parse(t.result), config:JSON.parse(t.config), requestKey:t.request_key }));
    const operations = [...this.conn.db.visibleChatOperations.iter()].map(row).map(r => {
      const config = JSON.parse(r.config), records = JSON.parse(r.result), tasks = config.tasks ?? [];
      const workers = tasks.map((task: any) => {
        const lifecycle = records.filter((v: any) => v.type === "worker" && v.agentId === task.agentId).at(-1);
        let state=({working:"running",done:"completed",paused:"cancelled"} as Record<string,string>)[lifecycle?.state] ?? lifecycle?.state ?? "queued";
        if (["queued","running","observing","deciding","executing","waiting"].includes(state) && !["planning","running"].includes(r.state)) state=r.state==="cancelled" ? "cancelled" : "failed";
        return {...task, operationId:r.id, state, error:lifecycle?.error, reason:lifecycle?.reason,stage:lifecycle?.stage};
      });
      return { id:r.id, role:r.role, epoch:r.epoch, state:r.state, ...config, mission:records.findLast((v: any)=>v.type==="mission"), workers, outcome:fleetOutcome({state:r.state, role:r.role, tasks, results:records}), results:records.filter((v: any) => !["inference","worker","timing","mission","replan","handoff"].includes(v.type)), inferences:records.filter((v: any) => v.type === "inference"), timings:[], deployment:{ summary:`${tasks.length} agents deployed.`, assignments:tasks.map((t: any) => ({...t,summary:t.objective})) } };
    }).sort((a,b) => a.createdAt-b.createdAt);
    const origin = (key: string) => messages.find(m => m.key.endsWith(`${key}:user`))?.id;
    for (const turn of turns) turn.messageId = origin(turn.requestKey);
    for (const op of operations) op.messageId = turns.find(t => t.id === op.turnId)?.messageId;
    for (const m of messages) {
      const turn = turns.find(t => m.key.endsWith(`${t.requestKey}:user`) || m.key.endsWith(`${t.id}:accepted`) || m.key.endsWith(`${t.id}:reply`));
      const op = operations.find(o => o.id === m.operation);
      m.kind = m.speaker === "operator" ? "user" : m.key.endsWith(":accepted") || m.key.endsWith(":planning") ? "progress" : m.key.endsWith(":plan") ? "deployment" : m.key.endsWith(":terminal") ? "outcome" : "answer";
      m.replyTo = turn?.messageId ?? op?.messageId;
      m.turnId = turn?.id ?? op?.turnId;
    }
    return { conversation:session.conversation, fleet:{active:session.active,epoch:session.epoch}, messages, turns, operations, after:messages.at(-1)?.id ?? 0, more:false };
  }
  async submit(key:string, message:string, target:number, epoch:number, generation:number) {
    if (!this.connected) throw Error("Maincloud disconnected");
    await this.conn.reducers.sendMaincloudMessage({key,message,target,epoch:BigInt(epoch),generation:BigInt(generation)});
    return this.snapshot();
  }
  async newChat(epoch:number,generation:number) {
    await this.conn.reducers.newMaincloudChat({epoch:BigInt(epoch),generation:BigInt(generation)});
    return this.snapshot();
  }
  async reset(epoch:number,demo:boolean) {
    await this.conn.reducers.resetMaincloudFleet({epoch:BigInt(epoch),demo});
  }
  close() { this.closed=true; ++this.revision; this.connected=false; clearTimeout(this.reconnect); clearInterval(this.heartbeat); this.conn?.disconnect(); }
}
