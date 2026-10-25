import { DbConnection } from "./module_bindings/index.ts";
import { fleetOutcome } from "../sandbox/src/fleet-outcome.ts";
import type { ChatTransport } from "./fleet-chat.ts";

const row = (value: any): any => Object.fromEntries(Object.entries(value).map(([key, v]) => [key.replace(/[A-Z]/g, c => "_" + c.toLowerCase()), typeof v === "bigint" ? Number(v) : v]));
export class MaincloudChat implements ChatTransport {
  private conn!: DbConnection;
  private connected = false;
  private closed = false;
  private reconnect?: ReturnType<typeof setTimeout>;
  private config: { uri: string; database: string; token: string };
  private constructor(config: { uri: string; database: string; token: string }) { this.config = config; }
  static async connect(config: { uri: string; database: string; token: string }) {
    const client = new MaincloudChat(config);
    try { await client.start(); } catch (error) { client.close(); throw error; }
    return client;
  }
  private start() {
    return new Promise<void>((resolve, reject) => {
      this.conn = DbConnection.builder().withUri(this.config.uri).withDatabaseName(this.config.database).withToken(this.config.token)
        .onConnect(c => {
          if (this.closed) { c.disconnect(); return; }
          c.subscriptionBuilder().onApplied(() => { this.connected = true; resolve(); })
            .onError(ctx => reject(ctx.event))
            .subscribe(["SELECT * FROM visible_fleet_session", "SELECT * FROM visible_chat_messages", "SELECT * FROM visible_chat_operations", "SELECT * FROM visible_chat_turns"]);
        })
        .onConnectError((_ctx, error) => { reject(error); this.retry(); })
        .onDisconnect(() => { this.connected = false; this.retry(); })
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
    if (!session) throw Error("No granted Maincloud fleet session");
    const messages = [...this.conn.db.visibleChatMessages.iter()].map(row).sort((a,b) => a.id-b.id);
    const turns = [...this.conn.db.visibleChatTurns.iter()].map(row).sort((a,b) => a.created-b.created).map(t => ({ id:t.id, state:t.state, createdAt:t.created, updatedAt:t.updated, ...JSON.parse(t.result), config:JSON.parse(t.config), requestKey:t.request_key }));
    const operations = [...this.conn.db.visibleChatOperations.iter()].map(row).map(r => {
      const config = JSON.parse(r.config), records = JSON.parse(r.result), tasks = config.tasks ?? [];
      const workers = tasks.map((task: any) => {
        const lifecycle = records.filter((v: any) => v.type === "worker" && v.agentId === task.agentId).at(-1);
        return { ...task, operationId:r.id, state: ["planning","running"].includes(r.state) ? lifecycle?.state ?? "working" : lifecycle?.state === "working" ? r.state === "failed" ? "failed" : "paused" : lifecycle?.state ?? "paused", error:lifecycle?.error };
      });
      return { id:r.id, role:r.role, epoch:r.epoch, state:r.state, ...config, workers, outcome:fleetOutcome({state:r.state, role:r.role, tasks, results:records}), results:records.filter((v: any) => !["inference","worker","timing"].includes(v.type)), inferences:records.filter((v: any) => v.type === "inference"), timings:[], deployment:{ summary:`${tasks.length} agents deployed.`, assignments:tasks.map((t: any) => ({...t,summary:t.objective})) } };
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
  close() { this.closed=true; clearTimeout(this.reconnect); this.conn.disconnect(); }
}
