import { type D1DatabaseLike } from "./store.js";

export interface OwnerLoginPending {
  state_hash: string;
  verifier_enc: string;
  expires_at: number;
}
export interface OwnerSession {
  session_hash: string;
  csrf_hash: string;
  expires_at: number;
}

export class OwnerBrowserStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async createLogin(data: OwnerLoginPending): Promise<void> {
    await this.db.prepare(
      "INSERT INTO google_owner_login_pending(state_hash,verifier_enc,expires_at) VALUES (?,?,?)"
    ).bind(data.state_hash,data.verifier_enc,data.expires_at).run();
  }
  async consumeLogin(stateHash: string, now: number): Promise<OwnerLoginPending | null> {
    return this.db.prepare(
      "DELETE FROM google_owner_login_pending WHERE state_hash=? AND expires_at>? RETURNING state_hash,verifier_enc,expires_at"
    ).bind(stateHash,now).first<OwnerLoginPending>();
  }
  async createSession(data: OwnerSession): Promise<void> {
    await this.db.prepare(
      "INSERT INTO google_owner_sessions(session_hash,csrf_hash,expires_at) VALUES (?,?,?)"
    ).bind(data.session_hash,data.csrf_hash,data.expires_at).run();
  }
  async getSession(sessionHash: string, now: number): Promise<OwnerSession | null> {
    return this.db.prepare(
      "SELECT session_hash,csrf_hash,expires_at FROM google_owner_sessions WHERE session_hash=? AND expires_at>?"
    ).bind(sessionHash,now).first<OwnerSession>();
  }
  async removeSession(sessionHash: string): Promise<void> {
    await this.db.prepare(
      "DELETE FROM google_owner_sessions WHERE session_hash=?"
    ).bind(sessionHash).run();
  }
  async createLink(stateHash: string, sessionHash: string, expiresAt: number): Promise<void> {
    await this.db.prepare(
      "INSERT INTO google_owner_link_pending(state_hash,session_hash,expires_at) VALUES (?,?,?)"
    ).bind(stateHash,sessionHash,expiresAt).run();
  }
  async consumeLink(stateHash: string, sessionHash: string, now: number): Promise<boolean> {
    const row = await this.db.prepare(
      "DELETE FROM google_owner_link_pending WHERE state_hash=? AND session_hash=? AND expires_at>? RETURNING state_hash"
    ).bind(stateHash,sessionHash,now).first<{state_hash:string}>();
    return Boolean(row);
  }
}
