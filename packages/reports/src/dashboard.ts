import { Money } from "@pfm/domain";
import type { PoolClient } from "pg";

/**
 * Dashboard aggregates (S1). Every number here is derived from
 * journal_lines at query time — no cached balances anywhere (P1).
 * All amounts are 2-dp decimal strings, exactly as the ledger stores them.
 */

export interface CashStrip {
  cashInHand: string; // 1010
  bank: string; // 1020
  bkash: string; // 1030
  nagad: string; // 1040
  courierWaiting: string; // 1110
  courierPending: string; // 1115
  totalLiquid: string;
}

export interface PlAggregate {
  revenue: string; // 4010 + 4020 − 4110 (net of returns)
  cogs: string; // 5010 + 5020 + 5090
  opex: string; // 6xxx
  netProfit: string; // revenue − cogs − opex
  ordersDelivered: number;
}

export interface DashboardSummary {
  asOf: string;
  cash: CashStrip;
  today: PlAggregate;
  thisWeek: PlAggregate; // last 7 days incl. today
  openExceptions: number;
}

const CASH_CODES = ["1010", "1020", "1030", "1040", "1110", "1115"] as const;

export async function getCashStrip(client: PoolClient): Promise<CashStrip> {
  const res = await client.query<{ code: string; balance: string }>(
    "SELECT code, balance::text FROM account_balances WHERE code = ANY($1)",
    [CASH_CODES as unknown as string[]],
  );
  const byCode = new Map(res.rows.map((r) => [r.code, r.balance]));
  const get = (code: string) => byCode.get(code) ?? "0.00";
  const total = CASH_CODES.reduce(
    (acc, code) => acc.add(Money.fromTaka(get(code))),
    Money.ZERO,
  );
  return {
    cashInHand: get("1010"),
    bank: get("1020"),
    bkash: get("1030"),
    nagad: get("1040"),
    courierWaiting: get("1110"),
    courierPending: get("1115"),
    totalLiquid: total.toTakaString(),
  };
}

export async function getPlAggregate(
  client: PoolClient,
  fromDate: string,
  toDate: string,
): Promise<PlAggregate> {
  const res = await client.query<{ revenue: string; cogs: string; opex: string }>(
    `SELECT
       COALESCE(SUM(jl.credit - jl.debit)
         FILTER (WHERE a.code IN ('4010','4020','4110')), 0)::NUMERIC(14,2)::text AS revenue,
       COALESCE(SUM(jl.debit - jl.credit)
         FILTER (WHERE a.code IN ('5010','5020','5090')), 0)::NUMERIC(14,2)::text AS cogs,
       COALESCE(SUM(jl.debit - jl.credit)
         FILTER (WHERE a.code LIKE '6%'), 0)::NUMERIC(14,2)::text AS opex
     FROM journal_lines jl
     JOIN journal_entries je ON je.id = jl.entry_id
     JOIN accounts a ON a.id = jl.account_id
     WHERE je.entry_date BETWEEN $1::date AND $2::date`,
    [fromDate, toDate],
  );
  const row = res.rows[0]!;
  const orders = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM sales_orders
     WHERE delivered_at::date BETWEEN $1::date AND $2::date
       AND fin_state IN ('REVENUE_POSTED','PAYMENT_PENDING','SETTLED','NEEDS_BOM')`,
    [fromDate, toDate],
  );
  const revenue = Money.fromTaka(row.revenue);
  const cogs = Money.fromTaka(row.cogs);
  const opex = Money.fromTaka(row.opex);
  return {
    revenue: revenue.toTakaString(),
    cogs: cogs.toTakaString(),
    opex: opex.toTakaString(),
    netProfit: revenue.subtract(cogs).subtract(opex).toTakaString(),
    ordersDelivered: Number(orders.rows[0]!.n),
  };
}

export async function getDashboard(client: PoolClient): Promise<DashboardSummary> {
  const todayRes = await client.query<{ today: string; week_start: string }>(
    "SELECT current_date::text AS today, (current_date - 6)::text AS week_start",
  );
  const { today, week_start } = todayRes.rows[0]!;
  const alerts = await client.query<{ n: string }>(
    "SELECT count(*) AS n FROM integrity_alerts WHERE status = 'OPEN'",
  );
  return {
    asOf: new Date().toISOString(),
    cash: await getCashStrip(client),
    today: await getPlAggregate(client, today, today),
    thisWeek: await getPlAggregate(client, week_start, today),
    openExceptions: Number(alerts.rows[0]!.n),
  };
}

export interface DailyPl {
  date: string;
  revenue: string;
  cogs: string;
  opex: string;
  net: string;
}

/** N-day daily P&L series for the dashboard chart. */
export async function getDailySeries(
  client: PoolClient,
  days: number,
): Promise<DailyPl[]> {
  const n = Math.min(Math.max(days, 1), 90);
  const res = await client.query<{
    date: string;
    revenue: string;
    cogs: string;
    opex: string;
  }>(
    `SELECT d::date::text AS date,
       COALESCE(SUM(jl.credit - jl.debit)
         FILTER (WHERE a.code IN ('4010','4020','4110')), 0)::NUMERIC(14,2)::text AS revenue,
       COALESCE(SUM(jl.debit - jl.credit)
         FILTER (WHERE a.code IN ('5010','5020','5090')), 0)::NUMERIC(14,2)::text AS cogs,
       COALESCE(SUM(jl.debit - jl.credit)
         FILTER (WHERE a.code LIKE '6%'), 0)::NUMERIC(14,2)::text AS opex
     FROM generate_series(current_date - ($1::int - 1), current_date, interval '1 day') AS d
     LEFT JOIN journal_entries je ON je.entry_date = d::date
     LEFT JOIN journal_lines jl ON jl.entry_id = je.id
     LEFT JOIN accounts a ON a.id = jl.account_id
     GROUP BY d ORDER BY d`,
    [n],
  );
  return res.rows.map((r) => ({
    date: r.date,
    revenue: r.revenue,
    cogs: r.cogs,
    opex: r.opex,
    net: Money.fromTaka(r.revenue)
      .subtract(Money.fromTaka(r.cogs))
      .subtract(Money.fromTaka(r.opex))
      .toTakaString(),
  }));
}
