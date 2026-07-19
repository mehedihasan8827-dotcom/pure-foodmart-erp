-- 005: Items, versioned BOMs, inventory subledger — per tenant (§5, §9.2)

CREATE TABLE items (
  id          SERIAL PRIMARY KEY,
  tenant_id   INT NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  sku         VARCHAR(64) NOT NULL,             -- FINISHED skus == merchant's Nuport SKUs
  name        VARCHAR(160) NOT NULL,
  kind        item_kind NOT NULL,
  uom         VARCHAR(8) NOT NULL,              -- 'KG' | 'PCS'
  inventory_account_id INT REFERENCES accounts(id),  -- tenant's 1310/1320 (components)
  cogs_account_id      INT REFERENCES accounts(id),  -- tenant's 5010/5020
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku),
  CONSTRAINT chk_component_accounts CHECK (
    kind = 'FINISHED' OR
    (inventory_account_id IS NOT NULL AND cogs_account_id IS NOT NULL)
  )
);

CREATE TABLE boms (
  id               SERIAL PRIMARY KEY,
  tenant_id        INT NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  finished_item_id INT NOT NULL REFERENCES items(id),
  version          INT NOT NULL,
  valid_from       DATE NOT NULL,
  valid_to         DATE,                        -- NULL = current
  created_by       INT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (finished_item_id, version)
);
CREATE UNIQUE INDEX uq_bom_open ON boms(finished_item_id) WHERE valid_to IS NULL;

CREATE TABLE bom_lines (
  id                SERIAL PRIMARY KEY,
  tenant_id         INT NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  bom_id            INT NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
  component_item_id INT NOT NULL REFERENCES items(id),
  qty_per_unit      NUMERIC(12,3) NOT NULL CHECK (qty_per_unit > 0),
  UNIQUE (bom_id, component_item_id)
);

CREATE TABLE item_stock (
  item_id    INT PRIMARY KEY REFERENCES items(id),
  tenant_id  INT NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  on_hand    NUMERIC(12,3) NOT NULL DEFAULT 0,
  avg_cost   NUMERIC(14,6) NOT NULL DEFAULT 0,  -- moving weighted average (§5.3)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE inventory_movements (
  id               BIGSERIAL PRIMARY KEY,
  tenant_id        INT NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  item_id          INT NOT NULL REFERENCES items(id),
  movement_type    movement_type NOT NULL,
  qty              NUMERIC(12,3) NOT NULL CHECK (qty <> 0),
  unit_cost        NUMERIC(14,6) NOT NULL CHECK (unit_cost >= 0),
  value            NUMERIC(14,2) NOT NULL,
  source_type      source_type NOT NULL,
  source_id        BIGINT NOT NULL,
  journal_entry_id BIGINT REFERENCES journal_entries(id),
  moved_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_mov_item ON inventory_movements(item_id, moved_at);
CREATE INDEX idx_mov_src  ON inventory_movements(tenant_id, source_type, source_id);

CREATE TABLE stock_counts (
  id              SERIAL PRIMARY KEY,
  tenant_id       INT NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  counted_on      DATE NOT NULL,
  counted_by      INT,
  posted_entry_id BIGINT REFERENCES journal_entries(id),
  notes           TEXT
);

CREATE TABLE stock_count_lines (
  id             SERIAL PRIMARY KEY,
  tenant_id      INT NOT NULL DEFAULT app_tenant_id() REFERENCES tenants(id),
  stock_count_id INT NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  item_id        INT NOT NULL REFERENCES items(id),
  book_qty       NUMERIC(12,3) NOT NULL,
  counted_qty    NUMERIC(12,3) NOT NULL,
  UNIQUE (stock_count_id, item_id)
);
