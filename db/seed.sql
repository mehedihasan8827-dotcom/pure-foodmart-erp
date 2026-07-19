-- Global platform seed. Idempotent (ON CONFLICT DO NOTHING).
--
-- Multi-tenant note: chart of accounts + fiscal periods are PER TENANT and
-- are created by provision_tenant() (migration 013), not seeded globally.
-- Only platform-level configuration lives here.

-- ---- Posting-rule matrix (§4.7) — platform-defined accounting logic ----
-- "$name" account slots are resolved by the posting service at runtime.
INSERT INTO posting_rules (event_code, description, rule_json) VALUES
('SALE_DELIVERED_COD',     'Delivered COD order — revenue recognition',
 '{"debit":[{"account":"1110","amount":"cod_amount"}],"credit":[{"account":"4010","amount":"product_amount"},{"account":"4020","amount":"delivery_charge"}]}'),
('SALE_DELIVERED_PREPAID', 'Delivered prepaid order — clear customer advance',
 '{"debit":[{"account":"2110","amount":"order_total"}],"credit":[{"account":"4010","amount":"product_amount"},{"account":"4020","amount":"delivery_charge"}]}'),
('PREPAYMENT_RECEIVED',    'Prepayment received before delivery',
 '{"debit":[{"account":"$wallet_account","amount":"net_received"},{"account":"6030","amount":"gateway_fee"}],"credit":[{"account":"2110","amount":"order_total"}]}'),
('COGS_BOM',               'BOM deduction to COGS at delivery',
 '{"debit":[{"account":"5010","amount":"cogs_raw"},{"account":"5020","amount":"cogs_packaging"}],"credit":[{"account":"1310","amount":"cogs_raw"},{"account":"1320","amount":"cogs_packaging"}]}'),
('COURIER_BATCHED',        'Courier payout invoice detected — funds move to in-transit',
 '{"debit":[{"account":"1115","amount":"gross_cod"}],"credit":[{"account":"1110","amount":"gross_cod"}]}'),
('COURIER_SETTLEMENT',     'Courier payout disbursed — fees auto-expensed',
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
