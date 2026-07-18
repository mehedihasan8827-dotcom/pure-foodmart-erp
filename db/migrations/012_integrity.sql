-- 012: Integrity alerts + balance reporting view (blueprint §10)

-- Violated invariants (I1..I6, HASH_CHAIN, STOCK_REPLAY, SF_BALANCE, ...)
-- land here, surface in the exception center, and block period close.
CREATE TABLE integrity_alerts (
  id              BIGSERIAL PRIMARY KEY,
  invariant_code  VARCHAR(16) NOT NULL,
  severity        VARCHAR(8)  NOT NULL DEFAULT 'ERROR',   -- WARN/ERROR
  details         JSONB NOT NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'OPEN',    -- OPEN/RESOLVED
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  resolved_by     INT REFERENCES users(id),
  resolution_note TEXT
);
CREATE INDEX idx_alerts_open ON integrity_alerts(status) WHERE status = 'OPEN';

-- Account balances are NEVER stored — always derived from journal_lines (P1).
-- balance is signed by the account's normal side.
CREATE VIEW account_balances AS
SELECT a.id   AS account_id,
       a.code,
       a.name,
       a.type,
       a.normal_balance,
       COALESCE(SUM(jl.debit),  0)::NUMERIC(14,2) AS total_debit,
       COALESCE(SUM(jl.credit), 0)::NUMERIC(14,2) AS total_credit,
       (CASE WHEN a.normal_balance = 'DEBIT'
             THEN COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0)
             ELSE COALESCE(SUM(jl.credit), 0) - COALESCE(SUM(jl.debit), 0)
        END)::NUMERIC(14,2) AS balance
FROM accounts a
LEFT JOIN journal_lines jl ON jl.account_id = a.id
GROUP BY a.id;
