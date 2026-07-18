-- 004: Declarative posting-rule matrix (blueprint §4.7)
-- Account mappings are data, not code. Seeded from seed.sql.

CREATE TABLE posting_rules (
  event_code  VARCHAR(40) PRIMARY KEY,
  description TEXT NOT NULL,
  rule_json   JSONB NOT NULL      -- declarative Dr/Cr account mapping;
                                  -- "$variable" account slots resolved by callers
);
