/**
 * B9 acceptance gate: the cash strip matches the trial balance to the
 * poisha against the REAL ledger, P&L aggregates equal the posted
 * entries exactly, the funds board mirrors invariant I2, and postEntry
 * emits the pg_notify signal the live dashboard listens for.
 */
import { Money } from "@pfm/domain";
import { applyPurchase, createBom, createItem } from "@pfm/inventory";
import { accountBalance, trialBalance, withTransaction } from "@pfm/ledger";
import {
  confirmPayoutDisbursed,
  ingestNuportEvent,
  processNuportEvent,
  recordPayoutInvoice,
} from "@pfm/pipeline";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDailySeries, getDashboard } from "./dashboard";
import { getFundsBoard, getTrialBalanceReport } from "./funds";

const CONN =
  process.env.DATABASE_URL ??
  "postgres://erp:erp_local_dev@localhost:5432/pure_foodmart_erp";
const pool = new pg.Pool({ connectionString: CONN, max: 10 });

let T1 = 0;
const TODAY = new Date().toISOString().slice(0, 10);
const NOW_ISO = new Date().toISOString();

async function ensureTenant(): Promise<number> {
  const found = await pool.query<{ id: number }>(
    "SELECT id FROM tenants WHERE slug='pure-foodmart'",
  );
  if (found.rows[0]) return found.rows[0].id;
  return (
    await pool.query<{ id: number }>(
      "SELECT provision_tenant('Pure Foodmart','pure-foodmart') AS id",
    )
  ).rows[0]!.id;
}

async function resetAll(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query(
      `TRUNCATE steadfast_events, settlement_lines, courier_settlements,
               nuport_events, sync_runs, sales_order_lines, sales_orders,
               inventory_movements, item_stock, bom_lines, boms, items,
               purchase_lines, purchases, expenses, integrity_alerts,
               journal_lines, journal_entries
       RESTART IDENTITY CASCADE`,
    );
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [String(T1)]);
    await c.query("UPDATE ledger_sequence SET last_entry_no=0, last_hash=repeat('0',64)");
    await c.query("UPDATE fiscal_periods SET is_locked=FALSE");
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}

/** Two delivered COD orders today + one cash expense today (real pipelines). */
async function seedActivity(): Promise<void> {
  await withTransaction(pool, T1, async (c) => {
    const raw = await createItem(c, {
      sku: "RAW-JAG", name: "Raw Jaggery", kind: "RAW", uom: "KG",
      inventoryAccountCode: "1310", cogsAccountCode: "5010",
    });
    const ctn = await createItem(c, {
      sku: "CTN-5KG", name: "Carton 5KG", kind: "PACKAGING", uom: "PCS",
      inventoryAccountCode: "1320", cogsAccountCode: "5020",
    });
    await createItem(c, { sku: "JAG-5KG", name: "5KG Pack", kind: "FINISHED", uom: "PCS" });
    await createBom(c, {
      finishedSku: "JAG-5KG", validFrom: "2026-01-01",
      components: [
        { sku: "RAW-JAG", qtyPerUnit: "5" },
        { sku: "CTN-5KG", qtyPerUnit: "1" },
      ],
    });
    await applyPurchase(c, {
      purchaseId: 1, purchasedOn: "2026-07-01", creditAccountCode: "2010",
      memo: "stock", lines: [
        { itemId: raw.id, qty: "200", unitCost: "118" },
        { itemId: ctn.id, qty: "500", unitCost: "22" },
      ],
    });
  });
  for (const [ref, cid] of [["NP-A", "SF-A"], ["NP-B", "SF-B"]] as const) {
    const { eventId } = await withTransaction(pool, T1, (c) =>
      ingestNuportEvent(c, {
        channel: "WEBHOOK",
        externalEventId: `evt-${ref}`,
        orderRef: ref,
        payload: {
          orderRef: ref, consignmentId: cid, status: "delivered",
          paymentMode: "COD", productAmount: "1050", deliveryCharge: "100",
          codAmount: "1150", deliveredAt: NOW_ISO,
          lines: [{ sku: "JAG-5KG", qty: "1", unitPrice: "1050", lineTotal: "1050" }],
        },
      }),
    );
    await processNuportEvent(pool, T1, eventId!);
  }
  await withTransaction(pool, T1, async (c) => {
    const acct = await c.query("SELECT id FROM accounts WHERE code='6120'");
    const cash = await c.query("SELECT id FROM accounts WHERE code='1010'");
    const exp = await c.query<{ id: string }>(
      `INSERT INTO expenses (expense_date, expense_account_id, paid_from_account_id, amount, description)
       VALUES ($1,$2,$3,1800,'electricity') RETURNING id`,
      [TODAY, acct.rows[0].id, cash.rows[0].id],
    );
    const { postEntry } = await import("@pfm/ledger");
    await postEntry(c, {
      entryDate: TODAY, memo: "Electricity", sourceType: "EXPENSE",
      sourceId: Number(exp.rows[0]!.id), eventCode: "OPEX",
      lines: [
        { accountCode: "6120", debit: Money.fromTaka("1800") },
        { accountCode: "1010", credit: Money.fromTaka("1800") },
      ],
    });
  });
}

beforeAll(async () => {
  T1 = await ensureTenant();
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetAll();
  await seedActivity();
});

describe("dashboard (S1)", () => {
  it("cash strip matches the ledger to the poisha, and the trial balance holds", async () => {
    const view = await withTransaction(pool, T1, async (c) => ({
      dash: await getDashboard(c),
      b1010: await accountBalance(c, "1010"),
      b1020: await accountBalance(c, "1020"),
      b1030: await accountBalance(c, "1030"),
      b1110: await accountBalance(c, "1110"),
      b1115: await accountBalance(c, "1115"),
      tb: await trialBalance(c),
    }));
    // The acceptance criterion: strip == ledger balances, exactly.
    expect(view.dash.cash.cashInHand).toBe(view.b1010.toTakaString());
    expect(view.dash.cash.bank).toBe(view.b1020.toTakaString());
    expect(view.dash.cash.bkash).toBe(view.b1030.toTakaString());
    expect(view.dash.cash.courierWaiting).toBe(view.b1110.toTakaString());
    expect(view.dash.cash.courierPending).toBe(view.b1115.toTakaString());
    const sum = [
      view.b1010, view.b1020, view.b1030,
      await withTransaction(pool, T1, (c) => accountBalance(c, "1040")),
      view.b1110, view.b1115,
    ].reduce((a, m) => a.add(m), Money.ZERO);
    expect(view.dash.cash.totalLiquid).toBe(sum.toTakaString());
    expect(view.tb.balanced).toBe(true);
    // Known values: −1800 cash, 2300 in courier funds.
    expect(view.dash.cash.cashInHand).toBe("-1800.00");
    expect(view.dash.cash.courierWaiting).toBe("2300.00");
  });

  it("today's P&L equals the posted entries exactly", async () => {
    const dash = await withTransaction(pool, T1, (c) => getDashboard(c));
    expect(dash.today.revenue).toBe("2300.00"); // 2×(1050+100)
    expect(dash.today.cogs).toBe("1224.00"); // 2×612
    expect(dash.today.opex).toBe("1800.00");
    expect(dash.today.netProfit).toBe("-724.00");
    expect(dash.today.ordersDelivered).toBe(2);
    expect(dash.thisWeek.revenue).toBe("2300.00"); // only today's activity in window
    expect(dash.openExceptions).toBe(0);
  });

  it("daily series covers the window and sums to the aggregate", async () => {
    const series = await withTransaction(pool, T1, (c) => getDailySeries(c, 14));
    expect(series).toHaveLength(14);
    expect(series[13]!.date).toBe(TODAY);
    expect(series[13]!.revenue).toBe("2300.00");
    expect(series[13]!.net).toBe("-724.00");
    const summed = series.reduce(
      (a, d) => a.add(Money.fromTaka(d.revenue)),
      Money.ZERO,
    );
    expect(summed.toTakaString()).toBe("2300.00");
  });
});

describe("funds board (S4)", () => {
  it("mirrors invariant I2 through the whole payout cycle", async () => {
    let board = await withTransaction(pool, T1, (c) => getFundsBoard(c));
    expect(board.waiting).toHaveLength(2);
    expect(board.ledger.waiting1110).toBe("2300.00");
    expect(board.ledger.matchesOrders).toBe(true);
    expect(board.aging[0]!.amount).toBe("2300.00"); // both fresh, 0–7 bucket

    await recordPayoutInvoice(pool, T1, {
      invoiceRef: "INV-1", statementDate: TODAY, payoutAccountCode: "1020",
      lines: [
        { consignmentId: "SF-A", codCollected: "1150", courierCharge: "30" },
        { consignmentId: "SF-B", codCollected: "1150", courierCharge: "30" },
      ],
    });
    board = await withTransaction(pool, T1, (c) => getFundsBoard(c));
    expect(board.waiting).toHaveLength(0);
    expect(board.pending).toEqual([
      { invoiceRef: "INV-1", statementDate: TODAY, orders: 2, gross: "2300.00" },
    ]);
    expect(board.ledger.pending1115).toBe("2300.00");
    expect(board.ledger.matchesOrders).toBe(true);

    await confirmPayoutDisbursed(pool, T1, {
      invoiceRef: "INV-1", confirmedNetPaid: "2240",
    });
    board = await withTransaction(pool, T1, (c) => getFundsBoard(c));
    expect(board.pending).toHaveLength(0);
    expect(board.settledThisMonth).toBe("2300.00");
    expect(board.ledger.waiting1110).toBe("0.00");
    expect(board.ledger.pending1115).toBe("0.00");
  });

  it("trial-balance report is balanced with per-account rows", async () => {
    const report = await withTransaction(pool, T1, (c) => getTrialBalanceReport(c));
    expect(report.balanced).toBe(true);
    expect(Money.fromTaka(report.totalDebit).toTakaString()).toBe(report.totalCredit);
    const codes = report.rows.map((r) => r.code);
    for (const code of ["1010", "1110", "1310", "1320", "2010", "4010", "5010", "6120"]) {
      expect(codes).toContain(code);
    }
  });
});

describe("live signal (Postgres NOTIFY → SSE)", () => {
  it("postEntry emits pfm_ledger with the tenant and entry number on commit", async () => {
    const listener = new pg.Client({ connectionString: CONN });
    await listener.connect();
    await listener.query("LISTEN pfm_ledger");
    const received = new Promise<{ tenantId: number; entryNo: number }>((resolve) => {
      listener.on("notification", (msg) => {
        if (msg.payload) resolve(JSON.parse(msg.payload));
      });
    });

    const { postEntry } = await import("@pfm/ledger");
    const posted = await withTransaction(pool, T1, (c) =>
      postEntry(c, {
        entryDate: TODAY, memo: "notify probe", sourceType: "MANUAL_JOURNAL",
        eventCode: "OPEX",
        lines: [
          { accountCode: "6140", debit: Money.fromTaka("1") },
          { accountCode: "1010", credit: Money.fromTaka("1") },
        ],
      }),
    );
    const note = await Promise.race([
      received,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no NOTIFY within 2s")), 2000)),
    ]);
    expect(note.tenantId).toBe(T1);
    expect(note.entryNo).toBe(posted.entryNo);
    await listener.end();
  });
});
