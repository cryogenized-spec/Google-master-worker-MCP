import { OperationError } from "../../core/src/index.js";

/** Narrow D1-shaped contract; makes Node's built-in SQLite suitable for synthetic tests. */
export type SqlValue = string | number | null;
export interface D1Statement {
  bind(...args: SqlValue[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}
export interface D1DatabaseLike {
  prepare(query: string): D1Statement;
}

export interface PendingAuthorization {
  readonly state_hash: string;
  readonly account_id: string;
  readonly client_id: string;
  readonly verifier_enc: string;
  readonly scopes_json: string;
  readonly expires_at: number;
}

export interface StoredConnection {
  readonly account_id: string;
  readonly tokens_enc: string;
  readonly scopes_json: string;
  readonly access_expires_at: number;
  readonly version: number;
}

export class GoogleOAuthStore {
  constructor(private readonly db: D1DatabaseLike) {}

  async createPending(data: PendingAuthorization): Promise<void> {
    await this.db.prepare(
      "INSERT INTO google_oauth_pending (state_hash,account_id,client_id,verifier_enc,scopes_json,expires_at) VALUES (?,?,?,?,?,?)"
    ).bind(data.state_hash, data.account_id, data.client_id, data.verifier_enc,
      data.scopes_json, data.expires_at).run();
  }

  async consumePending(stateHash: string, now: number): Promise<PendingAuthorization | null> {
    // One atomic DELETE ... RETURNING: concurrent callbacks cannot redeem state twice.
    return this.db.prepare(
      "DELETE FROM google_oauth_pending WHERE state_hash = ? AND expires_at > ? RETURNING state_hash,account_id,client_id,verifier_enc,scopes_json,expires_at"
    ).bind(stateHash, now).first<PendingAuthorization>();
  }

  async load(accountId: string): Promise<StoredConnection | null> {
    return this.db.prepare(
      "SELECT account_id,tokens_enc,scopes_json,access_expires_at,version FROM google_oauth_connections WHERE account_id = ?"
    ).bind(accountId).first<StoredConnection>();
  }

  async connectNew(data: Omit<StoredConnection, "version">, now: number): Promise<void> {
    const inserted = await this.db.prepare(
      "INSERT INTO google_oauth_connections (account_id,tokens_enc,scopes_json,access_expires_at,version,updated_at) VALUES (?,?,?,?,1,?) ON CONFLICT(account_id) DO NOTHING RETURNING account_id"
    ).bind(data.account_id, data.tokens_enc, data.scopes_json,
      data.access_expires_at, now).first<{ account_id: string }>();
    if (!inserted) throw new OperationError("GOOGLE_ACCOUNT_ALREADY_CONNECTED");
  }

  async compareAndSetTokens(
    data: Omit<StoredConnection, "version">, version: number, now: number
  ): Promise<boolean> {
    const updated = await this.db.prepare(
      "UPDATE google_oauth_connections SET tokens_enc=?,scopes_json=?,access_expires_at=?,version=version+1,updated_at=? WHERE account_id=? AND version=? RETURNING version"
    ).bind(data.tokens_enc, data.scopes_json, data.access_expires_at,
      now, data.account_id, version).first<{ version: number }>();
    return Boolean(updated);
  }

  /** Prevent a stale revocation request from deleting a newer connection. */
  async disconnectIfVersion(accountId: string, version: number): Promise<boolean> {
    const removed = await this.db.prepare(
      "DELETE FROM google_oauth_connections WHERE account_id=? AND version=? RETURNING account_id"
    ).bind(accountId,version).first<{account_id:string}>();
    return Boolean(removed);
  }

  async disconnect(accountId: string): Promise<boolean> {
    const removed = await this.db.prepare(
      "DELETE FROM google_oauth_connections WHERE account_id=? RETURNING account_id"
    ).bind(accountId).first<{ account_id: string }>();
    return Boolean(removed);
  }
}
