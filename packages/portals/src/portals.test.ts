/**
 * B6 acceptance gate: every §4 manual event enterable through the portal
 * services with exact postings, idempotent depreciation, auto gain/loss
 * disposal, stock-count variances, and a month-end close dry run that
 * locks the period at the database level.
 */
import { Money } from "@pfm/domain";
import { createItem } from "@pfm/inventory";
import { accountBalance, trialBalance, withTransaction } from "@pfm/ledger";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closePeriod,
  createPartner,
  createSupplier,
  disposeAsset,
  PortalError,
  recordCapitalInjection,
  recordCashDrawing,
  recordDrawingInKind,
  recordExpense,
  recordPurchase,
  recordStockCount,
  registerAsset,
  runCloseChecklist,
  runDepreciation,
  unlockPeriod,
} from "./index";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://erp:erp_local_dev@localhost:5432/pure_foodmart_erp",
  max: 10,
});

let T1 = 0;

async function ensureTenant(name: string, slug: string): Promise<number> {
  const found = await pool.query<{ id: number }>(
    "SELECT id FROM tenants WHERE slug=$1", [slug],
  );
  if (found.rows[0]) return found.rows[0].id;
  const created = await pool.query<{ id: number }>(
    "SELECT provision_tenant($1,$2) AS id", [name, slug],
  );
  return created.rows[0]!.id;
}

async function resetAll(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `TRUNCATE asset_disposals, depreciation_entries, fixed_assets,
               equity_transactions, partner_share_versions, partners,
               expenses, stock_count_lines, stock_counts,
               steadfast_events, settlement_lines, courier_settlements,
               nuport_events, sync_runs, sales_order_lines, sales_orders,
               inventory_movements, item_stock, bom_lines, boms, items,
               purchase_lines, purchases, suppliers, integrity_alerts,
               audit_log, journal_lines, journal_entries
       RESTART IDENTITY CASCADE`,
    );
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [String(T1)]);
    await client.query(
      "UPDATE ledger_sequence SET last_entry_no=0, last_hash=repeat('0',64)",
    );
    await client.query("UPDATE fiscal_periods SET is_locked=FALSE, locked_at=NULL, locked_by=NULL");
    await client.query("COMMIT");
  } finally {
    client.release();
  }
}

async function seedItems(c: PoolClient): Promise<void> {
  await createItem(c, {
    sku: "RAW-JAG", name: "Raw Jaggery", kind: "RAW", uom: "KG",
    inventoryAccountCode: "1310", cogsAccountCode: "5010",
  });
  await createItem(c, {
    sku: "CTN-5KG", name: "Carton 5KG", kind: "PACKAGING", uom: "PCS",
    inventoryAccountCode: "1320", cogsAccountCode: "5020",
  });
}

async function bal(code: string): Promise<string> {
  return (await withTransaction(pool, T1, (c) => accountBalance(c, code))).toTakaString();
}

beforeAll(async () => {
  T1 = await ensureTenant("Pure Foodmart", "pure-foodmart");
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetAll();
  await withTransaction(pool, T1, seedItems);
});

describe("expenses portal (§4.4)", () => {
  it("posts cash and accrual expenses; rejects invalid accounts", async () => {
    await recordExpense(pool, T1, {
      expenseDate: "2026-07-10", expenseAccountCode: "6020",
      paidFromAccountCode: "1030", amount: "2500",
      description: "Facebook boosting", receiptUrl: "s3://receipts/fb-1.jpg",
    });
    await recordExpense(pool, T1, {
      expenseDate: "2026-07-31", expenseAccountCode: "6110",
      paidFromAccountCode: "2210", amount: "4000",
      description: "Unpaid labor accrual",
    });
    expect(await bal("6020")).toBe("2500.00");
    expect(await bal("1030")).toBe("-2500.00");
    expect(await bal("6110")).toBe("4000.00");
    expect(await bal("2210")).toBe("4000.00");

    await expect(
      recordExpense(pool, T1, {
        expenseDate: "2026-07-10", expenseAccountCode: "1010",
        paidFromAccountCode: "1030", amount: "10", description: "bad",
      }),
    ).rejects.toThrow(/not an EXPENSE account/);
    await expect(
      recordExpense(pool, T1, {
        expenseDate: "2026-07-10", expenseAccountCode: "6020",
        paidFromAccountCode: "4010", amount: "10", description: "bad",
      }),
    ).rejects.toThrow(/not a cash location/);
  });
});

describe("purchases portal (§4.3)", () => {
  it("books purchases with rows, stock, and postings in lockstep", async () => {
    const { supplierId } = await createSupplier(pool, T1, { name: "Jaggery Depot" });
    const result = await recordPurchase(pool, T1, {
      purchasedOn: "2026-07-01", supplierId, invoiceRef: "JD-991",
      lines: [
        { sku: "RAW-JAG", qty: "200", unitCost: "118" },
        { sku: "CTN-5KG", qty: "500", unitCost: "22" },
      ],
    });
    expect(result.total.toTakaString()).toBe("34600.00");
    expect(result.entries).toHaveLength(2); // raw + packaging entries
    expect(await bal("1310")).toBe("23600.00");
    expect(await bal("1320")).toBe("11000.00");
    expect(await bal("2010")).toBe("34600.00"); // on credit by default

    await expect(
      recordPurchase(pool, T1, {
        purchasedOn: "2026-07-01",
        lines: [{ sku: "GHOST", qty: "1", unitCost: "1" }],
      }),
    ).rejects.toThrow(/Unknown SKU/);
  });
});

describe("partner equity portal (§4.5)", () => {
  it("capital in, cash drawing, and drawing-in-kind at BOM cost", async () => {
    const { partnerId } = await createPartner(pool, T1, {
      name: "Partner A", capitalAccountCode: "3010",
      drawingsAccountCode: "3110", sharePct: "60", validFrom: "2026-01-01",
    });
    await recordCapitalInjection(pool, T1, {
      partnerId, amount: "200000", txDate: "2026-07-01", cashAccountCode: "1020",
    });
    expect(await bal("1020")).toBe("200000.00");
    expect(await bal("3010")).toBe("200000.00");

    await recordCashDrawing(pool, T1, {
      partnerId, amount: "15000", txDate: "2026-07-15", cashAccountCode: "1010",
    });
    expect(await bal("3110")).toBe("15000.00"); // contra-equity, debit-normal
    expect(await bal("1010")).toBe("-15000.00");

    await recordPurchase(pool, T1, {
      purchasedOn: "2026-07-01",
      lines: [{ sku: "RAW-JAG", qty: "200", unitCost: "118" }],
    });
    const kind = await recordDrawingInKind(pool, T1, {
      partnerId, txDate: "2026-07-20",
      lines: [{ sku: "RAW-JAG", qty: "5" }],
    });
    expect(kind.total.toTakaString()).toBe("590.00");
    expect(await bal("3110")).toBe("15590.00");
    expect(await bal("1310")).toBe("23010.00"); // 23600 − 590
    const stock = await withTransaction(pool, T1, (c) =>
      c.query("SELECT on_hand::text FROM item_stock s JOIN items i ON i.id=s.item_id WHERE i.sku='RAW-JAG'"),
    );
    expect(stock.rows[0].on_hand).toBe("195.000");
  });
});

describe("fixed assets portal (§4.6, §8)", () => {
  it("registers, depreciates idempotently with proration, and disposes with auto gain/loss", async () => {
    await registerAsset(pool, T1, {
      assetCode: "MACH-1", name: "Packing machine", assetAccountCode: "1510",
      acquiredOn: "2026-07-01", cost: "85000", salvageValue: "1000",
      method: "STRAIGHT_LINE", lifeMonths: 48, paidFromAccountCode: "1020",
    });
    await registerAsset(pool, T1, {
      assetCode: "COMP-1", name: "Office laptop", assetAccountCode: "1520",
      acquiredOn: "2026-06-15", cost: "10000",
      method: "DIMINISHING", diminishingAnnualRate: "0.24",
      paidFromAccountCode: "2010",
    });
    expect(await bal("1510")).toBe("85000.00");
    expect(await bal("1520")).toBe("10000.00");

    const run = await runDepreciation(pool, T1, "2026-07");
    // MACH-1: (85000−1000)/48 = 1750, acquired day 1 → full month.
    // COMP-1: 10000 × 0.24/12 = 200.
    expect(run.totalCharge.toTakaString()).toBe("1950.00");
    expect(run.perAsset).toEqual([
      { assetCode: "MACH-1", charge: "1750.00", bookValueAfter: "83250.00" },
      { assetCode: "COMP-1", charge: "200.00", bookValueAfter: "9800.00" },
    ]);
    expect(await bal("6210")).toBe("1950.00");
    expect(await bal("1590")).toBe("1950.00");

    const rerun = await runDepreciation(pool, T1, "2026-07");
    expect(rerun.entry).toBeNull(); // idempotent
    expect(rerun.skipped).toHaveLength(2);
    expect(await bal("6210")).toBe("1950.00"); // unchanged

    // Gain: book 83,250 sold for 84,000 → +750 to 4910.
    const gain = await disposeAsset(pool, T1, {
      assetCode: "MACH-1", disposedOn: "2026-08-01",
      salePrice: "84000", proceedsAccountCode: "1010",
    });
    expect(gain.bookValue.toTakaString()).toBe("83250.00");
    expect(gain.gainLoss.toTakaString()).toBe("750.00");
    expect(await bal("4910")).toBe("750.00");

    // Loss: book 9,800 sold for 9,000 → 800 to 6910.
    const loss = await disposeAsset(pool, T1, {
      assetCode: "COMP-1", disposedOn: "2026-08-01",
      salePrice: "9000", proceedsAccountCode: "1020",
    });
    expect(loss.gainLoss.toTakaString()).toBe("-800.00");
    expect(await bal("6910")).toBe("800.00");
    expect(await bal("1510")).toBe("0.00");
    expect(await bal("1590")).toBe("0.00"); // fully released on disposal

    await expect(
      disposeAsset(pool, T1, {
        assetCode: "MACH-1", disposedOn: "2026-08-02",
        salePrice: "1", proceedsAccountCode: "1010",
      }),
    ).rejects.toThrow(/DISPOSED/);
    const tb = await withTransaction(pool, T1, (c) => trialBalance(c));
    expect(tb.balanced).toBe(true);
  });

  it("prorates the first month by acquisition day", async () => {
    await registerAsset(pool, T1, {
      assetCode: "MID-1", name: "Mid-month asset", assetAccountCode: "1510",
      acquiredOn: "2026-07-17", cost: "31000", salvageValue: "0",
      method: "STRAIGHT_LINE", lifeMonths: 31, paidFromAccountCode: "1020",
    });
    const run = await runDepreciation(pool, T1, "2026-07");
    // monthly 1000; July has 31 days, owned 17th–31st = 15 days → ৳483.87
    expect(run.perAsset[0]!.charge).toBe("483.87");
  });
});

describe("stock counts (§5.7)", () => {
  it("posts shortage and overage against 5090 and corrects book stock", async () => {
    await recordPurchase(pool, T1, {
      purchasedOn: "2026-07-01",
      lines: [
        { sku: "RAW-JAG", qty: "200", unitCost: "118" },
        { sku: "CTN-5KG", qty: "500", unitCost: "22" },
      ],
    });
    const count = await recordStockCount(pool, T1, {
      countedOn: "2026-07-31",
      lines: [
        { sku: "RAW-JAG", countedQty: "195" },   // 5 kg missing → ৳590 loss
        { sku: "CTN-5KG", countedQty: "502" },   // 2 pcs extra → ৳44 gain
      ],
    });
    expect(count.entry).not.toBeNull();
    expect(count.varianceValue.toTakaString()).toBe("-546.00");
    expect(await bal("5090")).toBe("546.00");
    expect(await bal("1310")).toBe("23010.00");
    expect(await bal("1320")).toBe("11044.00");

    const stock = await withTransaction(pool, T1, (c) =>
      c.query(
        `SELECT i.sku, s.on_hand::text FROM item_stock s
         JOIN items i ON i.id=s.item_id ORDER BY i.sku`,
      ),
    );
    expect(stock.rows).toEqual([
      { sku: "CTN-5KG", on_hand: "502.000" },
      { sku: "RAW-JAG", on_hand: "195.000" },
    ]);
    const tb = await withTransaction(pool, T1, (c) => trialBalance(c));
    expect(tb.balanced).toBe(true);
  });
});

describe("period close (§10.4)", () => {
  it("refuses while gates are red, locks when green, and the DB enforces the lock", async () => {
    await recordExpense(pool, T1, {
      expenseDate: "2026-07-10", expenseAccountCode: "6120",
      paidFromAccountCode: "1010", amount: "1800", description: "Electricity",
    });
    await registerAsset(pool, T1, {
      assetCode: "MACH-9", name: "Sealer", assetAccountCode: "1510",
      acquiredOn: "2026-07-05", cost: "12000", salvageValue: "0",
      method: "STRAIGHT_LINE", lifeMonths: 24, paidFromAccountCode: "1020",
    });

    // Depreciation not yet posted → the close must refuse.
    const refused = await closePeriod(pool, T1, "2026-07", null);
    expect(refused.locked).toBe(false);
    const depGate = refused.checklist.gates.find((g) => g.gate === "depreciation_posted")!;
    expect(depGate.ok).toBe(false);

    await runDepreciation(pool, T1, "2026-07");
    const checklist = await runCloseChecklist(pool, T1, "2026-07");
    expect(checklist.allOk).toBe(true);

    const closed = await closePeriod(pool, T1, "2026-07", null);
    expect(closed.locked).toBe(true);
    await expect(closePeriod(pool, T1, "2026-07", null)).rejects.toThrow(/already locked/);

    // The database itself now rejects postings into the locked period.
    await expect(
      recordExpense(pool, T1, {
        expenseDate: "2026-07-15", expenseAccountCode: "6140",
        paidFromAccountCode: "1010", amount: "100", description: "late entry",
      }),
    ).rejects.toThrow(/Period 2026-07 is locked/);

    // OWNER unlock with audited reason → posting works again.
    await expect(
      unlockPeriod(pool, T1, "2026-07", null, "  "),
    ).rejects.toThrow(PortalError);
    await unlockPeriod(pool, T1, "2026-07", null, "correcting July electricity bill");
    await recordExpense(pool, T1, {
      expenseDate: "2026-07-15", expenseAccountCode: "6140",
      paidFromAccountCode: "1010", amount: "100", description: "late entry ok now",
    });
    const audits = await withTransaction(pool, T1, (c) =>
      c.query("SELECT action FROM audit_log WHERE action LIKE 'PERIOD%' ORDER BY id"),
    );
    expect(audits.rows.map((r) => r.action)).toEqual(["PERIOD_LOCKED", "PERIOD_UNLOCKED"]);
  });
});
