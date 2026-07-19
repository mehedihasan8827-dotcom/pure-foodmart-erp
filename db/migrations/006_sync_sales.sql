-- 006: Nuport ingestion + sales orders — per tenant (§2, §9.3)

CREATE TABLE sync_runs (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      INT NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  channel        sync_channel NOT NULL,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  cursor_before  TEXT,
  cursor_after   TEXT,
  orders_seen    INT NOT NULL DEFAULT 0,
  orders_changed INT NOT NULL DEFAULT 0,
  status         VARCHAR(16) NOT NULL DEFAULT 'RUNNING',
  error          TEXT
);

CREATE TABLE nuport_events (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         INT NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  channel           sync_channel NOT NULL,
  external_event_id VARCHAR(128),
  nuport_order_ref  VARCHAR(64) NOT NULL,
  payload           JSONB NOT NULL,
  payload_hash      CHAR(64) NOT NULL,
  status            event_status NOT NULL DEFAULT 'RECEIVED',
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at      TIMESTAMPTZ,
  error             TEXT,
  UNIQUE (tenant_id, external_event_id),
  UNIQUE (tenant_id, nuport_order_ref, payload_hash)
);

CREATE TABLE sales_orders (
  id                    BIGSERIAL PRIMARY KEY,
  tenant_id             INT NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  nuport_order_ref      VARCHAR(64) NOT NULL,
  woo_order_ref         VARCHAR(64),
  consignment_id        VARCHAR(64),
  steadfast_status      VARCHAR(32),
  steadfast_invoice_ref VARCHAR(64),
  courier               VARCHAR(32) NOT NULL DEFAULT 'STEADFAST',
  payment_mode          payment_mode NOT NULL,
  product_amount        NUMERIC(14,2) NOT NULL CHECK (product_amount >= 0),
  delivery_charge       NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_amount       NUMERIC(14,2) NOT NULL DEFAULT 0,
  cod_amount            NUMERIC(14,2) NOT NULL DEFAULT 0,
  fin_state             order_fin_state NOT NULL DEFAULT 'SYNCED',
  ordered_at            TIMESTAMPTZ,
  delivered_at          TIMESTAMPTZ,
  returned_at           TIMESTAMPTZ,
  settled_at            TIMESTAMPTZ,
  cogs_amount           NUMERIC(14,2),
  revenue_entry_id      BIGINT REFERENCES journal_entries(id),
  cogs_entry_id         BIGINT REFERENCES journal_entries(id),
  last_event_id         BIGINT REFERENCES nuport_events(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, nuport_order_ref)
);
CREATE INDEX idx_so_state       ON sales_orders(tenant_id, fin_state);
CREATE INDEX idx_so_consignment ON sales_orders(tenant_id, consignment_id);

CREATE TABLE sales_order_lines (
  id         BIGSERIAL PRIMARY KEY,
  tenant_id  INT NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  order_id   BIGINT NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  item_id    INT REFERENCES items(id),
  nuport_sku VARCHAR(64) NOT NULL,
  qty        NUMERIC(12,3) NOT NULL CHECK (qty > 0),
  unit_price NUMERIC(14,2) NOT NULL,
  line_total NUMERIC(14,2) NOT NULL,
  bom_id     INT REFERENCES boms(id),
  line_cogs  NUMERIC(14,2)
);
CREATE INDEX idx_sol_order ON sales_order_lines(order_id);
