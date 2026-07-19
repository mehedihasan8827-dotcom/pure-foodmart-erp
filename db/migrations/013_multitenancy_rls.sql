-- 013: Row-Level Security enforcement + tenant provisioning
--
-- Isolation lives in the DATABASE, like every other invariant in this
-- system. Every runtime transaction must run:
--     SELECT set_config('app.tenant_id', '<tenant id>', true);
-- RLS then makes other tenants' rows invisible AND un-writable, and the
-- DEFAULT app_tenant_id() on tenant_id columns stamps new rows.
--
-- FORCE ROW LEVEL SECURITY applies the policies even to the table owner,
-- so local dev and tests exercise exactly what production enforces.
-- Super-admin/platform jobs use a dedicated BYPASSRLS database role in
-- production (created in B13 hardening) — never the tenant runtime role.

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_integrations','accounts','fiscal_periods',
    'ledger_sequence','journal_entries','journal_lines',
    'items','boms','bom_lines','item_stock','inventory_movements',
    'stock_counts','stock_count_lines',
    'sync_runs','nuport_events','sales_orders','sales_order_lines',
    'steadfast_events','courier_settlements','settlement_lines',
    'suppliers','purchases','purchase_lines','expenses',
    'partners','partner_share_versions','equity_transactions',
    'fixed_assets','depreciation_entries','asset_disposals',
    'integrity_alerts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = app_tenant_id())
         WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

-- tenants: enabled but NOT forced — provisioning and platform jobs (owner /
-- BYPASSRLS) manage tenants; the runtime tenant role sees only itself.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants
  USING (id = app_tenant_id());

-- audit_log: enabled, not forced — platform-level rows have tenant_id NULL
-- and are written by system/platform roles; tenants see only their own.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_audit ON audit_log
  USING (tenant_id = app_tenant_id())
  WITH CHECK (tenant_id = app_tenant_id());

-- users / tenant_users / posting_rules stay un-policied: auth must resolve a
-- user before any tenant context exists; access is mediated by the auth
-- service (B7) and the runtime role gets only SELECT on them.

-- ------------------------------------------------------------------
-- Tenant provisioning: tenant row + ledger sequence + standard chart of
-- accounts + fiscal periods, atomically. Sets the tenant context for the
-- remainder of the calling transaction.
-- ------------------------------------------------------------------
CREATE FUNCTION provision_tenant(
  p_name TEXT,
  p_slug TEXT,
  p_periods_from DATE DEFAULT '2026-01-01',
  p_periods_to   DATE DEFAULT '2027-12-01'
) RETURNS INT LANGUAGE plpgsql AS $$
DECLARE v_tenant INT;
BEGIN
  INSERT INTO tenants (name, slug) VALUES (p_name, p_slug) RETURNING id INTO v_tenant;
  PERFORM set_config('app.tenant_id', v_tenant::text, true);

  INSERT INTO ledger_sequence (tenant_id) VALUES (v_tenant);

  INSERT INTO fiscal_periods (period, starts_on, ends_on)
  SELECT to_char(d, 'YYYY-MM'), d::date, (d + interval '1 month - 1 day')::date
  FROM generate_series(p_periods_from, p_periods_to, interval '1 month') AS d;

  INSERT INTO accounts (code, name, type, normal_balance, is_cash_location)
  VALUES
    ('1010','Cash in Hand','ASSET','DEBIT',TRUE),
    ('1020','Bank — Current Account','ASSET','DEBIT',TRUE),
    ('1030','bKash Merchant Wallet','ASSET','DEBIT',TRUE),
    ('1040','Nagad Wallet','ASSET','DEBIT',TRUE),
    ('1110','Unsettled Courier Funds — Courier','ASSET','DEBIT',FALSE),
    ('1115','Courier Payment In Transit — Courier','ASSET','DEBIT',FALSE),
    ('1210','Accounts Receivable — Other','ASSET','DEBIT',FALSE),
    ('1310','Inventory — Raw Materials','ASSET','DEBIT',FALSE),
    ('1320','Inventory — Packaging Materials','ASSET','DEBIT',FALSE),
    ('1330','Inventory — Finished Goods','ASSET','DEBIT',FALSE),
    ('1340','Inventory — Goods in Transit','ASSET','DEBIT',FALSE),
    ('1410','Advances & Prepayments','ASSET','DEBIT',FALSE),
    ('1510','Fixed Assets — Machinery & Equipment','ASSET','DEBIT',FALSE),
    ('1520','Fixed Assets — Computers & Electronics','ASSET','DEBIT',FALSE),
    ('1530','Fixed Assets — Furniture & Fixtures','ASSET','DEBIT',FALSE),
    ('1590','Accumulated Depreciation','ASSET','CREDIT',FALSE),
    ('2010','Accounts Payable — Suppliers','LIABILITY','CREDIT',FALSE),
    ('2110','Customer Advances (Unearned Revenue)','LIABILITY','CREDIT',FALSE),
    ('2210','Accrued Expenses','LIABILITY','CREDIT',FALSE),
    ('2310','Loans Payable','LIABILITY','CREDIT',FALSE),
    ('3010','Partner Capital — Partner 1','EQUITY','CREDIT',FALSE),
    ('3011','Partner Capital — Partner 2','EQUITY','CREDIT',FALSE),
    ('3110','Partner Drawings — Partner 1','EQUITY','DEBIT',FALSE),
    ('3111','Partner Drawings — Partner 2','EQUITY','DEBIT',FALSE),
    ('3910','Retained Earnings','EQUITY','CREDIT',FALSE),
    ('3990','Current Year Earnings','EQUITY','CREDIT',FALSE),
    ('4010','Sales Revenue — Products','INCOME','CREDIT',FALSE),
    ('4020','Delivery Charge Income','INCOME','CREDIT',FALSE),
    ('4110','Sales Returns & Allowances','INCOME','DEBIT',FALSE),
    ('4210','Other Income','INCOME','CREDIT',FALSE),
    ('4910','Gain on Asset Disposal','INCOME','CREDIT',FALSE),
    ('5010','COGS — Raw Materials','EXPENSE','DEBIT',FALSE),
    ('5020','COGS — Packaging','EXPENSE','DEBIT',FALSE),
    ('5090','Inventory Shrinkage/Adjustment','EXPENSE','DEBIT',FALSE),
    ('6010','Courier & Delivery Charges','EXPENSE','DEBIT',FALSE),
    ('6020','Marketing — Facebook Ads/Boosting','EXPENSE','DEBIT',FALSE),
    ('6030','Payment Gateway Charges','EXPENSE','DEBIT',FALSE),
    ('6110','Salaries & Labor','EXPENSE','DEBIT',FALSE),
    ('6120','Electricity & Utilities','EXPENSE','DEBIT',FALSE),
    ('6130','Rent','EXPENSE','DEBIT',FALSE),
    ('6140','Office & Miscellaneous','EXPENSE','DEBIT',FALSE),
    ('6210','Depreciation Expense','EXPENSE','DEBIT',FALSE),
    ('6910','Loss on Asset Disposal','EXPENSE','DEBIT',FALSE);

  RETURN v_tenant;
END $$;
