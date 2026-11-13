-- M23: trusted owner-issued, exact-action, single-use Google write approvals.
-- Input is AES-GCM encrypted with the private Workspace vault key; only a
-- SHA-256 digest of canonical parameters is stored in plaintext.
-- Never accept model/client-supplied approval booleans or arbitrary tokens.
CREATE TABLE IF NOT EXISTS google_write_approvals (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL CHECK(account_id='default'),
  client_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  risk TEXT NOT NULL CHECK(risk IN ('write','destructive','external')),
  input_digest TEXT NOT NULL,
  input_enc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','consumed')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_google_write_approval_owner
  ON google_write_approvals(status,expires_at,created_at);
CREATE INDEX IF NOT EXISTS idx_google_write_approval_action
  ON google_write_approvals(account_id,client_id,operation,status,expires_at);
