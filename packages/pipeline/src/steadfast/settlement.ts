import { Money, type CanonicalPayoutInvoice } from "@pfm/domain";
import { postEntry, withTransaction, type PostedEntry } from "@pfm/ledger";
import type { Pool, PoolClient } from "pg";
import { raiseAlert } from "../shared/util";
import { ingestSteadfastEvent, markSteadfastEvent } from "./ingest";

export interface RecordInvoiceResult {
  outcome: "BATCHED" | "EXCEPTIONS" | "ALREADY_RECORDED";
  settlementId?: number;
  batchEntry?: PostedEntry;
  grossCod?: Money;
  courierCharges?: Money;
  netPaid?: Money;
  exceptions: { consignmentId: string; problem: string }[];
}

/**
 * Stage 1 → 2 (blueprint §6.2 steps 2 & 4): a Steadfast payout invoice
 * arrives (API poll or CSV upload — identical from here). Match every
 * line to an order by consignment id, verify collected == our COD to the
 * poisha, and only if the WHOLE invoice is clean post JE-C1
 * (Dr 1115 / Cr 1110) and move the orders to PAYMENT_PENDING.
 * Any exception leaves the settlement in DRAFT with zero postings —
 * the system refuses unbalanced or unexplained settlements.
 */
export async function recordPayoutInvoice(
  pool: Pool,
  tenantId: number,
  invoice: CanonicalPayoutInvoice,
  sourceChannel: "API" | "CSV" = "API",
): Promise<RecordInvoiceResult> {
  return withTransaction(pool, tenantId, async (c) => {
    const ingest = await ingestSteadfastEvent(c, {
      channel: "CRON",
      eventKind: "INVOICE_CREATED",
      invoiceRef: invoice.invoiceRef,
      payload: invoice,
    });

    const gross = sumMoney(invoice.lines.map((l) => l.codCollected));
    const charges = sumMoney(invoice.lines.map((l) => l.courierCharge));
    const net = gross.subtract(charges);

    const payoutAccount = await c.query<{ id: number }>(
      "SELECT id FROM accounts WHERE code = $1",
      [invoice.payoutAccountCode],
    );

    const created = await c.query<{ id: string }>(
      `INSERT INTO courier_settlements
         (courier, statement_ref, statement_date, gross_cod, courier_charges,
          net_paid, bank_account_id, source_channel, status)
       VALUES ('STEADFAST', $1, $2, $3, $4, $5, $6, $7, 'DRAFT')
       ON CONFLICT (tenant_id, courier, statement_ref) DO NOTHING
       RETURNING id`,
      [
        invoice.invoiceRef,
        invoice.statementDate,
        gross.toTakaString(),
        charges.toTakaString(),
        net.toTakaString(),
        payoutAccount.rows[0]!.id,
        sourceChannel,
      ],
    );
    if (!created.rows[0]) {
      if (ingest.eventId !== null) {
        await markSteadfastEvent(c, ingest.eventId, "PROCESSED");
      }
      return { outcome: "ALREADY_RECORDED", exceptions: [] };
    }
    const settlementId = Number(created.rows[0].id);

    // Match every line; collect exceptions instead of failing fast so the
    // merchant sees the complete picture in one pass.
    const exceptions: { consignmentId: string; problem: string }[] = [];
    const matched: { orderId: number; line: (typeof invoice.lines)[number] }[] = [];
    for (const line of invoice.lines) {
      const orderRes = await c.query<{
        id: string;
        fin_state: string;
        cod_amount: string;
      }>(
        `SELECT id, fin_state, cod_amount::text FROM sales_orders
         WHERE consignment_id = $1 ORDER BY id FOR UPDATE`,
        [line.consignmentId],
      );
      const order = orderRes.rows[0];
      let problem: string | null = null;
      if (!order) {
        problem = "UNKNOWN_ORDER";
      } else if (!(order.fin_state === "REVENUE_POSTED" || order.fin_state === "NEEDS_BOM")) {
        problem = `ORDER_STATE:${order.fin_state}`;
      } else if (!Money.fromTaka(order.cod_amount).equals(Money.fromTaka(line.codCollected))) {
        problem = `AMOUNT_MISMATCH:expected ${order.cod_amount}, courier reports ${Money.fromTaka(line.codCollected).toTakaString()}`;
      }
      await c.query(
        `INSERT INTO settlement_lines
           (settlement_id, raw_order_ref, order_id, cod_collected,
            courier_charge, match_status)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          settlementId,
          line.orderRef ?? line.consignmentId,
          order ? Number(order.id) : null,
          Money.fromTaka(line.codCollected).toTakaString(),
          Money.fromTaka(line.courierCharge).toTakaString(),
          problem === null
            ? "UNMATCHED" // promoted to MATCHED only when the batch posts
            : problem.startsWith("AMOUNT_MISMATCH")
              ? "AMOUNT_MISMATCH"
              : "UNKNOWN_ORDER",
        ],
      );
      if (problem === null && order) {
        matched.push({ orderId: Number(order.id), line });
      } else {
        exceptions.push({ consignmentId: line.consignmentId, problem: problem! });
      }
    }

    if (exceptions.length > 0) {
      await raiseAlert(c, "SETTLE_MISMATCH", {
        settlementId, invoiceRef: invoice.invoiceRef, exceptions,
      });
      if (ingest.eventId !== null) {
        await markSteadfastEvent(c, ingest.eventId, "PROCESSED");
      }
      return { outcome: "EXCEPTIONS", settlementId, exceptions };
    }

    // Clean invoice → JE-C1 and the stage transition, atomically.
    const batchEntry = await postEntry(c, {
      entryDate: invoice.statementDate,
      memo: `Steadfast payout batch ${invoice.invoiceRef}`,
      sourceType: "SETTLEMENT",
      sourceId: settlementId,
      eventCode: "COURIER_BATCHED",
      lines: [
        { accountCode: "1115", debit: gross },
        { accountCode: "1110", credit: gross },
      ],
    });
    for (const m of matched) {
      await c.query(
        `UPDATE sales_orders SET fin_state='PAYMENT_PENDING',
           steadfast_invoice_ref=$2, updated_at=now()
         WHERE id=$1`,
        [m.orderId, invoice.invoiceRef],
      );
    }
    await c.query(
      "UPDATE settlement_lines SET match_status='MATCHED' WHERE settlement_id=$1",
      [settlementId],
    );
    await c.query(
      "UPDATE courier_settlements SET status='BATCHED', batch_entry_id=$2 WHERE id=$1",
      [settlementId, batchEntry.entryId],
    );
    if (ingest.eventId !== null) {
      await markSteadfastEvent(c, ingest.eventId, "PROCESSED");
    }
    return {
      outcome: "BATCHED", settlementId, batchEntry,
      grossCod: gross, courierCharges: charges, netPaid: net, exceptions: [],
    };
  });
}

export interface ConfirmDisbursementInput {
  invoiceRef: string;
  /** The net amount actually observed on the bank/bKash statement. */
  confirmedNetPaid: string;
  confirmedBy?: number | null;
}

export interface ConfirmDisbursementResult {
  outcome: "SETTLED" | "ALREADY_SETTLED" | "REFUSED";
  settlementId?: number;
  settlementEntry?: PostedEntry;
  reason?: string;
}

/**
 * Stage 2 → 3 (§6.2 step 3): the payout landed. The caller confirms the
 * REAL bank/bKash credit; if it differs from the invoice's net by even a
 * poisha the posting is refused and an alert is raised. On success:
 * JE-C2 (Dr bank/bKash net + Dr 6010 fees / Cr 1115 gross) — the courier
 * delivery fee is auto-logged into daily operational expenses — and every
 * order in the batch becomes SETTLED.
 */
export async function confirmPayoutDisbursed(
  pool: Pool,
  tenantId: number,
  input: ConfirmDisbursementInput,
): Promise<ConfirmDisbursementResult> {
  return withTransaction(pool, tenantId, async (c) => {
    const res = await c.query<{
      id: string;
      status: string;
      gross_cod: string;
      courier_charges: string;
      net_paid: string;
      bank_code: string;
      statement_date: string;
    }>(
      `SELECT s.id, s.status, s.gross_cod::text, s.courier_charges::text,
              s.net_paid::text, a.code AS bank_code, s.statement_date::text
       FROM courier_settlements s JOIN accounts a ON a.id = s.bank_account_id
       WHERE s.courier='STEADFAST' AND s.statement_ref=$1 FOR UPDATE OF s`,
      [input.invoiceRef],
    );
    const s = res.rows[0];
    if (!s) return { outcome: "REFUSED", reason: "unknown invoice" };
    const settlementId = Number(s.id);
    if (s.status === "POSTED") return { outcome: "ALREADY_SETTLED", settlementId };
    if (s.status !== "BATCHED") {
      return {
        outcome: "REFUSED", settlementId,
        reason: `settlement is ${s.status}; resolve exceptions before disbursement`,
      };
    }
    const confirmed = Money.fromTaka(input.confirmedNetPaid);
    const expected = Money.fromTaka(s.net_paid);
    if (!confirmed.equals(expected)) {
      await raiseAlert(c, "SETTLE_CONFIRM", {
        settlementId, invoiceRef: input.invoiceRef,
        expectedNet: expected.toTakaString(), confirmedNet: confirmed.toTakaString(),
      });
      return {
        outcome: "REFUSED", settlementId,
        reason: `bank credit ${confirmed.toTakaString()} != invoice net ${expected.toTakaString()}`,
      };
    }

    const gross = Money.fromTaka(s.gross_cod);
    const charges = Money.fromTaka(s.courier_charges);
    const settlementEntry = await postEntry(c, {
      entryDate: new Date().toISOString().slice(0, 10),
      memo: `Steadfast payout disbursed ${input.invoiceRef}`,
      sourceType: "SETTLEMENT",
      sourceId: settlementId,
      eventCode: "COURIER_SETTLEMENT",
      postedBy: input.confirmedBy ?? null,
      lines: [
        { accountCode: s.bank_code, debit: expected },
        ...(charges.isZero() ? [] : [{ accountCode: "6010", debit: charges }]),
        { accountCode: "1115", credit: gross },
      ],
    });
    await c.query(
      `UPDATE sales_orders SET fin_state='SETTLED', settled_at=now(), updated_at=now()
       WHERE id IN (SELECT order_id FROM settlement_lines
                    WHERE settlement_id=$1 AND order_id IS NOT NULL)`,
      [settlementId],
    );
    await c.query(
      "UPDATE courier_settlements SET status='POSTED', posted_entry_id=$2 WHERE id=$1",
      [settlementId, settlementEntry.entryId],
    );
    await ingestSteadfastEvent(c, {
      channel: "CRON",
      eventKind: "PAYOUT_DISBURSED",
      invoiceRef: input.invoiceRef,
      payload: { invoiceRef: input.invoiceRef, netPaid: expected.toTakaString() },
    });
    return { outcome: "SETTLED", settlementId, settlementEntry };
  });
}

/**
 * Invariant I2 (blueprint §10): the two courier-fund accounts must equal
 * the COD sums of the orders sitting in the corresponding stages.
 */
export async function checkCourierFunds(c: PoolClient): Promise<{
  ok: boolean;
  ledger1110: Money;
  expected1110: Money;
  ledger1115: Money;
  expected1115: Money;
}> {
  const balances = await c.query<{ code: string; balance: string }>(
    "SELECT code, balance::text FROM account_balances WHERE code IN ('1110','1115')",
  );
  const byCode = new Map(balances.rows.map((r) => [r.code, Money.fromTaka(r.balance)]));
  const sums = await c.query<{ stage1: string; stage2: string }>(
    `SELECT
       COALESCE(SUM(cod_amount) FILTER (WHERE fin_state IN ('REVENUE_POSTED','NEEDS_BOM')
                                          AND payment_mode='COD'), 0)::NUMERIC(14,2)::text AS stage1,
       COALESCE(SUM(cod_amount) FILTER (WHERE fin_state='PAYMENT_PENDING'
                                          AND payment_mode='COD'), 0)::NUMERIC(14,2)::text AS stage2
     FROM sales_orders`,
  );
  const ledger1110 = byCode.get("1110") ?? Money.ZERO;
  const ledger1115 = byCode.get("1115") ?? Money.ZERO;
  const expected1110 = Money.fromTaka(sums.rows[0]!.stage1);
  const expected1115 = Money.fromTaka(sums.rows[0]!.stage2);
  return {
    ok: ledger1110.equals(expected1110) && ledger1115.equals(expected1115),
    ledger1110, expected1110, ledger1115, expected1115,
  };
}

function sumMoney(values: string[]): Money {
  return values.reduce((acc, v) => acc.add(Money.fromTaka(v)), Money.ZERO);
}
