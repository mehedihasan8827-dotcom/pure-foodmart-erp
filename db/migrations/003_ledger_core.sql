-- 003: Journal core — per-tenant double-entry ledgers (blueprint §9.1, §10)
--
-- Invariants enforced HERE, at the database:
--   P1: every entry balances (deferred constraint trigger, checked at COMMIT)
--   P2: append-only — UPDATE/DELETE on posted entries is impossible
--   P?: no posting into locked fiscal periods
-- Each tenant has an independent gapless entry sequence and hash chain.
--
-- NOTE (production hardening, B13): the runtime app role must NOT be the
-- table owner and must never be granted TRUNCATE (bypasses row triggers).

-- Per-tenant serialization point: gapless numbering + hash-chain head.
CREATE TABLE ledger_sequence (
  tenant_id     INT PRIMARY KEY DEFAULT app_tenant_id() REFERENCES tenants(id),
  last_entry_no BIGINT   NOT NULL DEFAULT 0,
  last_hash     CHAR(64) NOT NULL DEFAULT repeat('0', 64)
);

CREATE TABLE journal_entries (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   INT NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  entry_no    BIGINT NOT NULL,               -- gapless PER TENANT
  entry_date  DATE NOT NULL,
  period      CHAR(7) NOT NULL,
  memo        TEXT NOT NULL,
  source_type source_type NOT NULL,
  source_id   BIGINT,
  event_code  VARCHAR(40) NOT NULL,
  reversal_of BIGINT REFERENCES journal_entries(id),
  posted_by   INT,
  posted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  entry_hash  CHAR(64) NOT NULL,             -- per-tenant SHA-256 chain (§10.3)
  prev_hash   CHAR(64) NOT NULL,
  UNIQUE (tenant_id, entry_no),
  FOREIGN KEY (tenant_id, period) REFERENCES fiscal_periods(tenant_id, period)
);
CREATE INDEX idx_je_source ON journal_entries(tenant_id, source_type, source_id);
CREATE INDEX idx_je_date   ON journal_entries(tenant_id, entry_date);

CREATE TABLE journal_lines (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   INT NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  entry_id    BIGINT NOT NULL REFERENCES journal_entries(id),
  line_no     SMALLINT NOT NULL,
  account_id  INT NOT NULL REFERENCES accounts(id),
  debit       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (debit  >= 0),
  credit      NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  description TEXT,
  UNIQUE (entry_id, line_no),
  CONSTRAINT one_side_only CHECK (
    (debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)
  )
);
CREATE INDEX idx_jl_account ON journal_lines(account_id, entry_id);
CREATE INDEX idx_jl_tenant  ON journal_lines(tenant_id, entry_id);

-- ---- Integrity trigger 1: every entry balances (checked at COMMIT) ----
CREATE OR REPLACE FUNCTION assert_entry_balanced() RETURNS TRIGGER AS $$
DECLARE d NUMERIC(14,2); c NUMERIC(14,2); n INT;
BEGIN
  SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0), COUNT(*)
    INTO d, c, n FROM journal_lines WHERE entry_id = NEW.id;
  IF n < 2 OR d <> c OR d = 0 THEN
    RAISE EXCEPTION 'Journal entry % unbalanced: debits=% credits=% lines=%',
                    NEW.id, d, c, n;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_entry_balanced
  AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- ---- Integrity trigger 2: append-only ledger ----
CREATE OR REPLACE FUNCTION forbid_ledger_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Ledger is append-only; post a reversing entry instead';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_je_immutable BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();
CREATE TRIGGER trg_jl_immutable BEFORE UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

-- ---- Integrity trigger 3: no posting into locked periods (per tenant) ----
CREATE OR REPLACE FUNCTION assert_period_open() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM fiscal_periods
             WHERE tenant_id = NEW.tenant_id
               AND period = NEW.period AND is_locked) THEN
    RAISE EXCEPTION 'Period % is locked', NEW.period;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_period_open BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION assert_period_open();
