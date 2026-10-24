import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
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
export class RunStore {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, state TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, config TEXT NOT NULL, snapshot TEXT, error TEXT, request_key TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS events(job_id TEXT NOT NULL REFERENCES jobs(id), id INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(job_id,id));
      CREATE INDEX IF NOT EXISTS jobs_state_created ON jobs(state,created);`);
    // A process restart cannot truthfully resume private actor credentials or in-flight actions.
    this.db
      .prepare(
        "UPDATE jobs SET state='interrupted',updated=?,error='Service restarted; create a new run' WHERE state IN ('running','stopping','queued')",
      )
      .run(Date.now());
  }
  private decode(row: any): Job | undefined {
    return row
      ? {
          id: row.id,
          state: row.state,
          created: row.created,
          updated: row.updated,
          config: JSON.parse(row.config),
          snapshot: row.snapshot ? JSON.parse(row.snapshot) : null,
          error: row.error,
        }
      : undefined;
  }
  get(id: string) {
    return this.decode(
      this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id),
    );
  }
  byKey(key: string) {
    return this.decode(
      this.db.prepare("SELECT * FROM jobs WHERE request_key=?").get(key),
    );
  }
  list(limit = 50, before = Number.MAX_SAFE_INTEGER) {
    return this.db
      .prepare(
        "SELECT * FROM jobs WHERE created<? ORDER BY created DESC,id DESC LIMIT ?",
      )
      .all(before, limit)
      .map((r) => this.decode(r)!);
  }
  insert(id: string, config: unknown, requestKey: string | null) {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO jobs(id,state,created,updated,config,request_key) VALUES (?,'queued',?,?,?,?)",
      )
      .run(id, now, now, JSON.stringify(config), requestKey);
    return this.get(id)!;
  }
  state(id: string, state: JobState, error: string | null = null) {
    this.db
      .prepare("UPDATE jobs SET state=?,updated=?,error=? WHERE id=?")
      .run(state, Date.now(), error, id);
  }
  save(id: string, snapshot: any) {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("UPDATE jobs SET snapshot=?,updated=? WHERE id=?")
        .run(JSON.stringify(snapshot), Date.now(), id);
      const insert = this.db.prepare(
        "INSERT OR IGNORE INTO events(job_id,id,body) VALUES (?,?,?)",
      );
      const last = this.db
        .prepare("SELECT COALESCE(MAX(id),0) AS id FROM events WHERE job_id=?")
        .get(id) as { id: number };
      for (const event of snapshot.events.filter((e: any) => e.id > last.id))
        insert.run(id, event.id, JSON.stringify(event));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  events(id: string, after: number, limit: number) {
    return this.db
      .prepare(
        "SELECT body FROM events WHERE job_id=? AND id>? ORDER BY id LIMIT ?",
      )
      .all(id, after, limit)
      .map((r: any) => JSON.parse(r.body));
  }
  close() {
    this.db.close();
  }
}
