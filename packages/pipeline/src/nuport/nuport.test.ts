/**
 * B4 acceptance gate (blueprint §18.3): recorded sample payloads replay
 * into exact journal entries; duplicate replays are no-ops. Runs against
 * real migrated Postgres with full RLS.
 */
import { Money } from "@pfm/domain";
import { createBom, createItem, applyPurchase, checkInventoryIntegrity } from "@pfm/inventory";
import { accountBalance, trialBalance, verifyHashChain, withTransaction } from "@pfm/ledger";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ingestNuportEvent } from "./ingest";
import { backfillCogs, processNuportEvent } from "./process";
import { runNuportSync, type NuportOrderSource } from "./sync";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://erp:erp_local_dev@localhost:5432/pure_foodmart_erp",
  max: 10,
});

let T1 = 0;

// ---- "recorded" sample payloads (canonical webhook contract) ----
const DELIVERED_COD = {
  eventId: "evt-1001",
  orderRef: "NP-10234",
  consignmentId: "SF-88231",
  status: "delivered",
  paymentMode: "COD",
  productAmount: "1050",
  deliveryCharge: "100",
  codAmount: "1150",
  deliveredAt: "2026-07-18T14:30:00+06:00",
  lines: [{ sku: "JAG-5KG", qty: "1", unitPrice: "1050", lineTotal: "1050" }],
};

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
      `TRUNCATE nuport_events, sync_runs, sales_order_lines, sales_orders,
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
  await applyPurchase(c, {
    purchaseId: 1, purchasedOn: "2026-07-01", creditAccountCode: "1020",
    memo: "opening stock",
    lines: [
      { itemId: rawJag.id, qty: "200", unitCost: "118" },
      { itemId: ctn5.id, qty: "500", unitCost: "22" },
    ],
  });
}

async function ingest(payload: Record<string, unknown>) {
  return withTransaction(pool, T1, (c) =>
    ingestNuportEvent(c, {
      channel: "WEBHOOK",
      externalEventId: (payload.eventId as string) ?? null,
      orderRef: payload.orderRef as string,
      payload,
    }),
  );
}

beforeAll(async () => {
  T1 = await ensureTenant("Pure Foodmart", "pure-foodmart");
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetAll();
  await withTransaction(pool, T1, seedCatalog);
});

describe("delivered COD order (the primary flow)", () => {
  it("posts JE-A + JE-B exactly as blueprint §4.1 specifies", async () => {
    const { eventId, duplicate } = await ingest(DELIVERED_COD);
    expect(duplicate).toBe(false);
    const result = await processNuportEvent(pool, T1, eventId!);
    expect(result.outcome).toBe("POSTED");
    expect(result.revenueEntry).toBeDefined();
    expect(result.cogsEntry).toBeDefined();

    const view = await withTransaction(pool, T1, async (c) => ({
      courier: await accountBalance(c, "1110"),
      sales: await accountBalance(c, "4010"),
      deliveryIncome: await accountBalance(c, "4020"),
      cogsRaw: await accountBalance(c, "5010"),
      cogsPkg: await accountBalance(c, "5020"),
      tb: await trialBalance(c),
      chain: await verifyHashChain(c),
      i3: await checkInventoryIntegrity(c),
      order: (await c.query(
        "SELECT fin_state, cogs_amount::text, revenue_entry_id, cogs_entry_id FROM sales_orders WHERE nuport_order_ref='NP-10234'",
      )).rows[0],
    }));
    expect(view.courier.toTakaString()).toBe("1150.00");
    expect(view.sales.toTakaString()).toBe("1050.00");
    expect(view.deliveryIncome.toTakaString()).toBe("100.00");
    expect(view.cogsRaw.toTakaString()).toBe("590.00");
    expect(view.cogsPkg.toTakaString()).toBe("22.00");
    expect(view.tb.balanced).toBe(true);
    expect(view.chain.ok).toBe(true);
    expect(view.i3.ok).toBe(true);
    expect(view.order.fin_state).toBe("REVENUE_POSTED");
    expect(view.order.cogs_amount).toBe("612.00");
    expect(view.order.revenue_entry_id).not.toBeNull();
    expect(view.order.cogs_entry_id).not.toBeNull();
  });

  it("webhook replay + cron re-pull are both no-ops (P3)", async () => {
    const first = await ingest(DELIVERED_COD);
    await processNuportEvent(pool, T1, first.eventId!);

    // Same webhook delivered again → ingest-level duplicate.
    const replay = await ingest(DELIVERED_COD);
    expect(replay.duplicate).toBe(true);
    const reprocessed = await processNuportEvent(pool, T1, replay.eventId!);
    expect(reprocessed.outcome).toBe("ALREADY_PROCESSED");

    // Same order state seen via cron (no eventId, same content) → duplicate
    // by payload hash; a *different* payload with same status → state no-op.
    const { eventId: freshEvent } = await withTransaction(pool, T1, (c) =>
      ingestNuportEvent(c, {
        channel: "CRON",
        orderRef: "NP-10234",
        payload: { ...DELIVERED_COD, eventId: undefined, note: "cron variant" },
      }),
    );
    const cronResult = await processNuportEvent(pool, T1, freshEvent!);
    expect(cronResult.outcome).toBe("DUPLICATE");

    const entries = await withTransaction(pool, T1, (c) =>
      c.query("SELECT count(*)::int AS n FROM journal_entries"),
    );
    expect(entries.rows[0].n).toBe(4); // 2 purchase JEs + JE-A + JE-B, nothing more
  });

  it("refuses a COD order whose amounts do not add up", async () => {
    const bad = { ...DELIVERED_COD, eventId: "evt-bad", orderRef: "NP-BAD", codAmount: "1200" };
    const { eventId } = await ingest(bad);
    const result = await processNuportEvent(pool, T1, eventId!);
    expect(result.outcome).toBe("FAILED");
    expect(result.error).toMatch(/airtight control/);
    const entries = await withTransaction(pool, T1, (c) =>
      c.query("SELECT count(*)::int AS n FROM journal_entries WHERE source_type='NUPORT_ORDER'"),
    );
    expect(entries.rows[0].n).toBe(0);
  });
});

describe("exception paths (§14.2, §14.3)", () => {
  it("unmapped SKU → EXCEPTION, no posting, UNMAPPED_SKU alert", async () => {
    const payload = {
      ...DELIVERED_COD, eventId: "evt-2001", orderRef: "NP-20001",
      lines: [{ sku: "MYSTERY-SKU", qty: "1", unitPrice: "1050", lineTotal: "1050" }],
    };
    const { eventId } = await ingest(payload);
    const result = await processNuportEvent(pool, T1, eventId!);
    expect(result.outcome).toBe("EXCEPTION");
    const state = await withTransaction(pool, T1, async (c) => ({
      entries: (await c.query("SELECT count(*)::int AS n FROM journal_entries WHERE source_type='NUPORT_ORDER'")).rows[0],
      alert: (await c.query("SELECT details FROM integrity_alerts WHERE invariant_code='UNMAPPED_SKU'")).rows[0],
      order: (await c.query("SELECT fin_state FROM sales_orders WHERE nuport_order_ref='NP-20001'")).rows[0],
    }));
    expect(state.entries.n).toBe(0);
    expect(state.alert.details.skus).toEqual(["MYSTERY-SKU"]);
    expect(state.order.fin_state).toBe("EXCEPTION");
  });

  it("known SKU without BOM → revenue posts, COGS deferred, then backfilled", async () => {
    await withTransaction(pool, T1, (c) =>
      createItem(c, { sku: "AAM-1KG", name: "Aamsotto 1KG Pack", kind: "FINISHED", uom: "PCS" }),
    );
    const payload = {
      ...DELIVERED_COD, eventId: "evt-3001", orderRef: "NP-30001",
      productAmount: "500", deliveryCharge: "60", codAmount: "560",
      lines: [{ sku: "AAM-1KG", qty: "2", unitPrice: "250", lineTotal: "500" }],
    };
    const { eventId } = await ingest(payload);
    const result = await processNuportEvent(pool, T1, eventId!);
    expect(result.outcome).toBe("NEEDS_BOM");

    const mid = await withTransaction(pool, T1, async (c) => ({
      revenue: await accountBalance(c, "4010"),
      cogs: await accountBalance(c, "5010"),
      order: (await c.query("SELECT id, fin_state FROM sales_orders WHERE nuport_order_ref='NP-30001'")).rows[0],
    }));
    expect(mid.revenue.toTakaString()).toBe("500.00");
    expect(mid.cogs.toTakaString()).toBe("0.00");
    expect(mid.order.fin_state).toBe("NEEDS_BOM");

    // Merchant defines the recipe → deferred COGS posts.
    await withTransaction(pool, T1, async (c) => {
      await createItem(c, {
        sku: "RAW-AAM", name: "Aamsotto", kind: "RAW", uom: "KG",
        inventoryAccountCode: "1310", cogsAccountCode: "5010",
      });
      const item = await c.query("SELECT id FROM items WHERE sku='RAW-AAM'");
      await applyPurchase(c, {
        purchaseId: 9, purchasedOn: "2026-07-05", creditAccountCode: "1020",
        memo: "aamsotto stock",
        lines: [{ itemId: item.rows[0].id, qty: "10", unitCost: "300" }],
      });
      await createBom(c, {
        finishedSku: "AAM-1KG", validFrom: "2026-01-01",
        components: [{ sku: "RAW-AAM", qtyPerUnit: "1" }],
      });
    });
    const backfill = await backfillCogs(pool, T1, Number(mid.order.id));
    expect(backfill.outcome).toBe("POSTED");
    const after = await withTransaction(pool, T1, async (c) => ({
      cogs: await accountBalance(c, "5010"),
      order: (await c.query("SELECT fin_state, cogs_amount::text FROM sales_orders WHERE nuport_order_ref='NP-30001'")).rows[0],
    }));
    expect(after.cogs.toTakaString()).toBe("600.00"); // 2 × 1kg × ৳300
    expect(after.order.fin_state).toBe("REVENUE_POSTED");
    expect(after.order.cogs_amount).toBe("600.00");
  });
});

describe("returns (§4.1 E4/E5)", () => {
  it("RTO before delivery → CLOSED_NO_REVENUE, zero entries", async () => {
    const synced = { ...DELIVERED_COD, eventId: "evt-4001", orderRef: "NP-40001", status: "pending" };
    const rto = { ...DELIVERED_COD, eventId: "evt-4002", orderRef: "NP-40001", status: "returned" };
    const e1 = await ingest(synced);
    await processNuportEvent(pool, T1, e1.eventId!);
    const e2 = await ingest(rto);
    const result = await processNuportEvent(pool, T1, e2.eventId!);
    expect(result.outcome).toBe("CLOSED_NO_REVENUE");
    const entries = await withTransaction(pool, T1, (c) =>
      c.query("SELECT count(*)::int AS n FROM journal_entries WHERE source_type='NUPORT_ORDER'"),
    );
    expect(entries.rows[0].n).toBe(0);
  });

  it("post-delivery return fully reverses revenue, COGS, and stock", async () => {
    const e1 = await ingest(DELIVERED_COD);
    await processNuportEvent(pool, T1, e1.eventId!);
    const e2 = await ingest({ ...DELIVERED_COD, eventId: "evt-5002", status: "returned" });
    const result = await processNuportEvent(pool, T1, e2.eventId!);
    expect(result.outcome).toBe("RETURN_POSTED");

    const view = await withTransaction(pool, T1, async (c) => ({
      courier: await accountBalance(c, "1110"),
      returns: await accountBalance(c, "4110"),
      deliveryIncome: await accountBalance(c, "4020"),
      cogsRaw: await accountBalance(c, "5010"),
      cogsPkg: await accountBalance(c, "5020"),
      jag: (await c.query(
        "SELECT s.on_hand::text FROM item_stock s JOIN items i ON i.id=s.item_id WHERE i.sku='RAW-JAG'",
      )).rows[0],
      tb: await trialBalance(c),
      i3: await checkInventoryIntegrity(c),
    }));
    expect(view.courier.toTakaString()).toBe("0.00");   // 1150 in, 1150 out
    expect(view.returns.toTakaString()).toBe("1050.00"); // contra: gross sales preserved
    expect(view.deliveryIncome.toTakaString()).toBe("0.00");
    expect(view.cogsRaw.toTakaString()).toBe("0.00");
    expect(view.cogsPkg.toTakaString()).toBe("0.00");
    expect(view.jag.on_hand).toBe("200.000");            // fully restocked
    expect(view.tb.balanced).toBe(true);
    expect(view.i3.ok).toBe(true);
  });
});

describe("prepaid orders (§4.2)", () => {
  it("delivered bKash order clears the customer-advance account", async () => {
    const payload = {
      ...DELIVERED_COD, eventId: "evt-6001", orderRef: "NP-60001",
      paymentMode: "BKASH", codAmount: "0",
    };
    const { eventId } = await ingest(payload);
    const result = await processNuportEvent(pool, T1, eventId!);
    expect(result.outcome).toBe("POSTED");
    const advances = await withTransaction(pool, T1, (c) => accountBalance(c, "2110"));
    // No advance was pre-booked in this test, so the debit shows as −1150 —
    // exactly the §4.2 control: 2110 must net to zero once PREPAYMENT_RECEIVED
    // (B6 portal / payment webhook) books the incoming wallet money.
    expect(advances.toTakaString()).toBe("-1150.00");
  });
});

describe("cron completeness loop (§12.2)", () => {
  it("pulls, posts once, and re-runs as pure no-ops", async () => {
    const source: NuportOrderSource = {
      async listOrders({ page }) {
        if (page === 1) {
          return {
            orders: [
              { ...DELIVERED_COD, eventId: undefined } as never,
              { ...DELIVERED_COD, eventId: undefined, orderRef: "NP-70002", status: "pending" } as never,
            ],
            nextPage: null,
          };
        }
        return { orders: [], nextPage: null };
      },
    };
    const first = await runNuportSync(pool, T1, source);
    expect(first.ordersSeen).toBe(2);
    expect(first.ordersChanged).toBe(2);
    expect(first.outcomes.map((o) => o.outcome).sort()).toEqual(["POSTED", "STATE_UPDATED"]);

    const second = await runNuportSync(pool, T1, source);
    expect(second.ordersSeen).toBe(2);
    expect(second.ordersChanged).toBe(0); // payload-hash dedup

    const runs = await withTransaction(pool, T1, (c) =>
      c.query("SELECT status, cursor_after FROM sync_runs ORDER BY id"),
    );
    expect(runs.rows.map((r) => r.status)).toEqual(["OK", "OK"]);
    expect(runs.rows[1].cursor_after).not.toBeNull();
  });
});
