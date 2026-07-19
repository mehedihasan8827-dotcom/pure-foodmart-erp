-- 009: Partner equity — per tenant (§7, §9.6)

CREATE TABLE partners (
  id                  SERIAL PRIMARY KEY,
  tenant_id           INT NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  name                VARCHAR(120) NOT NULL,
  capital_account_id  INT NOT NULL REFERENCES accounts(id),
  drawings_account_id INT NOT NULL REFERENCES accounts(id),
  is_active           BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE partner_share_versions (
  id         SERIAL PRIMARY KEY,
  tenant_id  INT NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  partner_id INT NOT NULL REFERENCES partners(id),
  share_pct  NUMERIC(6,3) NOT NULL CHECK (share_pct > 0 AND share_pct <= 100),
  valid_from DATE NOT NULL,
  valid_to   DATE
);

CREATE TABLE equity_transactions (
  id                 BIGSERIAL PRIMARY KEY,
  tenant_id          INT NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  partner_id         INT NOT NULL REFERENCES partners(id),
  kind               equity_kind NOT NULL,
  amount             NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  tx_date            DATE NOT NULL,
  counter_account_id INT REFERENCES accounts(id),
  posted_entry_id    BIGINT REFERENCES journal_entries(id),
  notes              TEXT,
  entered_by         INT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
