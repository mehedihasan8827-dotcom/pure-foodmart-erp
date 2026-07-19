-- 002: Tenants, merchant integrations, chart of accounts, fiscal periods
-- (multi-tenant SaaS architecture; per-tenant chart + periods seeded by
--  provision_tenant() in 013)

CREATE TABLE tenants (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(120) NOT NULL,
  slug       VARCHAR(60)  NOT NULL UNIQUE,
  status     tenant_status NOT NULL DEFAULT 'ACTIVE',
  plan       VARCHAR(24)   NOT NULL DEFAULT 'STANDARD',
  created_at TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- The single source of tenant context. Every runtime transaction runs
-- SELECT set_config('app.tenant_id', <id>, true); RLS policies and
-- tenant_id column defaults both read it through this function.
CREATE FUNCTION app_tenant_id() RETURNS INT LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::int
$$;

-- Merchant-owned API credentials (Nuport company id/key, Steadfast key/secret).
-- credentials_ciphertext is AES-256-GCM sealed with the platform master key
-- (env secret) at the application layer — plaintext never touches the DB.
CREATE TABLE tenant_integrations (
  id         SERIAL PRIMARY KEY,
  tenant_id  INT NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  provider   integration_provider NOT NULL,
  credentials_ciphertext TEXT NOT NULL,
  config     JSONB NOT NULL DEFAULT '{}',
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider)
);

CREATE TABLE accounts (
  id               SERIAL PRIMARY KEY,
  tenant_id        INT NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  code             VARCHAR(8)   NOT NULL,
  name             VARCHAR(120) NOT NULL,
  type             account_type NOT NULL,
  normal_balance   normal_side  NOT NULL,
  parent_id        INT REFERENCES accounts(id),
  is_cash_location BOOLEAN NOT NULL DEFAULT FALSE,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE fiscal_periods (
  id        SERIAL PRIMARY KEY,
  tenant_id INT NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  period    CHAR(7) NOT NULL,                 -- 'YYYY-MM'
  starts_on DATE NOT NULL,
  ends_on   DATE NOT NULL,
  is_locked BOOLEAN NOT NULL DEFAULT FALSE,
  locked_at TIMESTAMPTZ,
  locked_by INT,                              -- FK to users added in 011
  UNIQUE (tenant_id, period)
);
