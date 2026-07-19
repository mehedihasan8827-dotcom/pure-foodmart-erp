import { Money } from "@pfm/domain";
import { checkCourierFunds } from "@pfm/pipeline";
import type { PoolClient } from "pg";

/** S4 — the courier fund board, served straight from the ledger + orders. */

export interface FundsBoard {
  waiting: { orderRef: string; consignmentId: string | null; cod: string; ageDays: number }[];
  pending: { invoiceRef: string; statementDate: string; orders: number; gross: string }[];
  settledThisMonth: string;
  aging: { bucket: string; amount: string }[];
  ledger: {
    waiting1110: string;
    pending1115: string;
    matchesOrders: boolean; // invariant I2, live
  };
}

const BUCKETS: { bucket: string; min: number; max: number }[] = [
  { bucket: "0–7", min: 0, max: 7 },
  { bucket: "8–14", min: 8, max: 14 },
  { bucket: "15–30", min: 15, max: 30 },
  { bucket: ">30", min: 31, max: Number.MAX_SAFE_INTEGER },
];

export async function getFundsBoard(client: PoolClient): Promise<FundsBoard> {
  const waiting = await client.query<{
    nuport_order_ref: string;
    consignment_id: string | null;
    cod_amount: string;
    age: number;
  }>(
    `SELECT nuport_order_ref, consignment_id, cod_amount::text,
            GREATEST(0, (current_date - delivered_at::date))::int AS age
     FROM sales_orders
     WHERE fin_state IN ('REVENUE_POSTED','NEEDS_BOM') AND payment_mode = 'COD'
     ORDER BY delivered_at NULLS LAST, id`,
  );
  const pending = await client.query<{
    statement_ref: string;
    statement_date: string;
    gross_cod: string;
    n: string;
  }>(
    `SELECT cs.statement_ref, cs.statement_date::text, cs.gross_cod::text,
            (SELECT count(*) FROM settlement_lines sl
             WHERE sl.settlement_id = cs.id) AS n
     FROM courier_settlements cs
     WHERE cs.status = 'BATCHED' ORDER BY cs.statement_date, cs.id`,
  );
  const settled = await client.query<{ v: string }>(
    `SELECT COALESCE(SUM(gross_cod), 0)::NUMERIC(14,2)::text AS v
     FROM courier_settlements
     WHERE status = 'POSTED'
       AND date_trunc('month', statement_date) = date_trunc('month', current_date)`,
  );

  const aging = BUCKETS.map(({ bucket, min, max }) => ({
    bucket,
    amount: waiting.rows
      .filter((w) => w.age >= min && w.age <= max)
      .reduce((acc, w) => acc.add(Money.fromTaka(w.cod_amount)), Money.ZERO)
      .toTakaString(),
  }));

  const funds = await checkCourierFunds(client);
  return {
    waiting: waiting.rows.map((w) => ({
      orderRef: w.nuport_order_ref,
      consignmentId: w.consignment_id,
      cod: w.cod_amount,
      ageDays: w.age,
    })),
    pending: pending.rows.map((p) => ({
      invoiceRef: p.statement_ref,
      statementDate: p.statement_date,
      orders: Number(p.n),
      gross: p.gross_cod,
    })),
    settledThisMonth: settled.rows[0]!.v,
    aging,
    ledger: {
      waiting1110: funds.ledger1110.toTakaString(),
      pending1115: funds.ledger1115.toTakaString(),
      matchesOrders: funds.ok,
    },
  };
}

export interface TrialBalanceRow {
  code: string;
  name: string;
  type: string;
  totalDebit: string;
  totalCredit: string;
  balance: string;
}

export async function getTrialBalanceReport(client: PoolClient): Promise<{
  balanced: boolean;
  totalDebit: string;
  totalCredit: string;
  rows: TrialBalanceRow[];
}> {
  const totals = await client.query<{ d: string; c: string }>(
    `SELECT COALESCE(SUM(debit),0)::NUMERIC(14,2)::text AS d,
            COALESCE(SUM(credit),0)::NUMERIC(14,2)::text AS c
     FROM journal_lines`,
  );
  const rows = await client.query<TrialBalanceRow>(
    `SELECT code, name, type,
            total_debit::text AS "totalDebit",
            total_credit::text AS "totalCredit",
            balance::text AS balance
     FROM account_balances
     WHERE total_debit <> 0 OR total_credit <> 0
     ORDER BY code`,
  );
  const t = totals.rows[0]!;
  return {
    balanced: Money.fromTaka(t.d).equals(Money.fromTaka(t.c)),
    totalDebit: t.d,
    totalCredit: t.c,
    rows: rows.rows,
  };
}
