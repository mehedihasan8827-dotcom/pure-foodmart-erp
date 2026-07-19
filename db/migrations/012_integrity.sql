-- 012: Integrity alerts + balance reporting view — per tenant (§10)

CREATE TABLE integrity_alerts (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INT NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  invariant_code  VARCHAR(16) NOT NULL,          -- I1..I6, NEG_STOCK, HASH_CHAIN, ...
  severity        VARCHAR(8)  NOT NULL DEFAULT 'ERROR',
  details         JSONB NOT NULL,
  status          VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  resolved_by     INT REFERENCES users(id),
  resolution_note TEXT
);
CREATE INDEX idx_alerts_open ON integrity_alerts(tenant_id, status) WHERE status = 'OPEN';

-- Balances are derived, never stored (P1). security_invoker: the view runs
-- with the caller's RLS context, so each tenant sees only their accounts.
CREATE VIEW account_balances WITH (security_invoker = true) AS
SELECT a.id   AS account_id,
       a.tenant_id,
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
