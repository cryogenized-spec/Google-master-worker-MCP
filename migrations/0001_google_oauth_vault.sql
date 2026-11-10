-- Local / future Cloudflare D1. NEVER commit OAuth tokens or encryption keys.
-- All token material, including short-lived access and refresh tokens, is
-- AES-256-GCM encrypted in application code before insertion.
CREATE TABLE IF NOT EXISTS google_oauth_pending (
  state_hash TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  verifier_enc TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_google_oauth_pending_expiry
  ON google_oauth_pending(expires_at);

CREATE TABLE IF NOT EXISTS google_oauth_connections (
  account_id TEXT PRIMARY KEY NOT NULL,
  tokens_enc TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  access_expires_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  updated_at INTEGER NOT NULL
);
