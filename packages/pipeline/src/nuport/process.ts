import {
  Money,
  canonicalNuportOrderSchema,
  type CanonicalNuportOrder,
} from "@pfm/domain";
import { NeedsBomError, deductForSale, recordInbound, linkMovementsToEntry } from "@pfm/inventory";
import { postEntry, withTransaction, type PostedEntry } from "@pfm/ledger";
import type { Pool, PoolClient } from "pg";

export type ProcessOutcome =
  | "POSTED"            // revenue + COGS posted
  | "NEEDS_BOM"         // revenue posted, COGS deferred (§14.3)
  | "EXCEPTION"         // unmapped SKU / unsupported flow — no posting (§14.2)
  | "DUPLICATE"         // state machine no-op (already handled)
  | "STATE_UPDATED"     // non-financial status refresh
  | "CLOSED_NO_REVENUE" // cancelled/RTO before delivery
  | "RETURN_POSTED"     // post-delivery return reversed
  | "ALREADY_PROCESSED" // event row was processed earlier
  | "FAILED";           // invalid payload — recorded on the event row

export interface ProcessResult {
  outcome: ProcessOutcome;
  orderId?: number;
  revenueEntry?: PostedEntry;
  cogsEntry?: PostedEntry | null;
  error?: string;
}

interface OrderRow {
  id: string;
  fin_state: string;
  payment_mode: string;
  product_amount: string;
  delivery_charge: string;
  cod_amount: string;
  delivered_at: string | null;
}

/**
 * Idempotency gate #2 + the financial state machine (blueprint §2.5).
 * One event → one transaction: order upsert, revenue (JE-A), BOM/COGS
 * (JE-B via @pfm/inventory), state transition, event bookkeeping — all
 * commit or roll back together. Unexpected errors roll back and leave the
 * event RECEIVED so the queue retries; *expected* rejections mark the
 * event FAILED with the reason.
 */
export async function processNuportEvent(
  pool: Pool,
  tenantId: number,
  eventId: number,
): Promise<ProcessResult> {
  return withTransaction(pool, tenantId, async (c) => {
    const evRes = await c.query<{ id: string; status: string; payload: unknown }>(
      "SELECT id, status, payload FROM nuport_events WHERE id = $1 FOR UPDATE",
      [eventId],
    );
    const ev = evRes.rows[0];
    if (!ev) return { outcome: "FAILED", error: `event ${eventId} not found` };
    if (ev.status === "PROCESSED" || ev.status === "SKIPPED_DUPLICATE") {
      return { outcome: "ALREADY_PROCESSED" };
    }

    let order: CanonicalNuportOrder;
    try {
      order = canonicalNuportOrderSchema.parse(ev.payload);
      validateAmounts(order);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markEvent(c, eventId, "FAILED", msg);
      return { outcome: "FAILED", error: msg };
    }

    const row = await upsertOrder(c, order, eventId);
    const result = await applyStateMachine(c, row, order, eventId);

    await markEvent(
      c,
      eventId,
      result.outcome === "DUPLICATE" ? "SKIPPED_DUPLICATE" : "PROCESSED",
      null,
    );
    return result;
  });
}

/**
 * §14.3 recovery: once the merchant defines the missing BOM, post the
 * deferred COGS for a NEEDS_BOM order and promote it to REVENUE_POSTED.
 */
export async function backfillCogs(
  pool: Pool,
  tenantId: number,
  orderId: number,
): Promise<ProcessResult> {
  return withTransaction(pool, tenantId, async (c) => {
    const res = await c.query<OrderRow & { nuport_order_ref: string }>(
      `SELECT id, fin_state, payment_mode, nuport_order_ref,
              product_amount::text, delivery_charge::text, cod_amount::text,
              delivered_at::text
       FROM sales_orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );
    const row = res.rows[0];
    if (!row) return { outcome: "FAILED", error: `order ${orderId} not found` };
    if (row.fin_state !== "NEEDS_BOM") {
      return { outcome: "DUPLICATE", orderId };
    }
    const lines = await c.query<{ nuport_sku: string; qty: string }>(
      "SELECT nuport_sku, qty::text FROM sales_order_lines WHERE order_id = $1",
      [orderId],
    );
    const deliveredOn = (row.delivered_at ?? new Date().toISOString()).slice(0, 10);
    const cogs = await deductForSale(c, {
      orderId,
      deliveredOn,
      memo: `COGS backfill ${row.nuport_order_ref}`,
      lines: lines.rows.map((l) => ({ sku: l.nuport_sku, qty: l.qty })),
    });
    await c.query(
      `UPDATE sales_orders SET fin_state = 'REVENUE_POSTED',
         cogs_amount = $2, cogs_entry_id = $3, updated_at = now()
       WHERE id = $1`,
      [orderId, cogs.totalCogs.toTakaString(), cogs.entry?.entryId ?? null],
    );
    await updateLineBoms(c, orderId, cogs.bomIdBySku);
    return { outcome: "POSTED", orderId, cogsEntry: cogs.entry };
  });
}

// ----------------------------------------------------------------------
// internals
// ----------------------------------------------------------------------

function validateAmounts(o: CanonicalNuportOrder): void {
  const product = Money.fromTaka(o.productAmount);
  const delivery = Money.fromTaka(o.deliveryCharge);
  const cod = Money.fromTaka(o.codAmount);
  if (o.paymentMode === "COD") {
    if (!cod.equals(product.add(delivery))) {
      throw new Error(
        `COD amount ${cod.toTakaString()} != product ${product.toTakaString()} + delivery ${delivery.toTakaString()} — airtight control refused the order`,
      );
    }
  } else if (!cod.isZero()) {
    throw new Error(`prepaid order carries non-zero COD amount ${cod.toTakaString()}`);
  }
}

async function upsertOrder(
  c: PoolClient,
  o: CanonicalNuportOrder,
  eventId: number,
): Promise<OrderRow> {
  const existing = await c.query<OrderRow>(
    "SELECT id, fin_state, payment_mode, product_amount::text, delivery_charge::text, cod_amount::text, delivered_at::text FROM sales_orders WHERE nuport_order_ref = $1 FOR UPDATE",
    [o.orderRef],
  );
  if (!existing.rows[0]) {
    const ins = await c.query<{ id: string }>(
      `INSERT INTO sales_orders
         (nuport_order_ref, woo_order_ref, consignment_id, payment_mode,
          product_amount, delivery_charge, discount_amount, cod_amount,
          ordered_at, last_event_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        o.orderRef, o.wooRef ?? null, o.consignmentId ?? null, o.paymentMode,
        o.productAmount, o.deliveryCharge, o.discountAmount, o.codAmount,
        o.orderedAt ?? null, eventId,
      ],
    );
    const orderId = Number(ins.rows[0]!.id);
    await insertLines(c, orderId, o);
    return {
      id: String(orderId), fin_state: "SYNCED", payment_mode: o.paymentMode,
      product_amount: o.productAmount, delivery_charge: o.deliveryCharge,
      cod_amount: o.codAmount, delivered_at: null,
    };
  }
  const row = existing.rows[0];
  if (row.fin_state === "SYNCED") {
    // Pre-posting: amounts/lines may still be edited in Nuport — refresh.
    await c.query(
      `UPDATE sales_orders SET woo_order_ref=$2, consignment_id=$3,
         payment_mode=$4, product_amount=$5, delivery_charge=$6,
         discount_amount=$7, cod_amount=$8, ordered_at=COALESCE($9, ordered_at),
         last_event_id=$10, updated_at=now()
       WHERE id=$1`,
      [
        row.id, o.wooRef ?? null, o.consignmentId ?? null, o.paymentMode,
        o.productAmount, o.deliveryCharge, o.discountAmount, o.codAmount,
        o.orderedAt ?? null, eventId,
      ],
    );
    await c.query("DELETE FROM sales_order_lines WHERE order_id = $1", [row.id]);
    await insertLines(c, Number(row.id), o);
    return { ...row, payment_mode: o.paymentMode, product_amount: o.productAmount, delivery_charge: o.deliveryCharge, cod_amount: o.codAmount };
  }
  // Post-posting amount edits are never auto-applied (§14.5).
  if (row.product_amount !== normalize2(o.productAmount) || row.cod_amount !== normalize2(o.codAmount)) {
    await raiseAlert(c, "ORDER_EDIT", {
      orderId: Number(row.id), orderRef: o.orderRef,
      posted: { product: row.product_amount, cod: row.cod_amount },
      incoming: { product: o.productAmount, cod: o.codAmount },
    });
  }
  return row;
}

async function insertLines(c: PoolClient, orderId: number, o: CanonicalNuportOrder): Promise<void> {
  const skus = o.lines.map((l) => l.sku);
  const items = await c.query<{ id: number; sku: string }>(
    "SELECT id, sku FROM items WHERE sku = ANY($1) AND kind = 'FINISHED'",
    [skus],
  );
  const idBySku = new Map(items.rows.map((r) => [r.sku, r.id]));
  for (const l of o.lines) {
    await c.query(
      `INSERT INTO sales_order_lines (order_id, item_id, nuport_sku, qty, unit_price, line_total)
       VALUES ($1,$2,$3,$4::numeric(12,3),$5,$6)`,
      [orderId, idBySku.get(l.sku) ?? null, l.sku, l.qty, l.unitPrice, l.lineTotal],
    );
  }
}

async function applyStateMachine(
  c: PoolClient,
  row: OrderRow,
  o: CanonicalNuportOrder,
  eventId: number,
): Promise<ProcessResult> {
  const orderId = Number(row.id);
  switch (o.status) {
    case "delivered":
      return handleDelivered(c, row, o);
    case "returned":
      return handleReturned(c, row, o);
    case "cancelled":
      if (row.fin_state === "SYNCED") {
        await setState(c, orderId, "CLOSED_NO_REVENUE");
        return { outcome: "CLOSED_NO_REVENUE", orderId };
      }
      if (row.fin_state === "CLOSED_NO_REVENUE") return { outcome: "DUPLICATE", orderId };
      await raiseAlert(c, "ORDER_EDIT", {
        orderId, orderRef: o.orderRef,
        reason: `cancelled while ${row.fin_state} — needs human review`,
      });
      return { outcome: "EXCEPTION", orderId };
    default:
      return { outcome: "STATE_UPDATED", orderId };
  }
}

async function handleDelivered(
  c: PoolClient,
  row: OrderRow,
  o: CanonicalNuportOrder,
): Promise<ProcessResult> {
  const orderId = Number(row.id);
  if (row.fin_state !== "SYNCED") {
    // Revenue posts exactly once — replays and webhook/cron races land here.
    return { outcome: "DUPLICATE", orderId };
  }

  // §14.2: any unmapped SKU freezes the order BEFORE money moves.
  const unmapped = await c.query<{ nuport_sku: string }>(
    "SELECT nuport_sku FROM sales_order_lines WHERE order_id = $1 AND item_id IS NULL",
    [orderId],
  );
  if (unmapped.rows.length > 0) {
    await raiseAlert(c, "UNMAPPED_SKU", {
      orderId, orderRef: o.orderRef,
      skus: unmapped.rows.map((r) => r.nuport_sku),
    });
    await setState(c, orderId, "EXCEPTION");
    return { outcome: "EXCEPTION", orderId };
  }

  const deliveredOn = (o.deliveredAt ?? new Date().toISOString()).slice(0, 10);
  const product = Money.fromTaka(o.productAmount);
  const delivery = Money.fromTaka(o.deliveryCharge);
  const isCod = o.paymentMode === "COD";

  // JE-A (§4.1 / §4.2): COD debits courier funds; prepaid clears the advance.
  const revenueLines = [
    isCod
      ? { accountCode: "1110", debit: Money.fromTaka(o.codAmount) }
      : { accountCode: "2110", debit: product.add(delivery) },
    { accountCode: "4010", credit: product },
    ...(delivery.isZero() ? [] : [{ accountCode: "4020", credit: delivery }]),
  ];
  const revenueEntry = await postEntry(c, {
    entryDate: deliveredOn,
    memo: `Revenue ${o.orderRef}`,
    sourceType: "NUPORT_ORDER",
    sourceId: orderId,
    eventCode: isCod ? "SALE_DELIVERED_COD" : "SALE_DELIVERED_PREPAID",
    lines: revenueLines,
  });

  // JE-B in the same transaction; a missing recipe defers COGS, not revenue.
  try {
    const cogs = await deductForSale(c, {
      orderId,
      deliveredOn,
      memo: `COGS ${o.orderRef}`,
      lines: o.lines.map((l) => ({ sku: l.sku, qty: l.qty })),
    });
    await c.query(
      `UPDATE sales_orders SET fin_state='REVENUE_POSTED', delivered_at=$2,
         revenue_entry_id=$3, cogs_entry_id=$4, cogs_amount=$5, updated_at=now()
       WHERE id=$1`,
      [
        orderId, o.deliveredAt ?? new Date().toISOString(),
        revenueEntry.entryId, cogs.entry?.entryId ?? null,
        cogs.totalCogs.toTakaString(),
      ],
    );
    await updateLineBoms(c, orderId, cogs.bomIdBySku);
    return { outcome: "POSTED", orderId, revenueEntry, cogsEntry: cogs.entry };
  } catch (err) {
    if (!(err instanceof NeedsBomError)) throw err;
    await raiseAlert(c, "NEEDS_BOM", {
      orderId, orderRef: o.orderRef, skus: err.skusWithoutBom,
    });
    await c.query(
      `UPDATE sales_orders SET fin_state='NEEDS_BOM', delivered_at=$2,
         revenue_entry_id=$3, updated_at=now()
       WHERE id=$1`,
      [orderId, o.deliveredAt ?? new Date().toISOString(), revenueEntry.entryId],
    );
    return { outcome: "NEEDS_BOM", orderId, revenueEntry, cogsEntry: null };
  }
}

async function handleReturned(
  c: PoolClient,
  row: OrderRow,
  o: CanonicalNuportOrder,
): Promise<ProcessResult> {
  const orderId = Number(row.id);
  if (row.fin_state === "SYNCED") {
    // RTO — never delivered, no revenue existed (courier charge lands in B5).
    await c.query(
      "UPDATE sales_orders SET fin_state='CLOSED_NO_REVENUE', returned_at=now(), updated_at=now() WHERE id=$1",
      [orderId],
    );
    return { outcome: "CLOSED_NO_REVENUE", orderId };
  }
  if (row.fin_state === "RETURN_POSTED" || row.fin_state === "CLOSED_NO_REVENUE") {
    return { outcome: "DUPLICATE", orderId };
  }
  if (!(row.fin_state === "REVENUE_POSTED" || row.fin_state === "NEEDS_BOM")) {
    await raiseAlert(c, "ORDER_EDIT", {
      orderId, orderRef: o.orderRef, reason: `returned while ${row.fin_state}`,
    });
    return { outcome: "EXCEPTION", orderId };
  }
  if (row.payment_mode !== "COD") {
    // Prepaid refunds move real wallet money — human decision (§4.1 E5).
    await raiseAlert(c, "RETURN_MANUAL", {
      orderId, orderRef: o.orderRef, paymentMode: row.payment_mode,
    });
    return { outcome: "EXCEPTION", orderId };
  }

  const today = new Date().toISOString().slice(0, 10);
  const product = Money.fromTaka(row.product_amount);
  const delivery = Money.fromTaka(row.delivery_charge);

  // JE-E: reverse revenue via contra account; money comes back out of 1110.
  await postEntry(c, {
    entryDate: today,
    memo: `Return ${o.orderRef}`,
    sourceType: "NUPORT_ORDER",
    sourceId: orderId,
    eventCode: "POST_DELIVERY_RETURN",
    lines: [
      { accountCode: "4110", debit: product },
      ...(delivery.isZero() ? [] : [{ accountCode: "4020", debit: delivery }]),
      { accountCode: "1110", credit: Money.fromTaka(row.cod_amount) },
    ],
  });

  // JE-F: restock the exact original deduction (same qty, same unit cost)
  // and reverse COGS — only if COGS was actually posted.
  if (row.fin_state === "REVENUE_POSTED") {
    const moved = await c.query<{
      item_id: number; qty: string; unit_cost: string; value: string;
      inv_code: string; cogs_code: string;
    }>(
      `SELECT m.item_id, (-m.qty)::text AS qty, m.unit_cost::text,
              (-m.value)::numeric(14,2)::text AS value,
              inv.code AS inv_code, cog.code AS cogs_code
       FROM inventory_movements m
       JOIN items i ON i.id = m.item_id
       JOIN accounts inv ON inv.id = i.inventory_account_id
       JOIN accounts cog ON cog.id = i.cogs_account_id
       WHERE m.source_type='NUPORT_ORDER' AND m.source_id=$1
         AND m.movement_type='SALE_BOM'
       ORDER BY m.item_id`,
      [orderId],
    );
    const movementIds: number[] = [];
    const byPair = new Map<string, { inv: string; cogs: string; total: Money }>();
    for (const m of moved.rows) {
      const res = await recordInbound(c, m.item_id, m.qty, m.unit_cost, {
        movementType: "RETURN_RESTOCK",
        sourceType: "NUPORT_ORDER",
        sourceId: orderId,
      });
      movementIds.push(res.movementId);
      const key = `${m.inv_code}|${m.cogs_code}`;
      const b = byPair.get(key) ?? { inv: m.inv_code, cogs: m.cogs_code, total: Money.ZERO };
      b.total = b.total.add(Money.fromTaka(m.value));
      byPair.set(key, b);
    }
    const buckets = [...byPair.values()].filter((b) => !b.total.isZero());
    if (buckets.length > 0) {
      const entry = await postEntry(c, {
        entryDate: today,
        memo: `Return restock ${o.orderRef}`,
        sourceType: "NUPORT_ORDER",
        sourceId: orderId,
        eventCode: "RETURN_RESTOCK",
        lines: [
          ...buckets.map((b) => ({ accountCode: b.inv, debit: b.total })),
          ...buckets.map((b) => ({ accountCode: b.cogs, credit: b.total })),
        ],
      });
      await linkMovementsToEntry(c, movementIds, entry.entryId);
    }
  }

  await c.query(
    "UPDATE sales_orders SET fin_state='RETURN_POSTED', returned_at=now(), updated_at=now() WHERE id=$1",
    [orderId],
  );
  return { outcome: "RETURN_POSTED", orderId };
}

async function updateLineBoms(
  c: PoolClient,
  orderId: number,
  bomIdBySku: Record<string, number>,
): Promise<void> {
  for (const [sku, bomId] of Object.entries(bomIdBySku)) {
    await c.query(
      "UPDATE sales_order_lines SET bom_id=$3 WHERE order_id=$1 AND nuport_sku=$2",
      [orderId, sku, bomId],
    );
  }
}

async function setState(c: PoolClient, orderId: number, state: string): Promise<void> {
  await c.query(
    "UPDATE sales_orders SET fin_state=$2, updated_at=now() WHERE id=$1",
    [orderId, state],
  );
}

async function raiseAlert(c: PoolClient, code: string, details: unknown): Promise<void> {
  await c.query(
    "INSERT INTO integrity_alerts (invariant_code, severity, details) VALUES ($1,'ERROR',$2)",
    [code, JSON.stringify(details)],
  );
}

async function markEvent(
  c: PoolClient,
  eventId: number,
  status: "PROCESSED" | "SKIPPED_DUPLICATE" | "FAILED",
  error: string | null,
): Promise<void> {
  await c.query(
    "UPDATE nuport_events SET status=$2, processed_at=now(), error=$3 WHERE id=$1",
    [eventId, status, error],
  );
}

function normalize2(v: string): string {
  return Money.fromTaka(v).toTakaString();
}
