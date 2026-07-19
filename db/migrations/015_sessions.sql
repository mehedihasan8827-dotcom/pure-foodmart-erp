-- 015: DB-backed sessions (B7 auth).
-- Auth-layer table (like users/tenant_users/webhook_tokens): no RLS —
-- sessions are resolved BEFORE any tenant context exists.
-- Only the SHA-256 of the opaque session token is stored; the plaintext
-- token lives solely in the client's HttpOnly cookie.

CREATE TABLE sessions (
  id           BIGSERIAL PRIMARY KEY,
  token_hash   CHAR(64) NOT NULL UNIQUE,
  user_id      INT NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ,
  ip           INET,
  user_agent   TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
