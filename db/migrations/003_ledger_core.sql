-- 003: Journal core — the heart of the system (blueprint §9.1, §10)
--
-- Invariants enforced HERE, at the database, not in application code:
--   P1: every entry balances (deferred constraint trigger, checked at COMMIT)
--   P2: append-only — UPDATE/DELETE on posted entries is impossible
--   P?: no posting into locked fiscal periods
--
-- NOTE (production hardening, B13): the runtime app role must NOT be the
-- table owner and must be granted only INSERT/SELECT here — owners bypass
-- nothing today, but TRUNCATE does not fire row triggers, so TRUNCATE
-- privilege must never be granted to the runtime role.

-- Single-row serialization point: gapless entry numbering + hash-chain head.
-- Every posting transaction locks this row, which also serializes the chain.
CREATE TABLE ledger_sequence (
  singleton     BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  last_entry_no BIGINT  NOT NULL DEFAULT 0,
  last_hash     CHAR(64) NOT NULL DEFAULT repeat('0', 64)
);
INSERT INTO ledger_sequence (singleton) VALUES (TRUE);

CREATE TABLE journal_entries (
  id          BIGSERIAL PRIMARY KEY,
  entry_no    BIGINT NOT NULL UNIQUE,        -- gapless via ledger_sequence
  entry_date  DATE NOT NULL,
  period      CHAR(7) NOT NULL REFERENCES fiscal_periods(period),
  memo        TEXT NOT NULL,
  source_type source_type NOT NULL,
  source_id   BIGINT,                        -- originating business row
  event_code  VARCHAR(40) NOT NULL,          -- posting-rule matrix code (§4.7)
  reversal_of BIGINT REFERENCES journal_entries(id),
  posted_by   INT,                           -- user id, NULL = system
  posted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  entry_hash  CHAR(64) NOT NULL,             -- SHA-256 chain (§10.3)
  prev_hash   CHAR(64) NOT NULL
);
CREATE INDEX idx_je_source ON journal_entries(source_type, source_id);
CREATE INDEX idx_je_date   ON journal_entries(entry_date);

CREATE TABLE journal_lines (
  id          BIGSERIAL PRIMARY KEY,
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

-- ---- Integrity trigger 3: no posting into locked periods ----
CREATE OR REPLACE FUNCTION assert_period_open() RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM fiscal_periods
             WHERE period = NEW.period AND is_locked) THEN
    RAISE EXCEPTION 'Period % is locked', NEW.period;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_period_open BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION assert_period_open();
