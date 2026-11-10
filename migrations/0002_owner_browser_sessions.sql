-- Ephemeral owner browser login and Google Workspace link state.
-- All identifiers are SHA-256 hashes; login PKCE verifier is encrypted before storage.
CREATE TABLE IF NOT EXISTS google_owner_login_pending (
  state_hash TEXT PRIMARY KEY NOT NULL,
  verifier_enc TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_owner_login_pending_expires
  ON google_owner_login_pending(expires_at);

CREATE TABLE IF NOT EXISTS google_owner_sessions (
  session_hash TEXT PRIMARY KEY NOT NULL,
  csrf_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_owner_sessions_expires
  ON google_owner_sessions(expires_at);

CREATE TABLE IF NOT EXISTS google_owner_link_pending (
  state_hash TEXT PRIMARY KEY NOT NULL,
  session_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_owner_link_pending_expires
  ON google_owner_link_pending(expires_at);
