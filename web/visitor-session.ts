import { Identity } from "spacetimedb";
import { DbConnection } from "./module_bindings/index.ts";

export type VisitorRole = "attacker" | "defender" | "observer";
type Credential = { identity: string; token: string };
export type VisitorSession = { uri: string; database: string; roles: Partial<Record<VisitorRole, Credential>>; ready: boolean; id?: number };
export type FleetMetadata = { uri: string; database: string; maincloud?: boolean; [key: string]: any };
const KEY = "sudoko.visitor.v1";
export class VisitorSessionExpired extends Error {}

export function savedVisitor(config: FleetMetadata): VisitorSession | undefined {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
    if (s?.uri === config.uri && s.database === config.database && s.roles && typeof s.ready === "boolean") {
      if (s.ready && !["attacker", "defender", "observer"].every(r => typeof s.roles[r]?.token === "string" && typeof s.roles[r]?.identity === "string")) return;
      return s;
    }
  } catch {}
}
export function forgetVisitor() { sessionStorage.removeItem(KEY); }

function connection(config: FleetMetadata, token: string) {
  if (!token) throw new VisitorSessionExpired("Your session credentials are missing.");
  return new Promise<DbConnection>((resolve, reject) => {
    const timeout = setTimeout(() => { conn.disconnect(); reject(Error("Connection timed out. Please retry.")); }, 10000);
    const conn = DbConnection.builder().withUri(config.uri).withDatabaseName(config.database).withToken(token)
      .onConnect(c => { clearTimeout(timeout); resolve(c); })
      .onConnectError((_ctx, error) => { clearTimeout(timeout); conn.disconnect(); reject(error); }).build();
  });
}
export async function startVisitor(config: FleetMetadata): Promise<VisitorSession> {
  const session = savedVisitor(config) ?? { uri: config.uri, database: config.database, roles: {}, ready: false };
  const save = () => sessionStorage.setItem(KEY, JSON.stringify(session));
  // Persist the same identities before admission, including retries after an unknown result.
  save();
  for (const role of ["attacker", "defender", "observer"] as const) {
    if (session.roles[role]?.token && session.roles[role]?.identity) continue;
    const response = await fetch(`${config.uri}/v1/identity`, { method: "POST", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Error(`Could not create session credentials (${response.status}). Please retry.`);
    const credential = await response.json();
    if (!credential.token || !credential.identity) throw Error("Invalid session credentials. Please retry.");
    session.roles[role] = { token: credential.token, identity: credential.identity }; save();
  }
  const conn = await connection(config, session.roles.attacker!.token);
  try {
    await conn.reducers.createVisitorSession({ defender: Identity.fromString(session.roles.defender!.identity), observer: Identity.fromString(session.roles.observer!.identity) });
    const state = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error("Session initialization timed out. Please retry.")), 10000);
      conn.subscriptionBuilder().onApplied(() => {
        clearTimeout(timeout);
        const state = [...conn.db.visibleFleetSession.iter()][0];
        if (!state || !state.sessionId) reject(new VisitorSessionExpired("Your session expired. Continue to start a new simulation."));
        else resolve(state);
      }).onError(ctx => { clearTimeout(timeout); reject(ctx.event); }).subscribe("SELECT * FROM visible_fleet_session");
    });
    session.ready = true; session.id = state.sessionId; save(); return session;
  } catch (error) {
    if (error instanceof VisitorSessionExpired || /session expired|identity already assigned|session identity conflict/i.test(String(error))) {
      forgetVisitor(); throw new VisitorSessionExpired("Your session expired. Continue to start a new simulation.");
    }
    throw error;
  } finally { conn.disconnect(); }
}

export function visitorWorkspace(config: FleetMetadata, session: VisitorSession, role: VisitorRole) {
  const credential = session.roles[role];
  if (!session.ready || !session.id || !credential?.token) throw new VisitorSessionExpired("Your session credentials are missing.");
  return { ...config, ...credential, role, sessionId: session.id, visitorSessions: true, workspaces: session.roles, switchableRoles: ["attacker", "defender", "observer"] };
}
