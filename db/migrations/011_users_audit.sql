-- 011: Users, RBAC anchor, audit log (blueprint §9.8, §15)

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  email         VARCHAR(160) NOT NULL UNIQUE,
  full_name     VARCHAR(120) NOT NULL,
  password_hash TEXT NOT NULL,                   -- argon2id (B7)
  role          VARCHAR(24) NOT NULL,            -- OWNER/ACCOUNTANT/OPERATOR/VIEWER
  totp_secret   TEXT,                            -- 2FA (B7)
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(id),          -- NULL = system job
  action      VARCHAR(64) NOT NULL,
  entity      VARCHAR(64) NOT NULL,
  entity_id   BIGINT,
  before_json JSONB,
  after_json  JSONB,
  ip_address  INET,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE fiscal_periods ADD CONSTRAINT fk_locked_by
  FOREIGN KEY (locked_by) REFERENCES users(id);
