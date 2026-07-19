/**
 * B3 acceptance gate (blueprint §18.3) against real migrated Postgres:
 * the ৳612 worked example, combo-order merge, MWA behavior, BOM
 * versioning, negative-stock alerts, rounding discipline (I3), and
 * multi-tenant isolation of the whole engine.
 */
import { Money } from "@pfm/domain";
import { accountBalance, trialBalance, withTransaction } from "@pfm/ledger";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createBom } from "./bom";
import { createItem } from "./items";
import { recordInbound, recordOutbound } from "./movements";
import { applyPurchase } from "./purchase";
import { deductForSale } from "./sale";
import { InventoryError, NeedsBomError } from "./types";
import { checkInventoryIntegrity } from "./verify";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://erp:erp_local_dev@localhost:5432/pure_foodmart_erp",
  max: 10,
});

let T1 = 0;
let T2 = 0;

async function ensureTenant(name: string, slug: string): Promise<number> {
  const found = await pool.query<{ id: number }>(
    "SELECT id FROM tenants WHERE slug = $1",
    [slug],
  );
  if (found.rows[0]) return found.rows[0].id;
  const created = await pool.query<{ id: number }>(
    "SELECT provision_tenant($1, $2) AS id",
    [name, slug],
  );
  return created.rows[0]!.id;
}

async function resetAll(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(
      `TRUNCATE inventory_movements, item_stock, bom_lines, boms, items,
               purchases, purchase_lines, integrity_alerts,
               journal_lines, journal_entries
       RESTART IDENTITY CASCADE`,
    );
    for (const t of [T1, T2]) {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        String(t),
      ]);
      await client.query(
        "UPDATE ledger_sequence SET last_entry_no = 0, last_hash = repeat('0', 64)",
      );
      await client.query("COMMIT");
    }
  } finally {
    client.release();
  }
}

/** Pure Foodmart's standard catalog + opening purchases (blueprint §4/§5). */
async function seedCatalog(c: PoolClient): Promise<void> {
  const rawJag = await createItem(c, {
    sku: "RAW-JAG", name: "Raw Jaggery", kind: "RAW", uom: "KG",
    inventoryAccountCode: "1310", cogsAccountCode: "5010",
  });
  const rawAam = await createItem(c, {
    sku: "RAW-AAM", name: "Aamsotto", kind: "RAW", uom: "KG",
    inventoryAccountCode: "1310", cogsAccountCode: "5010",
  });
  const ctn5 = await createItem(c, {
    sku: "CTN-5KG", name: "Carton 5KG", kind: "PACKAGING", uom: "PCS",
    inventoryAccountCode: "1320", cogsAccountCode: "5020",
  });
  const ctn2 = await createItem(c, {
    sku: "CTN-2KG", name: "Carton 2KG", kind: "PACKAGING", uom: "PCS",
    inventoryAccountCode: "1320", cogsAccountCode: "5020",
  });
  const ctn1 = await createItem(c, {
    sku: "CTN-1KG", name: "Carton 1KG", kind: "PACKAGING", uom: "PCS",
    inventoryAccountCode: "1320", cogsAccountCode: "5020",
  });
  await createItem(c, {
    sku: "JAG-5KG", name: "5KG Jaggery Pack", kind: "FINISHED", uom: "PCS",
  });
  await createItem(c, {
    sku: "COMBO-JA", name: "Jaggery 2KG + Aamsotto 1KG Combo", kind: "FINISHED", uom: "PCS",
  });

  await createBom(c, {
    finishedSku: "JAG-5KG", validFrom: "2026-01-01",
    components: [
      { sku: "RAW-JAG", qtyPerUnit: "5" },
      { sku: "CTN-5KG", qtyPerUnit: "1" },
    ],
  });
  await createBom(c, {
    finishedSku: "COMBO-JA", validFrom: "2026-01-01",
    components: [
      { sku: "RAW-JAG", qtyPerUnit: "2" },
      { sku: "RAW-AAM", qtyPerUnit: "1" },
      { sku: "CTN-2KG", qtyPerUnit: "1" },
      { sku: "CTN-1KG", qtyPerUnit: "1" },
    ],
  });

  // Bulk asset logging (§4.3): raw by bank, packaging on supplier credit.
  await applyPurchase(c, {
    purchaseId: 1, purchasedOn: "2026-07-01", creditAccountCode: "1020",
    memo: "Bulk raw purchase",
    lines: [
      { itemId: rawJag.id, qty: "200", unitCost: "118" },
      { itemId: rawAam.id, qty: "10", unitCost: "300" },
    ],
  });
  await applyPurchase(c, {
    purchaseId: 2, purchasedOn: "2026-07-02", creditAccountCode: "2010",
    memo: "Packaging stock",
    lines: [
      { itemId: ctn5.id, qty: "500", unitCost: "22" },
      { itemId: ctn2.id, qty: "100", unitCost: "15" },
      { itemId: ctn1.id, qty: "100", unitCost: "10" },
    ],
  });
}

async function stockOf(c: PoolClient, sku: string) {
  const r = await c.query<{ on_hand: string; avg_cost: string }>(
    `SELECT s.on_hand::text, s.avg_cost::text
     FROM item_stock s JOIN items i ON i.id = s.item_id WHERE i.sku = $1`,
    [sku],
  );
  return r.rows[0]!;
}

beforeAll(async () => {
  T1 = await ensureTenant("Pure Foodmart", "pure-foodmart");
  T2 = await ensureTenant("Rival Store", "rival-store");
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetAll();
  await withTransaction(pool, T1, seedCatalog);
});

describe("worked example (blueprint §4.1)", () => {
  it("5KG Jaggery Pack sale deducts 5kg raw + 1 carton = ৳612 COGS", async () => {
    const result = await withTransaction(pool, T1, (c) =>
      deductForSale(c, {
        orderId: 10234, deliveredOn: "2026-07-18",
        memo: "COGS NP-10234", lines: [{ sku: "JAG-5KG", qty: "1" }],
      }),
    );
    expect(result.totalCogs.toTakaString()).toBe("612.00");
    expect(result.negativeStockSkus).toEqual([]);
    expect(result.entry).not.toBeNull();

    const view = await withTransaction(pool, T1, async (c) => ({
      jag: await stockOf(c, "RAW-JAG"),
      ctn: await stockOf(c, "CTN-5KG"),
      cogsRaw: await accountBalance(c, "5010"),
      cogsPkg: await accountBalance(c, "5020"),
      invRaw: await accountBalance(c, "1310"),
      invPkg: await accountBalance(c, "1320"),
      tb: await trialBalance(c),
      i3: await checkInventoryIntegrity(c),
    }));
    expect(view.jag.on_hand).toBe("195.000");
    expect(view.ctn.on_hand).toBe("499.000");
    expect(view.cogsRaw.toTakaString()).toBe("590.00");
    expect(view.cogsPkg.toTakaString()).toBe("22.00");
    // 1310: 200×118 + 10×300 − 590 = 26,010 · 1320: 13,500 − 22 = 13,478
    expect(view.invRaw.toTakaString()).toBe("26010.00");
    expect(view.invPkg.toTakaString()).toBe("13478.00");
    expect(view.tb.balanced).toBe(true);
    expect(view.i3.ok).toBe(true);
    expect(view.i3.ledgerMatchesMovements).toBe(true);
  });
});

describe("multi-product orders (§5.4 merge)", () => {
  it("merges shared components into ONE movement per component", async () => {
    const result = await withTransaction(pool, T1, (c) =>
      deductForSale(c, {
        orderId: 10250, deliveredOn: "2026-07-18", memo: "combo order",
        lines: [
          { sku: "JAG-5KG", qty: "1" },
          { sku: "COMBO-JA", qty: "2" },
        ],
      }),
    );
    // RAW-JAG: 5 + 2×2 = 9 kg · RAW-AAM 2 · CTN-5KG 1 · CTN-2KG 2 · CTN-1KG 2
    // COGS: 9×118 + 2×300 + 22 + 2×15 + 2×10 = 1,734
    expect(result.totalCogs.toTakaString()).toBe("1734.00");
    const jag = result.components.find((x) => x.sku === "RAW-JAG")!;
    expect(jag.qty).toBe("9.000");

    const movementRows = await withTransaction(pool, T1, (c) =>
      c.query<{ sku: string; n: string }>(
        `SELECT i.sku, count(*)::text AS n
         FROM inventory_movements m JOIN items i ON i.id = m.item_id
         WHERE m.source_type = 'NUPORT_ORDER' AND m.source_id = 10250
         GROUP BY i.sku`,
      ),
    );
    for (const row of movementRows.rows) {
      expect(Number(row.n), `movements for ${row.sku}`).toBe(1);
    }
  });
});

describe("moving weighted average (§5.3)", () => {
  it("recomputes on inbound, consumes at average, resets after negative", async () => {
    await withTransaction(pool, T1, async (c) => {
      const item = await createItem(c, {
        sku: "RAW-X", name: "Test Raw", kind: "RAW", uom: "KG",
        inventoryAccountCode: "1310", cogsAccountCode: "5010",
      });
      const ref = { movementType: "ADJUSTMENT" as const, sourceType: "STOCK_COUNT", sourceId: 1 };
      await recordInbound(c, item.id, "100", "100", ref);
      await recordInbound(c, item.id, "100", "120", ref);
      expect((await stockOf(c, "RAW-X")).avg_cost).toBe("110.000000");

      const out = await recordOutbound(c, item.id, "50", ref);
      expect(out.value.toTakaString()).toBe("-5500.00");
      expect((await stockOf(c, "RAW-X")).avg_cost).toBe("110.000000"); // unchanged

      // drive negative, then inbound resets the average to the new cost
      await recordOutbound(c, item.id, "200", ref); // 150 − 200 = −50
      expect((await stockOf(c, "RAW-X")).on_hand).toBe("-50.000");
      await recordInbound(c, item.id, "100", "130", ref);
      expect((await stockOf(c, "RAW-X")).avg_cost).toBe("130.000000");
    });
  });
});

describe("BOM versioning (§5.2)", () => {
  it("uses the version active at delivery date; history never changes", async () => {
    await withTransaction(pool, T1, (c) =>
      createBom(c, {
        finishedSku: "JAG-5KG", validFrom: "2026-08-01",
        components: [
          { sku: "RAW-JAG", qtyPerUnit: "4.5" }, // recipe change
          { sku: "CTN-5KG", qtyPerUnit: "1" },
        ],
      }),
    );
    const july = await withTransaction(pool, T1, (c) =>
      deductForSale(c, {
        orderId: 1, deliveredOn: "2026-07-20", memo: "july sale",
        lines: [{ sku: "JAG-5KG", qty: "1" }],
      }),
    );
    const august = await withTransaction(pool, T1, (c) =>
      deductForSale(c, {
        orderId: 2, deliveredOn: "2026-08-02", memo: "august sale",
        lines: [{ sku: "JAG-5KG", qty: "1" }],
      }),
    );
    expect(july.totalCogs.toTakaString()).toBe("612.00");   // 5.0 kg recipe
    expect(august.totalCogs.toTakaString()).toBe("553.00"); // 4.5×118 + 22
    expect(july.bomIdBySku["JAG-5KG"]).not.toBe(august.bomIdBySku["JAG-5KG"]);
  });
});

describe("failure modes (§14)", () => {
  it("missing BOM → NeedsBomError, transaction fully rolled back", async () => {
    await withTransaction(pool, T1, (c) =>
      createItem(c, { sku: "NEW-SKU", name: "No recipe yet", kind: "FINISHED", uom: "PCS" }),
    );
    await expect(
      withTransaction(pool, T1, (c) =>
        deductForSale(c, {
          orderId: 3, deliveredOn: "2026-07-18", memo: "no bom",
          lines: [
            { sku: "JAG-5KG", qty: "1" },
            { sku: "NEW-SKU", qty: "1" },
          ],
        }),
      ),
    ).rejects.toThrow(NeedsBomError);
    const after = await withTransaction(pool, T1, async (c) => ({
      jag: await stockOf(c, "RAW-JAG"),
      cogs: await accountBalance(c, "5010"),
    }));
    expect(after.jag.on_hand).toBe("200.000"); // nothing deducted
    expect(after.cogs.toTakaString()).toBe("0.00");
  });

  it("negative stock proceeds (revenue never blocked) and raises NEG_STOCK", async () => {
    const result = await withTransaction(pool, T1, (c) =>
      deductForSale(c, {
        orderId: 4, deliveredOn: "2026-07-18", memo: "oversell",
        lines: [{ sku: "JAG-5KG", qty: "50" }], // needs 250 kg, have 200
      }),
    );
    expect(result.negativeStockSkus).toEqual(["RAW-JAG"]);
    const alerts = await withTransaction(pool, T1, (c) =>
      c.query(
        "SELECT details FROM integrity_alerts WHERE invariant_code = 'NEG_STOCK' AND status = 'OPEN'",
      ),
    );
    expect(alerts.rows).toHaveLength(1);
    expect(alerts.rows[0].details.sku).toBe("RAW-JAG");
  });
});

describe("rounding discipline (§5.5) and I3", () => {
  it("6-dp average cost with 2-dp values stays within the rounding reserve", async () => {
    await withTransaction(pool, T1, async (c) => {
      const item = await createItem(c, {
        sku: "RAW-R", name: "Rounding Raw", kind: "RAW", uom: "KG",
        inventoryAccountCode: "1310", cogsAccountCode: "5010",
      });
      await applyPurchase(c, {
        purchaseId: 3, purchasedOn: "2026-07-03", creditAccountCode: "1020",
        memo: "thirds", lines: [{ itemId: item.id, qty: "3", unitCost: "33.333333" }],
      });
      await recordOutbound(c, item.id, "1", {
        movementType: "SALE_BOM", sourceType: "NUPORT_ORDER", sourceId: 99,
      });
      const report = await checkInventoryIntegrity(c);
      // ledger==movements is not asserted here: the raw recordOutbound above
      // deliberately has no journal entry — full I3 runs in the worked example.
      expect(report.roundingDiff.compare(Money.fromTaka("1"))).toBeLessThanOrEqual(0);
    });
  });
});

describe("tenant isolation of the whole engine", () => {
  it("catalogs, stock, and COGS are invisible across tenants; SKUs may repeat", async () => {
    // T2 has an empty catalog — T1's SKUs do not exist there.
    await expect(
      withTransaction(pool, T2, (c) =>
        deductForSale(c, {
          orderId: 5, deliveredOn: "2026-07-18", memo: "cross-tenant",
          lines: [{ sku: "JAG-5KG", qty: "1" }],
        }),
      ),
    ).rejects.toThrow(InventoryError);

    // T2 can register the SAME SKU string without any uniqueness clash.
    await withTransaction(pool, T2, (c) =>
      createItem(c, {
        sku: "RAW-JAG", name: "Rival's jaggery", kind: "RAW", uom: "KG",
        inventoryAccountCode: "1310", cogsAccountCode: "5010",
      }),
    );

    // T1 sells; T2's books stay untouched.
    await withTransaction(pool, T1, (c) =>
      deductForSale(c, {
        orderId: 6, deliveredOn: "2026-07-18", memo: "t1 sale",
        lines: [{ sku: "JAG-5KG", qty: "1" }],
      }),
    );
    const t2 = await withTransaction(pool, T2, async (c) => ({
      cogs: await accountBalance(c, "5010"),
      movements: await c.query("SELECT count(*)::int AS n FROM inventory_movements"),
      i3: await checkInventoryIntegrity(c),
    }));
    expect(t2.cogs.toTakaString()).toBe("0.00");
    expect(t2.movements.rows[0].n).toBe(0); // T1's movements are invisible
    expect(t2.i3.ok).toBe(true);
  });
});
