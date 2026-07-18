-- Seed: chart of accounts (§3), posting rules (§4.7), fiscal periods.
-- Idempotent: safe to run repeatedly (ON CONFLICT DO NOTHING throughout).

-- ---- Fiscal periods: 2026-01 .. 2027-12 ----
INSERT INTO fiscal_periods (period, starts_on, ends_on)
SELECT to_char(d, 'YYYY-MM'),
       d::date,
       (d + interval '1 month - 1 day')::date
FROM generate_series('2026-01-01'::date, '2027-12-01'::date, interval '1 month') AS d
ON CONFLICT (period) DO NOTHING;

-- ---- Chart of accounts ----
INSERT INTO accounts (code, name, type, normal_balance, is_cash_location) VALUES
  -- Assets (1xxx)
  ('1010', 'Cash in Hand',                            'ASSET', 'DEBIT',  TRUE),
  ('1020', 'Bank — Current Account',                  'ASSET', 'DEBIT',  TRUE),
  ('1030', 'bKash Merchant Wallet',                   'ASSET', 'DEBIT',  TRUE),
  ('1040', 'Nagad Wallet',                            'ASSET', 'DEBIT',  TRUE),
  ('1110', 'Unsettled Courier Funds — Steadfast',     'ASSET', 'DEBIT',  FALSE),
  ('1115', 'Courier Payment In Transit — Steadfast',  'ASSET', 'DEBIT',  FALSE),
  ('1210', 'Accounts Receivable — Other',             'ASSET', 'DEBIT',  FALSE),
  ('1310', 'Inventory — Raw Materials',               'ASSET', 'DEBIT',  FALSE),
  ('1320', 'Inventory — Packaging Materials',         'ASSET', 'DEBIT',  FALSE),
  ('1330', 'Inventory — Finished Goods',              'ASSET', 'DEBIT',  FALSE),
  ('1340', 'Inventory — Goods in Transit',            'ASSET', 'DEBIT',  FALSE),
  ('1410', 'Advances & Prepayments',                  'ASSET', 'DEBIT',  FALSE),
  ('1510', 'Fixed Assets — Machinery & Equipment',    'ASSET', 'DEBIT',  FALSE),
  ('1520', 'Fixed Assets — Computers & Electronics',  'ASSET', 'DEBIT',  FALSE),
  ('1530', 'Fixed Assets — Furniture & Fixtures',     'ASSET', 'DEBIT',  FALSE),
  ('1590', 'Accumulated Depreciation',                'ASSET', 'CREDIT', FALSE),  -- contra
  -- Liabilities (2xxx)
  ('2010', 'Accounts Payable — Suppliers',            'LIABILITY', 'CREDIT', FALSE),
  ('2110', 'Customer Advances (Unearned Revenue)',    'LIABILITY', 'CREDIT', FALSE),
  ('2210', 'Accrued Expenses',                        'LIABILITY', 'CREDIT', FALSE),
  ('2310', 'Loans Payable',                           'LIABILITY', 'CREDIT', FALSE),
  -- Equity (3xxx) — partner names updated via Settings once partners registered
  ('3010', 'Partner Capital — Partner 1',             'EQUITY', 'CREDIT', FALSE),
  ('3011', 'Partner Capital — Partner 2',             'EQUITY', 'CREDIT', FALSE),
  ('3110', 'Partner Drawings — Partner 1',            'EQUITY', 'DEBIT',  FALSE), -- contra
  ('3111', 'Partner Drawings — Partner 2',            'EQUITY', 'DEBIT',  FALSE), -- contra
  ('3910', 'Retained Earnings',                       'EQUITY', 'CREDIT', FALSE),
  ('3990', 'Current Year Earnings',                   'EQUITY', 'CREDIT', FALSE),
  -- Income (4xxx)
  ('4010', 'Sales Revenue — Products',                'INCOME', 'CREDIT', FALSE),
  ('4020', 'Delivery Charge Income',                  'INCOME', 'CREDIT', FALSE),
  ('4110', 'Sales Returns & Allowances',              'INCOME', 'DEBIT',  FALSE), -- contra
  ('4210', 'Other Income',                            'INCOME', 'CREDIT', FALSE),
  ('4910', 'Gain on Asset Disposal',                  'INCOME', 'CREDIT', FALSE),
  -- Expenses (5xxx–6xxx)
  ('5010', 'COGS — Raw Materials',                    'EXPENSE', 'DEBIT', FALSE),
  ('5020', 'COGS — Packaging',                        'EXPENSE', 'DEBIT', FALSE),
  ('5090', 'Inventory Shrinkage/Adjustment',          'EXPENSE', 'DEBIT', FALSE),
  ('6010', 'Courier & Delivery Charges',              'EXPENSE', 'DEBIT', FALSE),
  ('6020', 'Marketing — Facebook Ads/Boosting',       'EXPENSE', 'DEBIT', FALSE),
  ('6030', 'Payment Gateway Charges',                 'EXPENSE', 'DEBIT', FALSE),
  ('6110', 'Salaries & Labor',                        'EXPENSE', 'DEBIT', FALSE),
  ('6120', 'Electricity & Utilities',                 'EXPENSE', 'DEBIT', FALSE),
  ('6130', 'Rent',                                    'EXPENSE', 'DEBIT', FALSE),
  ('6140', 'Office & Miscellaneous',                  'EXPENSE', 'DEBIT', FALSE),
  ('6210', 'Depreciation Expense',                    'EXPENSE', 'DEBIT', FALSE),
  ('6910', 'Loss on Asset Disposal',                  'EXPENSE', 'DEBIT', FALSE)
ON CONFLICT (code) DO NOTHING;

-- ---- Posting-rule matrix (§4.7) ----
-- "$name" account slots are resolved by the posting service at runtime
-- (e.g. $expense_account = the category the user picked).
INSERT INTO posting_rules (event_code, description, rule_json) VALUES
('SALE_DELIVERED_COD',     'Delivered COD order — revenue recognition',
 '{"debit":[{"account":"1110","amount":"cod_amount"}],"credit":[{"account":"4010","amount":"product_amount"},{"account":"4020","amount":"delivery_charge"}]}'),
('SALE_DELIVERED_PREPAID', 'Delivered prepaid order — clear customer advance',
 '{"debit":[{"account":"2110","amount":"order_total"}],"credit":[{"account":"4010","amount":"product_amount"},{"account":"4020","amount":"delivery_charge"}]}'),
('PREPAYMENT_RECEIVED',    'Prepayment received before delivery',
 '{"debit":[{"account":"$wallet_account","amount":"net_received"},{"account":"6030","amount":"gateway_fee"}],"credit":[{"account":"2110","amount":"order_total"}]}'),
('COGS_BOM',               'BOM deduction to COGS at delivery',
 '{"debit":[{"account":"5010","amount":"cogs_raw"},{"account":"5020","amount":"cogs_packaging"}],"credit":[{"account":"1310","amount":"cogs_raw"},{"account":"1320","amount":"cogs_packaging"}]}'),
('COURIER_BATCHED',        'Steadfast payout invoice detected — funds move to in-transit',
 '{"debit":[{"account":"1115","amount":"gross_cod"}],"credit":[{"account":"1110","amount":"gross_cod"}]}'),
('COURIER_SETTLEMENT',     'Steadfast payout disbursed — fees auto-expensed',
 '{"debit":[{"account":"$payout_account","amount":"net_paid"},{"account":"6010","amount":"courier_charges"}],"credit":[{"account":"1115","amount":"gross_cod"}]}'),
('RTO_CHARGE',             'Return-to-origin charge before delivery',
 '{"debit":[{"account":"6010","amount":"rto_charge"}],"credit":[{"account":"1110","amount":"rto_charge"}]}'),
('POST_DELIVERY_RETURN',   'Customer return after delivery',
 '{"debit":[{"account":"4110","amount":"product_amount"},{"account":"4020","amount":"delivery_charge_refund"}],"credit":[{"account":"$refund_source","amount":"refund_total"}]}'),
('RETURN_RESTOCK',         'Sellable return restocked — reverse COGS',
 '{"debit":[{"account":"1310","amount":"cogs_raw"},{"account":"1320","amount":"cogs_packaging"}],"credit":[{"account":"5010","amount":"cogs_raw"},{"account":"5020","amount":"cogs_packaging"}]}'),
('PURCHASE_RAW',           'Raw material purchase',
 '{"debit":[{"account":"1310","amount":"total"}],"credit":[{"account":"$paid_from_or_ap","amount":"total"}]}'),
('PURCHASE_PACKAGING',     'Packaging material purchase',
 '{"debit":[{"account":"1320","amount":"total"}],"credit":[{"account":"$paid_from_or_ap","amount":"total"}]}'),
('OPEX',                   'Operating expense entry',
 '{"debit":[{"account":"$expense_account","amount":"amount"}],"credit":[{"account":"$paid_from_account","amount":"amount"}]}'),
('CAPITAL_IN',             'Partner capital injection',
 '{"debit":[{"account":"$deposit_account","amount":"amount"}],"credit":[{"account":"$partner_capital","amount":"amount"}]}'),
('DRAWING_CASH',           'Partner cash drawing',
 '{"debit":[{"account":"$partner_drawings","amount":"amount"}],"credit":[{"account":"$cash_account","amount":"amount"}]}'),
('DRAWING_KIND',           'Partner drawing in kind (product at BOM cost)',
 '{"debit":[{"account":"$partner_drawings","amount":"total_cost"}],"credit":[{"account":"1310","amount":"cost_raw"},{"account":"1320","amount":"cost_packaging"}]}'),
('FA_PURCHASE',            'Fixed asset acquisition',
 '{"debit":[{"account":"$asset_account","amount":"cost"}],"credit":[{"account":"$paid_from_account","amount":"cost"}]}'),
('FA_DEPRECIATION',        'Monthly depreciation charge',
 '{"debit":[{"account":"6210","amount":"period_total"}],"credit":[{"account":"1590","amount":"period_total"}]}'),
('FA_DISPOSAL',            'Asset disposal with auto gain/loss',
 '{"debit":[{"account":"$proceeds_account","amount":"sale_price"},{"account":"1590","amount":"accum_depreciation"},{"account":"6910","amount":"loss_if_any"}],"credit":[{"account":"$asset_account","amount":"cost"},{"account":"4910","amount":"gain_if_any"}]}'),
('SHRINKAGE',              'Stock count variance / spoilage',
 '{"debit":[{"account":"5090","amount":"variance_value"}],"credit":[{"account":"$inventory_account","amount":"variance_value"}]}')
ON CONFLICT (event_code) DO NOTHING;
