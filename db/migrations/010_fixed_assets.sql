-- 010: Fixed assets + depreciation (blueprint §8, §9.7)

CREATE TABLE fixed_assets (
  id                      SERIAL PRIMARY KEY,
  asset_code              VARCHAR(32) NOT NULL UNIQUE,
  name                    VARCHAR(160) NOT NULL,
  asset_account_id        INT NOT NULL REFERENCES accounts(id),   -- 15xx
  acquired_on             DATE NOT NULL,
  cost                    NUMERIC(14,2) NOT NULL CHECK (cost > 0),
  salvage_value           NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (salvage_value >= 0),
  life_months             INT CHECK (life_months > 0),
  method                  depr_method NOT NULL,
  diminishing_annual_rate NUMERIC(6,4),
  status                  VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  purchase_entry_id       BIGINT REFERENCES journal_entries(id),
  CONSTRAINT chk_method_params CHECK (
    (method = 'STRAIGHT_LINE' AND life_months IS NOT NULL) OR
    (method = 'DIMINISHING'  AND diminishing_annual_rate IS NOT NULL)
  ),
  CONSTRAINT chk_salvage CHECK (salvage_value < cost)
);

CREATE TABLE depreciation_entries (
  id               BIGSERIAL PRIMARY KEY,
  asset_id         INT NOT NULL REFERENCES fixed_assets(id),
  period           CHAR(7) NOT NULL REFERENCES fiscal_periods(period),
  amount           NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  book_value_after NUMERIC(14,2) NOT NULL,
  posted_entry_id  BIGINT REFERENCES journal_entries(id),
  UNIQUE (asset_id, period)                      -- idempotency: one charge per period
);

CREATE TABLE asset_disposals (
  id                  BIGSERIAL PRIMARY KEY,
  asset_id            INT NOT NULL UNIQUE REFERENCES fixed_assets(id),
  disposed_on         DATE NOT NULL,
  sale_price          NUMERIC(14,2) NOT NULL CHECK (sale_price >= 0),
  proceeds_account_id INT NOT NULL REFERENCES accounts(id),
  book_value          NUMERIC(14,2) NOT NULL,
  gain_loss           NUMERIC(14,2) NOT NULL,    -- + gain / − loss (computed)
  posted_entry_id     BIGINT REFERENCES journal_entries(id),
  entered_by          INT
);
