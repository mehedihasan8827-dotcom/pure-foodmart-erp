-- 002: Chart of accounts + fiscal periods (blueprint §3, §9.1)

CREATE TABLE accounts (
  id               SERIAL PRIMARY KEY,
  code             VARCHAR(8)   NOT NULL UNIQUE,
  name             VARCHAR(120) NOT NULL,
  type             account_type NOT NULL,
  normal_balance   normal_side  NOT NULL,
  parent_id        INT REFERENCES accounts(id),
  is_cash_location BOOLEAN NOT NULL DEFAULT FALSE,   -- 1010/1020/1030/1040
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fiscal_periods (
  id        SERIAL PRIMARY KEY,
  period    CHAR(7) NOT NULL UNIQUE,          -- 'YYYY-MM'
  starts_on DATE NOT NULL,
  ends_on   DATE NOT NULL,
  is_locked BOOLEAN NOT NULL DEFAULT FALSE,
  locked_at TIMESTAMPTZ,
  locked_by INT                               -- FK to users added in 011
);
