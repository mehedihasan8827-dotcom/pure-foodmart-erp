import { Money } from "@pfm/domain";
import { NeedsBomError, deductForSale } from "@pfm/inventory";
import { postEntry, type PostedEntry } from "@pfm/ledger";
import type { PoolClient } from "pg";
import { raiseAlert, setOrderState } from "./util";

export interface DeliveryPostResult {
  outcome: "POSTED" | "NEEDS_BOM" | "EXCEPTION";
  revenueEntry?: PostedEntry;
  cogsEntry?: PostedEntry | null;
}

/**
 * Revenue recognition from the ORDER'S STORED STATE (blueprint §4.1/§4.2).
 * Shared by both pipelines: Nuport's `delivered` webhook/cron event and
 * Steadfast's status poller (Steadfast is authoritative for delivery,
 * §2.4) — whichever confirms first posts, the other becomes a no-op.
 *
 * Caller must hold the order row lock and have verified fin_state=SYNCED.
 * Posts JE-A (+ JE-B via BOM deduction) inside the caller's transaction.
 */
export async function postDeliveryFromDb(
  c: PoolClient,
  orderId: number,
  deliveredAtIso: string | null,
): Promise<DeliveryPostResult> {
  const res = await c.query<{
    nuport_order_ref: string;
    payment_mode: string;
    product_amount: string;
    delivery_charge: string;
    cod_amount: string;
  }>(
    `SELECT nuport_order_ref, payment_mode, product_amount::text,
            delivery_charge::text, cod_amount::text
     FROM sales_orders WHERE id = $1`,
    [orderId],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`order ${orderId} not found`);

  // §14.2: any unmapped SKU freezes the order BEFORE money moves.
  const unmapped = await c.query<{ nuport_sku: string }>(
    "SELECT nuport_sku FROM sales_order_lines WHERE order_id = $1 AND item_id IS NULL",
    [orderId],
  );
  if (unmapped.rows.length > 0) {
    await raiseAlert(c, "UNMAPPED_SKU", {
      orderId,
      orderRef: row.nuport_order_ref,
      skus: unmapped.rows.map((r) => r.nuport_sku),
    });
    await setOrderState(c, orderId, "EXCEPTION");
    return { outcome: "EXCEPTION" };
  }

  const deliveredAt = deliveredAtIso ?? new Date().toISOString();
  const deliveredOn = deliveredAt.slice(0, 10);
  const product = Money.fromTaka(row.product_amount);
  const delivery = Money.fromTaka(row.delivery_charge);
  const isCod = row.payment_mode === "COD";

  // JE-A: COD debits courier funds (1110); prepaid clears the advance (2110).
  const revenueEntry = await postEntry(c, {
    entryDate: deliveredOn,
    memo: `Revenue ${row.nuport_order_ref}`,
    sourceType: "NUPORT_ORDER",
    sourceId: orderId,
    eventCode: isCod ? "SALE_DELIVERED_COD" : "SALE_DELIVERED_PREPAID",
    lines: [
      isCod
        ? { accountCode: "1110", debit: Money.fromTaka(row.cod_amount) }
        : { accountCode: "2110", debit: product.add(delivery) },
      { accountCode: "4010", credit: product },
      ...(delivery.isZero() ? [] : [{ accountCode: "4020", credit: delivery }]),
    ],
  });

  const lines = await c.query<{ nuport_sku: string; qty: string }>(
    "SELECT nuport_sku, qty::text FROM sales_order_lines WHERE order_id = $1",
    [orderId],
  );

  try {
    const cogs = await deductForSale(c, {
      orderId,
      deliveredOn,
      memo: `COGS ${row.nuport_order_ref}`,
      lines: lines.rows.map((l) => ({ sku: l.nuport_sku, qty: l.qty })),
    });
    await c.query(
      `UPDATE sales_orders SET fin_state='REVENUE_POSTED', delivered_at=$2,
         revenue_entry_id=$3, cogs_entry_id=$4, cogs_amount=$5, updated_at=now()
       WHERE id=$1`,
      [
        orderId,
        deliveredAt,
        revenueEntry.entryId,
        cogs.entry?.entryId ?? null,
        cogs.totalCogs.toTakaString(),
      ],
    );
    for (const [sku, bomId] of Object.entries(cogs.bomIdBySku)) {
      await c.query(
        "UPDATE sales_order_lines SET bom_id=$3 WHERE order_id=$1 AND nuport_sku=$2",
        [orderId, sku, bomId],
      );
    }
    return { outcome: "POSTED", revenueEntry, cogsEntry: cogs.entry };
  } catch (err) {
    if (!(err instanceof NeedsBomError)) throw err;
    await raiseAlert(c, "NEEDS_BOM", {
      orderId,
      orderRef: row.nuport_order_ref,
      skus: err.skusWithoutBom,
    });
    await c.query(
      `UPDATE sales_orders SET fin_state='NEEDS_BOM', delivered_at=$2,
         revenue_entry_id=$3, updated_at=now()
       WHERE id=$1`,
      [orderId, deliveredAt, revenueEntry.entryId],
    );
    return { outcome: "NEEDS_BOM", revenueEntry, cogsEntry: null };
  }
}
