-- 001: Enumerated types (blueprint §9.0)

CREATE TYPE account_type    AS ENUM ('ASSET','LIABILITY','EQUITY','INCOME','EXPENSE');
CREATE TYPE normal_side     AS ENUM ('DEBIT','CREDIT');
CREATE TYPE item_kind       AS ENUM ('RAW','PACKAGING','FINISHED');
CREATE TYPE movement_type   AS ENUM ('PURCHASE','SALE_BOM','RETURN_RESTOCK','ADJUSTMENT',
                                     'DRAWING_KIND','SHIP_OUT','TRANSIT_TO_COGS','TRANSIT_RESTOCK');
CREATE TYPE order_fin_state AS ENUM ('SYNCED','REVENUE_POSTED','PAYMENT_PENDING','RETURN_POSTED',
                                     'CLOSED_NO_REVENUE','SETTLED','NEEDS_BOM','EXCEPTION');
CREATE TYPE payment_mode    AS ENUM ('COD','BKASH','NAGAD','BANK','CARD','OTHER');
CREATE TYPE source_type     AS ENUM ('NUPORT_ORDER','SETTLEMENT','PURCHASE','EXPENSE',
                                     'EQUITY','FIXED_ASSET','DEPRECIATION','STOCK_COUNT',
                                     'MANUAL_JOURNAL','CLOSING');
CREATE TYPE equity_kind     AS ENUM ('CAPITAL_IN','DRAWING_CASH','DRAWING_KIND',
                                     'PROFIT_ALLOCATION','DRAWINGS_CLOSE');
CREATE TYPE depr_method     AS ENUM ('STRAIGHT_LINE','DIMINISHING');
CREATE TYPE sync_channel    AS ENUM ('WEBHOOK','CRON');
CREATE TYPE event_status    AS ENUM ('RECEIVED','QUEUED','PROCESSED','SKIPPED_DUPLICATE','FAILED');
