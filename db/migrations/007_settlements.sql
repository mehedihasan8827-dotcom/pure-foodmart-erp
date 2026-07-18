-- 007: Steadfast ingestion + courier settlements (blueprint §6, §9.4)

-- Raw Steadfast API ingestion log (mirror of nuport_events).
CREATE TABLE steadfast_events (
  id             BIGSERIAL PRIMARY KEY,
  channel        sync_channel NOT NULL,          -- CRON poll or WEBHOOK (if enabled)
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
  UNIQUE (event_kind, consignment_id, invoice_ref, payload_hash)
);
CREATE INDEX idx_sf_consignment ON steadfast_events(consignment_id);

CREATE TABLE courier_settlements (
  id              BIGSERIAL PRIMARY KEY,
  courier         VARCHAR(32) NOT NULL,
  statement_ref   VARCHAR(64) NOT NULL,           -- Steadfast payout invoice ref
  statement_date  DATE NOT NULL,
  gross_cod       NUMERIC(14,2) NOT NULL,
  courier_charges NUMERIC(14,2) NOT NULL,
  net_paid        NUMERIC(14,2) NOT NULL,
  bank_account_id INT NOT NULL REFERENCES accounts(id),
  source_channel  VARCHAR(8) NOT NULL DEFAULT 'API',    -- API | CSV fallback
  status          VARCHAR(16) NOT NULL DEFAULT 'DRAFT', -- DRAFT/MATCHED/BATCHED/POSTED
  batch_entry_id  BIGINT REFERENCES journal_entries(id),  -- JE-C1 (Dr 1115 / Cr 1110)
  posted_entry_id BIGINT REFERENCES journal_entries(id),  -- JE-C2 (Dr bank+fees / Cr 1115)
  uploaded_by     INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (courier, statement_ref),
  CONSTRAINT chk_settlement_math CHECK (net_paid = gross_cod - courier_charges)
);

CREATE TABLE settlement_lines (
  id              BIGSERIAL PRIMARY KEY,
  settlement_id   BIGINT NOT NULL REFERENCES courier_settlements(id) ON DELETE CASCADE,
  raw_order_ref   VARCHAR(64) NOT NULL,           -- as reported by the courier
  order_id        BIGINT REFERENCES sales_orders(id),
  cod_collected   NUMERIC(14,2) NOT NULL,
  courier_charge  NUMERIC(14,2) NOT NULL DEFAULT 0,
  match_status    VARCHAR(16) NOT NULL DEFAULT 'UNMATCHED',
                  -- UNMATCHED/MATCHED/AMOUNT_MISMATCH/UNKNOWN_ORDER/RESOLVED
  resolution_note TEXT,
  UNIQUE (settlement_id, raw_order_ref)
);
-- an order can appear in at most one matched settlement:
CREATE UNIQUE INDEX uq_settled_once ON settlement_lines(order_id)
  WHERE order_id IS NOT NULL AND match_status IN ('MATCHED','RESOLVED');
