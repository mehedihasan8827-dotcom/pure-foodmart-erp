-- 011: Platform users, tenant memberships (RBAC), audit log (§15, SaaS model)
--
-- Role model:
--   * Super Admin  — users.is_super_admin = TRUE. Platform staff: manage
--     tenants/subscriptions, global health, backend overrides. Uses a
--     BYPASSRLS database role in production; every override is audited.
--   * Tenant roles — tenant_users.role per membership:
--       TENANT_ADMIN  full merchant control incl. period lock, users, keys
--       ACCOUNTANT    post/reconcile/close
--       STAFF         operational entry only (expenses, purchases, counts)
--       VIEWER        dashboards/reports read-only
--   A user may belong to multiple tenants with different roles.

CREATE TABLE users (
  id             SERIAL PRIMARY KEY,
  email          VARCHAR(160) NOT NULL UNIQUE,
  full_name      VARCHAR(120) NOT NULL,
  password_hash  TEXT NOT NULL,                 -- argon2id (B7)
  is_super_admin BOOLEAN NOT NULL DEFAULT FALSE,
  totp_secret    TEXT,                          -- 2FA (B7)
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tenant_users (
  user_id    INT NOT NULL REFERENCES users(id),
  tenant_id  INT NOT NULL REFERENCES tenants(id),
  role       tenant_role NOT NULL,
  invited_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id)
);
CREATE INDEX idx_tu_tenant ON tenant_users(tenant_id);

-- tenant_id NULL = platform-level action (super admin / system).
CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   INT REFERENCES tenants(id),
  user_id     INT REFERENCES users(id),
  action      VARCHAR(64) NOT NULL,
  entity      VARCHAR(64) NOT NULL,
  entity_id   BIGINT,
  before_json JSONB,
  after_json  JSONB,
  ip_address  INET,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_tenant ON audit_log(tenant_id, at);

ALTER TABLE fiscal_periods ADD CONSTRAINT fk_locked_by
  FOREIGN KEY (locked_by) REFERENCES users(id);
