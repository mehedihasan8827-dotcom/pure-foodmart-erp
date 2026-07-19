-- 007: Steadfast ingestion + courier settlements — per tenant (§6, §9.4)

CREATE TABLE steadfast_events (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      INT NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  channel        sync_channel NOT NULL,
  event_kind     VARCHAR(32) NOT NULL,           -- STATUS_CHANGE | BALANCE_SNAPSHOT |
                                                 -- INVOICE_CREATED | PAYOUT_DISBURSED
  consignment_id VARCHAR(64),
  invoice_ref    VARCHAR(64),
  payload        JSONB NOT NULL,
  payload_hash   CHAR(64) NOT NULL,
  status         event_status NOT NULL DEFAULT 'RECEIVED',
  received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ,
  error          TEXT,
  UNIQUE (tenant_id, event_kind, consignment_id, invoice_ref, payload_hash)
);
CREATE INDEX idx_sf_consignment ON steadfast_events(tenant_id, consignment_id);

CREATE TABLE courier_settlements (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INT NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  courier         VARCHAR(32) NOT NULL,
  statement_ref   VARCHAR(64) NOT NULL,
  statement_date  DATE NOT NULL,
  gross_cod       NUMERIC(14,2) NOT NULL,
  courier_charges NUMERIC(14,2) NOT NULL,
  net_paid        NUMERIC(14,2) NOT NULL,
  bank_account_id INT NOT NULL REFERENCES accounts(id),
  source_channel  VARCHAR(8) NOT NULL DEFAULT 'API',
  status          VARCHAR(16) NOT NULL DEFAULT 'DRAFT', -- DRAFT/MATCHED/BATCHED/POSTED
  batch_entry_id  BIGINT REFERENCES journal_entries(id),
  posted_entry_id BIGINT REFERENCES journal_entries(id),
  uploaded_by     INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, courier, statement_ref),
  CONSTRAINT chk_settlement_math CHECK (net_paid = gross_cod - courier_charges)
);

CREATE TABLE settlement_lines (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INT NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  settlement_id   BIGINT NOT NULL REFERENCES courier_settlements(id) ON DELETE CASCADE,
  raw_order_ref   VARCHAR(64) NOT NULL,
  order_id        BIGINT REFERENCES sales_orders(id),
  cod_collected   NUMERIC(14,2) NOT NULL,
  courier_charge  NUMERIC(14,2) NOT NULL DEFAULT 0,
  match_status    VARCHAR(16) NOT NULL DEFAULT 'UNMATCHED',
  resolution_note TEXT,
  UNIQUE (settlement_id, raw_order_ref)
);
CREATE UNIQUE INDEX uq_settled_once ON settlement_lines(order_id)
  WHERE order_id IS NOT NULL AND match_status IN ('MATCHED','RESOLVED');
