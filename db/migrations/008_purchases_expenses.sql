-- 008: Purchases + operating expenses (blueprint §4.3, §4.4, §9.5)

CREATE TABLE suppliers (
  id        SERIAL PRIMARY KEY,
  name      VARCHAR(120) NOT NULL,
  phone     VARCHAR(32),
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE purchases (
  id                   BIGSERIAL PRIMARY KEY,
  supplier_id          INT REFERENCES suppliers(id),
  purchased_on         DATE NOT NULL,
  invoice_ref          VARCHAR(64),
  paid_from_account_id INT REFERENCES accounts(id),   -- NULL = on credit (AP 2010)
  total_amount         NUMERIC(14,2) NOT NULL,
  posted_entry_id      BIGINT REFERENCES journal_entries(id),
  entered_by           INT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchase_lines (
  id          BIGSERIAL PRIMARY KEY,
  purchase_id BIGINT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  item_id     INT NOT NULL REFERENCES items(id),
  qty         NUMERIC(12,3) NOT NULL CHECK (qty > 0),
  unit_cost   NUMERIC(14,6) NOT NULL CHECK (unit_cost >= 0),
  line_total  NUMERIC(14,2) NOT NULL
);

CREATE TABLE expenses (
  id                   BIGSERIAL PRIMARY KEY,
  expense_date         DATE NOT NULL,
  expense_account_id   INT NOT NULL REFERENCES accounts(id),
  paid_from_account_id INT NOT NULL REFERENCES accounts(id),
  amount               NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  description          TEXT NOT NULL,
  receipt_url          TEXT,
  posted_entry_id      BIGINT REFERENCES journal_entries(id),
  entered_by           INT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
