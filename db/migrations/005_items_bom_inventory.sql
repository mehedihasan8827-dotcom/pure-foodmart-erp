-- 005: Items, versioned BOMs, inventory subledger (blueprint §5, §9.2)

CREATE TABLE items (
  id          SERIAL PRIMARY KEY,
  sku         VARCHAR(64) NOT NULL UNIQUE,      -- FINISHED skus == Nuport SKU codes
  name        VARCHAR(160) NOT NULL,
  kind        item_kind NOT NULL,
  uom         VARCHAR(8) NOT NULL,              -- 'KG' | 'PCS'
  inventory_account_id INT REFERENCES accounts(id),  -- 1310 / 1320 (components only)
  cogs_account_id      INT REFERENCES accounts(id),  -- 5010 / 5020
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_component_accounts CHECK (
    kind = 'FINISHED' OR
    (inventory_account_id IS NOT NULL AND cogs_account_id IS NOT NULL)
  )
);

CREATE TABLE boms (
  id               SERIAL PRIMARY KEY,
  finished_item_id INT NOT NULL REFERENCES items(id),
  version          INT NOT NULL,
  valid_from       DATE NOT NULL,
  valid_to         DATE,                        -- NULL = current
  created_by       INT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (finished_item_id, version)
);
-- at most one open (valid_to IS NULL) version per finished item:
CREATE UNIQUE INDEX uq_bom_open ON boms(finished_item_id) WHERE valid_to IS NULL;

CREATE TABLE bom_lines (
  id                SERIAL PRIMARY KEY,
  bom_id            INT NOT NULL REFERENCES boms(id) ON DELETE CASCADE,
  component_item_id INT NOT NULL REFERENCES items(id),
  qty_per_unit      NUMERIC(12,3) NOT NULL CHECK (qty_per_unit > 0),
  UNIQUE (bom_id, component_item_id)
);

-- Cache row per RAW/PACKAGING item; fully rebuildable from inventory_movements.
CREATE TABLE item_stock (
  item_id    INT PRIMARY KEY REFERENCES items(id),
  on_hand    NUMERIC(12,3) NOT NULL DEFAULT 0,
  avg_cost   NUMERIC(14,6) NOT NULL DEFAULT 0,  -- moving weighted average (§5.3)
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The inventory subledger (append-only). qty: + in, − out. value = round(qty*unit_cost,2).
CREATE TABLE inventory_movements (
  id               BIGSERIAL PRIMARY KEY,
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
CREATE INDEX idx_mov_src  ON inventory_movements(source_type, source_id);

CREATE TABLE stock_counts (
  id              SERIAL PRIMARY KEY,
  counted_on      DATE NOT NULL,
  counted_by      INT,
  posted_entry_id BIGINT REFERENCES journal_entries(id),
  notes           TEXT
);

CREATE TABLE stock_count_lines (
  id             SERIAL PRIMARY KEY,
  stock_count_id INT NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  item_id        INT NOT NULL REFERENCES items(id),
  book_qty       NUMERIC(12,3) NOT NULL,
  counted_qty    NUMERIC(12,3) NOT NULL,
  UNIQUE (stock_count_id, item_id)
);
