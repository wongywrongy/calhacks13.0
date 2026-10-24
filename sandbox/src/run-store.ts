import { randomUUID } from "node:crypto";
import type { spacetimeConfig } from "./spacetime.ts";
export type JobState =
  | "queued"
  | "running"
  | "stopping"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";
export type Job = {
  id: string;
  state: JobState;
  created: number;
  updated: number;
  config: any;
  snapshot: any;
  error: string | null;
};
export class StoreError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const literal = (s: string) => "'" + s.replaceAll("'", "''") + "'";
export class RunStore {
  readonly session = randomUUID();
  private sequence = new Map<string, number>();
  private config: NonNullable<ReturnType<typeof spacetimeConfig>>;
  constructor(config: NonNullable<ReturnType<typeof spacetimeConfig>>) {
    this.config = config;
  }
  async call(name: string, args: unknown[]) {
    const r = await fetch(
      `${this.config.uri}/v1/database/${this.config.database}/call/${name}`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(8000),
        headers: {
          authorization: `Bearer ${this.config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(args),
      },
    );
    if (!r.ok) {
      const message = await r.text();
      throw new StoreError(
        message.includes("queue full")
          ? 429
          : (message.includes("Idempotency conflict") || message.includes("Conversation already pending"))
            ? 409
            : 502,
        "SpacetimeDB rejected " + name + (message.includes("Stale policy") ? ": stale_policy" : message.includes("Operation expired") ? ": operation_expired" : message.includes("Outside assignment") ? ": outside_assignment" : ""),
      );
    }
  }
  async query(sql: string) {
    const r = await fetch(
      `${this.config.uri}/v1/database/${this.config.database}/sql`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(8000),
        headers: {
          authorization: `Bearer ${this.config.token}`,
          "content-type": "text/plain",
        },
        body: sql,
      },
    );
    if (!r.ok) throw new StoreError(502, "SpacetimeDB read failed");
    const data = (await r.json()) as any;
    return data[0].rows.map((row: any[]) =>
      Object.fromEntries(
        row.map((v, i) => [data[0].schema.elements[i].name.some, v]),
      ),
    );
  }
  async open(maxActive: number, maxQueued: number) {
    await this.call("acquire_backend", [this.session, maxActive, maxQueued]);
  }
  async heartbeat() {
    await this.call("heartbeat_backend", [this.session]);
  }
  private decode(r: any): Job | undefined {
    return r
      ? {
          id: r.id,
          state: r.state,
          created: r.created,
          updated: r.updated,
          config: JSON.parse(r.config),
          snapshot: r.snapshot ? JSON.parse(r.snapshot) : null,
          error: r.error || null,
        }
      : undefined;
  }
  async get(id: string) {
    return this.decode(
      (
        await this.query(`SELECT * FROM backend_run WHERE id=${literal(id)}`)
      )[0],
    );
  }
  async byKey(key: string) {
    return this.decode(
      (
        await this.query(
          `SELECT * FROM backend_run WHERE request_key=${literal(key)}`,
        )
      )[0],
    );
  }
  async list(limit = 50, before = Number.MAX_SAFE_INTEGER): Promise<Job[]> {
    const rows = await this.query(
      `SELECT * FROM backend_run WHERE created < ${before}`,
    );
    return rows
      .sort(
        (a: any, b: any) => b.created - a.created || b.id.localeCompare(a.id),
      )
      .slice(0, limit)
      .map((r: any) => this.decode(r)!);
  }
  async insert(id: string, config: unknown, key: string) {
    await this.call("enqueue_backend_run", [
      this.session,
      id,
      key,
      JSON.stringify(config),
    ]);
    return (await this.byKey(key))!;
  }
  async state(id: string, state: JobState, error: string | null = null) {
    await this.call("transition_backend_run", [
      this.session,
      id,
      state,
      error ?? "",
    ]);
  }
  async save(id: string, snapshot: any) {
    const seq = (this.sequence.get(id) ?? 0) + 1;
    this.sequence.set(id, seq);
    await this.call("save_backend_snapshot", [
      this.session,
      id,
      seq,
      JSON.stringify(snapshot),
    ]);
  }
  async events(id: string, after: number, limit: number) {
    const rows = await this.query(
      `SELECT * FROM backend_event WHERE run_id=${literal(id)} AND event_id > ${after}`,
    );
    return rows
      .sort((a: any, b: any) => a.event_id - b.event_id)
      .slice(0, limit)
      .map((r: any) => JSON.parse(r.body));
  }
  async close() {
    await this.call("release_backend", [this.session]);
  }
}
