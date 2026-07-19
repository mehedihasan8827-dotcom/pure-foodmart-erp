/**
 * B5 acceptance gate (blueprint §18.3): a simulated payout cycle
 * delivered → invoiced → paid auto-posts JE-C1/JE-C2; the drift alert
 * fires on mismatch; CSV fallback produces identical postings; and the
 * Steadfast status poller can trigger delivery before Nuport does.
 */
import { Money } from "@pfm/domain";
import { applyPurchase, createBom, createItem } from "@pfm/inventory";
import { accountBalance, trialBalance, verifyHashChain, withTransaction } from "@pfm/ledger";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openCredentials, sealCredentials, CredentialsError } from "../credentials";
import { ingestNuportEvent } from "../nuport/ingest";
import { processNuportEvent } from "../nuport/process";
import { checkSteadfastBalanceDrift } from "./balance";
import { parseSteadfastStatementCsv } from "./csv";
import { runSteadfastPoll } from "./poll";
import {
  checkCourierFunds,
  confirmPayoutDisbursed,
  recordPayoutInvoice,
} from "./settlement";
import { processSteadfastStatus } from "./status";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://erp:erp_local_dev@localhost:5432/pure_foodmart_erp",
  max: 10,
});

let T1 = 0;

async function ensureTenant(name: string, slug: string): Promise<number> {
  const found = await pool.query<{ id: number }>(
    "SELECT id FROM tenants WHERE slug = $1", [slug],
  );
  if (found.rows[0]) return found.rows[0].id;
  const created = await pool.query<{ id: number }>(
    "SELECT provision_tenant($1, $2) AS id", [name, slug],
  );
  return created.rows[0]!.id;
}

async function resetAll(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `TRUNCATE steadfast_events, settlement_lines, courier_settlements,
               nuport_events, sync_runs, sales_order_lines, sales_orders,
               inventory_movements, item_stock, bom_lines, boms, items,
               purchases, purchase_lines, integrity_alerts,
               journal_lines, journal_entries
       RESTART IDENTITY CASCADE`,
    );
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [String(T1)]);
    await client.query(
      "UPDATE ledger_sequence SET last_entry_no = 0, last_hash = repeat('0', 64)",
    );
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}

async function seedCatalog(c: PoolClient): Promise<void> {
  const rawJag = await createItem(c, {
    sku: "RAW-JAG", name: "Raw Jaggery", kind: "RAW", uom: "KG",
    inventoryAccountCode: "1310", cogsAccountCode: "5010",
  });
  const ctn5 = await createItem(c, {
    sku: "CTN-5KG", name: "Carton 5KG", kind: "PACKAGING", uom: "PCS",
    inventoryAccountCode: "1320", cogsAccountCode: "5020",
  });
  await createItem(c, {
    sku: "JAG-5KG", name: "5KG Jaggery Pack", kind: "FINISHED", uom: "PCS",
  });
  await createBom(c, {
    finishedSku: "JAG-5KG", validFrom: "2026-01-01",
    components: [
      { sku: "RAW-JAG", qtyPerUnit: "5" },
      { sku: "CTN-5KG", qtyPerUnit: "1" },
    ],
  });
  // Purchases on supplier credit → cash accounts start at zero for clean asserts.
  await applyPurchase(c, {
    purchaseId: 1, purchasedOn: "2026-07-01", creditAccountCode: "2010",
    memo: "opening stock",
    lines: [
      { itemId: rawJag.id, qty: "200", unitCost: "118" },
      { itemId: ctn5.id, qty: "500", unitCost: "22" },
    ],
  });
}

function codOrder(ref: string, cid: string, status = "delivered") {
  return {
    eventId: `evt-${ref}-${status}`,
    orderRef: ref,
    consignmentId: cid,
    status,
    paymentMode: "COD",
    productAmount: "1050",
    deliveryCharge: "100",
    codAmount: "1150",
    deliveredAt: "2026-07-18T14:30:00+06:00",
    lines: [{ sku: "JAG-5KG", qty: "1", unitPrice: "1050", lineTotal: "1050" }],
  };
}

async function deliverViaNuport(payload: Record<string, unknown>): Promise<void> {
  const { eventId } = await withTransaction(pool, T1, (c) =>
    ingestNuportEvent(c, {
      channel: "WEBHOOK",
      externalEventId: payload.eventId as string,
      orderRef: payload.orderRef as string,
      payload,
    }),
  );
  await processNuportEvent(pool, T1, eventId!);
}

const INVOICE = {
  invoiceRef: "INV-88231",
  statementDate: "2026-07-20",
  payoutAccountCode: "1020" as const,
  lines: [
    { consignmentId: "SF-A", codCollected: "1150", courierCharge: "30" },
    { consignmentId: "SF-B", codCollected: "1150", courierCharge: "30" },
  ],
};

beforeAll(async () => {
  T1 = await ensureTenant("Pure Foodmart", "pure-foodmart");
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetAll();
  await withTransaction(pool, T1, seedCatalog);
  // Three delivered COD orders: A and B will be paid out, C stays in stage 1.
  await deliverViaNuport(codOrder("NP-A", "SF-A"));
  await deliverViaNuport(codOrder("NP-B", "SF-B"));
  await deliverViaNuport(codOrder("NP-C", "SF-C"));
});

describe("three-stage fund lifecycle (1110 → 1115 → bank)", () => {
  it("runs the full payout cycle with exact JE-C1/JE-C2 postings", async () => {
    // Stage 1: all three delivered orders sit in Unsettled Courier Funds.
    let funds = await withTransaction(pool, T1, checkCourierFunds);
    expect(funds.ok).toBe(true);
    expect(funds.ledger1110.toTakaString()).toBe("3450.00");
    expect(funds.ledger1115.toTakaString()).toBe("0.00");

    // Stage 2: payout invoice for A+B → JE-C1.
    const batch = await recordPayoutInvoice(pool, T1, INVOICE);
    expect(batch.outcome).toBe("BATCHED");
    expect(batch.grossCod!.toTakaString()).toBe("2300.00");
    expect(batch.netPaid!.toTakaString()).toBe("2240.00");

    funds = await withTransaction(pool, T1, checkCourierFunds);
    expect(funds.ok).toBe(true);
    expect(funds.ledger1110.toTakaString()).toBe("1150.00"); // only NP-C
    expect(funds.ledger1115.toTakaString()).toBe("2300.00");

    const midStates = await withTransaction(pool, T1, (c) =>
      c.query("SELECT nuport_order_ref, fin_state, steadfast_invoice_ref FROM sales_orders ORDER BY nuport_order_ref"),
    );
    expect(midStates.rows.map((r) => [r.nuport_order_ref, r.fin_state])).toEqual([
      ["NP-A", "PAYMENT_PENDING"],
      ["NP-B", "PAYMENT_PENDING"],
      ["NP-C", "REVENUE_POSTED"],
    ]);
    expect(midStates.rows[0].steadfast_invoice_ref).toBe("INV-88231");

    // Stage 3: disbursement confirmed against the real bank credit → JE-C2.
    const settled = await confirmPayoutDisbursed(pool, T1, {
      invoiceRef: "INV-88231",
      confirmedNetPaid: "2240",
    });
    expect(settled.outcome).toBe("SETTLED");

    const view = await withTransaction(pool, T1, async (c) => ({
      bank: await accountBalance(c, "1020"),
      courierCharges: await accountBalance(c, "6010"),
      funds: await checkCourierFunds(c),
      tb: await trialBalance(c),
      chain: await verifyHashChain(c),
      states: (await c.query(
        "SELECT nuport_order_ref, fin_state, settled_at FROM sales_orders ORDER BY nuport_order_ref",
      )).rows,
    }));
    expect(view.bank.toTakaString()).toBe("2240.00");
    expect(view.courierCharges.toTakaString()).toBe("60.00"); // fees auto-expensed
    expect(view.funds.ok).toBe(true);
    expect(view.funds.ledger1110.toTakaString()).toBe("1150.00");
    expect(view.funds.ledger1115.toTakaString()).toBe("0.00");
    expect(view.tb.balanced).toBe(true);
    expect(view.chain.ok).toBe(true);
    expect(view.states.map((r: { fin_state: string }) => r.fin_state)).toEqual([
      "SETTLED", "SETTLED", "REVENUE_POSTED",
    ]);
    expect(view.states[0].settled_at).not.toBeNull();
  });

  it("is idempotent: re-recording and re-confirming are no-ops", async () => {
    await recordPayoutInvoice(pool, T1, INVOICE);
    const again = await recordPayoutInvoice(pool, T1, INVOICE);
    expect(again.outcome).toBe("ALREADY_RECORDED");

    await confirmPayoutDisbursed(pool, T1, {
      invoiceRef: "INV-88231", confirmedNetPaid: "2240",
    });
    const confirmAgain = await confirmPayoutDisbursed(pool, T1, {
      invoiceRef: "INV-88231", confirmedNetPaid: "2240",
    });
    expect(confirmAgain.outcome).toBe("ALREADY_SETTLED");

    const entries = await withTransaction(pool, T1, (c) =>
      c.query("SELECT count(*)::int AS n FROM journal_entries WHERE source_type='SETTLEMENT'"),
    );
    expect(entries.rows[0].n).toBe(2); // exactly one JE-C1 + one JE-C2
  });
});

describe("the system refuses unexplained settlements", () => {
  it("amount mismatch → DRAFT, zero postings, SETTLE_MISMATCH alert", async () => {
    const bad = {
      ...INVOICE, invoiceRef: "INV-BAD",
      lines: [
        { consignmentId: "SF-A", codCollected: "1150", courierCharge: "30" },
        { consignmentId: "SF-B", codCollected: "1100", courierCharge: "30" }, // short ৳50
      ],
    };
    const result = await recordPayoutInvoice(pool, T1, bad);
    expect(result.outcome).toBe("EXCEPTIONS");
    expect(result.exceptions[0]!.problem).toMatch(/AMOUNT_MISMATCH/);

    const view = await withTransaction(pool, T1, async (c) => ({
      funds: await checkCourierFunds(c),
      settlement: (await c.query("SELECT status FROM courier_settlements WHERE statement_ref='INV-BAD'")).rows[0],
      alert: (await c.query("SELECT count(*)::int AS n FROM integrity_alerts WHERE invariant_code='SETTLE_MISMATCH'")).rows[0],
      je: (await c.query("SELECT count(*)::int AS n FROM journal_entries WHERE source_type='SETTLEMENT'")).rows[0],
    }));
    expect(view.funds.ledger1115.toTakaString()).toBe("0.00"); // nothing moved
    expect(view.settlement.status).toBe("DRAFT");
    expect(view.alert.n).toBe(1);
    expect(view.je.n).toBe(0);
  });

  it("unknown consignment → exception; wrong bank confirmation → refused", async () => {
    const unknown = {
      ...INVOICE, invoiceRef: "INV-UNK",
      lines: [{ consignmentId: "SF-GHOST", codCollected: "999", courierCharge: "10" }],
    };
    const rec = await recordPayoutInvoice(pool, T1, unknown);
    expect(rec.outcome).toBe("EXCEPTIONS");
    expect(rec.exceptions[0]!.problem).toBe("UNKNOWN_ORDER");

    await recordPayoutInvoice(pool, T1, INVOICE);
    const refused = await confirmPayoutDisbursed(pool, T1, {
      invoiceRef: "INV-88231",
      confirmedNetPaid: "2200", // bank shows ৳40 less than invoice net
    });
    expect(refused.outcome).toBe("REFUSED");
    expect(refused.reason).toMatch(/2200.00 != invoice net 2240.00/);
    const alert = await withTransaction(pool, T1, (c) =>
      c.query("SELECT count(*)::int AS n FROM integrity_alerts WHERE invariant_code='SETTLE_CONFIRM'"),
    );
    expect(alert.rows[0].n).toBe(1);
  });
});

describe("CSV fallback (§6.3)", () => {
  it("parses a statement export and posts identically to the API path", async () => {
    const csv = [
      "Consignment ID,Order ID,COD Amount,Delivery Charge,COD Charge",
      'SF-A,NP-A,"1,150.00",18.50,11.50',
      'SF-B,NP-B,"1,150.00",18.50,11.50',
    ].join("\r\n");
    const invoice = parseSteadfastStatementCsv(csv, {
      invoiceRef: "INV-CSV-1", statementDate: "2026-07-20",
    });
    expect(invoice.lines).toHaveLength(2);
    expect(invoice.lines[0]!.codCollected).toBe("1150.00");
    expect(invoice.lines[0]!.courierCharge).toBe("30.00"); // 18.50 + 11.50 summed

    const result = await recordPayoutInvoice(pool, T1, invoice, "CSV");
    expect(result.outcome).toBe("BATCHED");
    expect(result.grossCod!.toTakaString()).toBe("2300.00");
    const funds = await withTransaction(pool, T1, checkCourierFunds);
    expect(funds.ok).toBe(true);
    expect(funds.ledger1115.toTakaString()).toBe("2300.00");
  });
});

describe("balance drift cross-check (§14.12)", () => {
  it("passes when Steadfast agrees, alerts when it drifts", async () => {
    const ok = await checkSteadfastBalanceDrift(pool, T1, "3450");
    expect(ok.ok).toBe(true);
    expect(ok.drift.toTakaString()).toBe("0.00");

    const drifted = await checkSteadfastBalanceDrift(pool, T1, "5000");
    expect(drifted.ok).toBe(false);
    expect(drifted.drift.toTakaString()).toBe("1550.00");
    const alert = await withTransaction(pool, T1, (c) =>
      c.query("SELECT details FROM integrity_alerts WHERE invariant_code='SF_BALANCE'"),
    );
    expect(alert.rows).toHaveLength(1);
    expect(alert.rows[0].details.drift).toBe("1550.00");
  });
});

describe("Steadfast-first delivery (§2.4 authority)", () => {
  it("poller posts revenue+COGS for a SYNCED order before Nuport confirms", async () => {
    // NP-D only *synced* via Nuport (pending) — no revenue yet.
    await deliverViaNuport(codOrder("NP-D", "SF-D", "pending"));
    const before = await withTransaction(pool, T1, (c) => accountBalance(c, "1110"));
    expect(before.toTakaString()).toBe("3450.00");

    const result = await processSteadfastStatus(pool, T1, {
      consignmentId: "SF-D",
      status: "DELIVERED",
      rawStatus: "delivered_approval_pending",
      checkedAt: "2026-07-19T10:00:00+06:00",
    });
    expect(result.outcome).toBe("POSTED");

    const after = await withTransaction(pool, T1, async (c) => ({
      courier: await accountBalance(c, "1110"),
      order: (await c.query("SELECT fin_state, cogs_amount::text FROM sales_orders WHERE nuport_order_ref='NP-D'")).rows[0],
    }));
    expect(after.courier.toTakaString()).toBe("4600.00");
    expect(after.order.fin_state).toBe("REVENUE_POSTED");
    expect(after.order.cogs_amount).toBe("612.00");

    // Nuport's later `delivered` webhook is a clean no-op.
    const { eventId } = await withTransaction(pool, T1, (c) =>
      ingestNuportEvent(c, {
        channel: "WEBHOOK",
        externalEventId: "evt-NP-D-late",
        orderRef: "NP-D",
        payload: codOrder("NP-D", "SF-D", "delivered"),
      }),
    );
    const late = await processNuportEvent(pool, T1, eventId!);
    expect(late.outcome).toBe("DUPLICATE");
  });

  it("conflicting signals freeze with SF_CONFLICT instead of guessing", async () => {
    // NP-A is REVENUE_POSTED; courier now claims it was cancelled.
    const result = await processSteadfastStatus(pool, T1, {
      consignmentId: "SF-A",
      status: "CANCELLED",
      rawStatus: "cancelled_approval_pending",
      checkedAt: "2026-07-19T11:00:00+06:00",
    });
    expect(result.outcome).toBe("CONFLICT");
    const view = await withTransaction(pool, T1, async (c) => ({
      alert: (await c.query("SELECT count(*)::int AS n FROM integrity_alerts WHERE invariant_code='SF_CONFLICT'")).rows[0],
      order: (await c.query("SELECT fin_state FROM sales_orders WHERE nuport_order_ref='NP-A'")).rows[0],
    }));
    expect(view.alert.n).toBe(1);
    expect(view.order.fin_state).toBe("REVENUE_POSTED"); // money untouched
  });

  it("full poll sweep: statuses + invoices + balance in one idempotent pass", async () => {
    await deliverViaNuport(codOrder("NP-E", "SF-E", "pending"));
    const source = {
      getStatus: async (cid: string) => ({
        consignmentId: cid,
        status: (cid === "SF-E" ? "DELIVERED" : "IN_TRANSIT") as never,
        rawStatus: cid === "SF-E" ? "delivered" : "pending",
        checkedAt: "2026-07-19T12:00:00+06:00",
      }),
      getBalance: async () => ({ currentBalance: "4600" }),
      getPayoutInvoices: async () => [INVOICE],
    };
    const summary = await runSteadfastPoll(pool, T1, source);
    expect(summary.consignmentsChecked).toBe(4); // A,B,C,E open
    expect(summary.invoiceOutcomes[0]!.outcome).toBe("BATCHED");
    expect(summary.balance.ok).toBe(true); // 1110(2300→ A,B batched... C+E) + 1115

    // Second sweep: every sub-step deduped, nothing double-posts.
    const again = await runSteadfastPoll(pool, T1, source);
    expect(again.statusOutcomes.every((o) => o.outcome === "DUPLICATE")).toBe(true);
    expect(again.invoiceOutcomes[0]!.outcome).toBe("ALREADY_RECORDED");
    const je = await withTransaction(pool, T1, (c) =>
      c.query("SELECT count(*)::int AS n FROM journal_entries WHERE source_type='SETTLEMENT'"),
    );
    expect(je.rows[0].n).toBe(1);
  });
});

describe("credential sealing (§19.3)", () => {
  const MASTER = "a".repeat(64);

  it("round-trips and detects tampering", () => {
    const sealed = sealCredentials(MASTER, {
      apiKey: "sf-key", secretKey: "sf-secret",
    });
    expect(openCredentials(MASTER, sealed)).toEqual({
      apiKey: "sf-key", secretKey: "sf-secret",
    });

    const tampered = Buffer.from(sealed, "base64");
    tampered[tampered.length - 1]! ^= 0xff;
    expect(() =>
      openCredentials(MASTER, tampered.toString("base64")),
    ).toThrow(CredentialsError);
    expect(() => openCredentials("b".repeat(64), sealed)).toThrow(CredentialsError);
    expect(() => sealCredentials("short", {})).toThrow(/64 hex chars/);
  });
});
