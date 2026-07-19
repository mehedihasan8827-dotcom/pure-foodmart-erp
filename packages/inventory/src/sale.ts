import { Money } from "@pfm/domain";
import { postEntry, type PostedEntry } from "@pfm/ledger";
import type { PoolClient } from "pg";
import { explodeAndMerge, getActiveBomId } from "./bom";
import { linkMovementsToEntry, recordOutbound } from "./movements";
import {
  InventoryError,
  NeedsBomError,
  assertQty,
  type QtyString,
} from "./types";

export interface SaleLineInput {
  sku: string; // FINISHED item SKU (== merchant's Nuport SKU)
  qty: QtyString;
}

export interface DeductForSaleInput {
  orderId: number;
  /** Delivery date (revenue recognition date), YYYY-MM-DD — selects BOM version. */
  deliveredOn: string;
  lines: SaleLineInput[];
  memo: string;
  postedBy?: number | null;
}

export interface DeductedComponent {
  itemId: number;
  sku: string;
  qty: string; // merged requirement, NUMERIC(12,3) text
  unitCost: string; // moving average applied
  value: Money; // positive COGS contribution
}

export interface DeductForSaleResult {
  /** Null only when total COGS rounds to zero (nothing to post). */
  entry: PostedEntry | null;
  totalCogs: Money;
  components: DeductedComponent[];
  /** BOM version used per finished SKU — for sales_order_lines.bom_id. */
  bomIdBySku: Record<string, number>;
  /** SKUs of components driven below zero stock (NEG_STOCK alerts raised). */
  negativeStockSkus: string[];
}

/**
 * The core loop (blueprint §5.4): explode BOMs, merge components across
 * all order lines, deduct at moving average, post ONE COGS entry — all
 * inside the caller's transaction so revenue, COGS, and stock can never
 * diverge. Missing BOMs throw NeedsBomError (order → NEEDS_BOM, §14.3);
 * negative stock proceeds but raises a NEG_STOCK integrity alert (§14.4).
 */
export async function deductForSale(
  client: PoolClient,
  input: DeductForSaleInput,
): Promise<DeductForSaleResult> {
  if (input.lines.length === 0) throw new InventoryError("Sale has no lines");
  for (const l of input.lines) assertQty(l.qty, `qty(${l.sku})`);

  // Resolve finished items in this tenant's catalog.
  const skus = input.lines.map((l) => l.sku);
  const found = await client.query<{ id: number; sku: string; kind: string }>(
    "SELECT id, sku, kind FROM items WHERE sku = ANY($1)",
    [skus],
  );
  const bySku = new Map(found.rows.map((r) => [r.sku, r]));
  const unknown = skus.filter((s) => !bySku.has(s));
  if (unknown.length > 0) {
    throw new InventoryError(`Unknown SKU(s): ${unknown.join(", ")}`);
  }
  for (const r of found.rows) {
    if (r.kind !== "FINISHED") {
      throw new InventoryError(`SKU ${r.sku} is ${r.kind}, not FINISHED`);
    }
  }

  // Active BOM version per SKU at the delivery date.
  const bomIdBySku: Record<string, number> = {};
  const missing: string[] = [];
  for (const line of input.lines) {
    const item = bySku.get(line.sku)!;
    const bomId = await getActiveBomId(client, item.id, input.deliveredOn);
    if (bomId === null) missing.push(line.sku);
    else bomIdBySku[line.sku] = bomId;
  }
  if (missing.length > 0) throw new NeedsBomError(missing);

  // Explode + merge (combo orders collapse into one requirement per component).
  const requirements = await explodeAndMerge(
    client,
    input.lines.map((l) => ({ bomId: bomIdBySku[l.sku]!, qty: l.qty })),
  );

  // Deduct in ascending item_id order (already sorted by explodeAndMerge).
  const components: DeductedComponent[] = [];
  const negativeStockSkus: string[] = [];
  const buckets = new Map<
    string,
    { cogsCode: string; invCode: string; total: Money; movementIds: number[] }
  >();
  for (const req of requirements) {
    const res = await recordOutbound(client, req.itemId, req.reqQty, {
      movementType: "SALE_BOM",
      sourceType: "NUPORT_ORDER",
      sourceId: input.orderId,
    });
    const cogsValue = res.value.negate(); // outbound value is negative
    components.push({
      itemId: req.itemId,
      sku: req.sku,
      qty: req.reqQty,
      unitCost: res.unitCost,
      value: cogsValue,
    });
    if (Number(res.onHandAfter) < 0) {
      negativeStockSkus.push(req.sku);
      await client.query(
        `INSERT INTO integrity_alerts (invariant_code, severity, details)
         VALUES ('NEG_STOCK', 'ERROR', $1)`,
        [
          JSON.stringify({
            itemId: req.itemId,
            sku: req.sku,
            onHandAfter: res.onHandAfter,
            orderId: input.orderId,
          }),
        ],
      );
    }
    const key = `${req.cogsAccountCode}|${req.inventoryAccountCode}`;
    const bucket =
      buckets.get(key) ??
      {
        cogsCode: req.cogsAccountCode,
        invCode: req.inventoryAccountCode,
        total: Money.ZERO,
        movementIds: [],
      };
    bucket.total = bucket.total.add(cogsValue);
    bucket.movementIds.push(res.movementId);
    buckets.set(key, bucket);
  }

  let totalCogs = Money.ZERO;
  for (const b of buckets.values()) totalCogs = totalCogs.add(b.total);

  // One COGS entry: Dr 5010/5020 … / Cr 1310/1320 … (JE-B, §4.1).
  let entry: PostedEntry | null = null;
  if (!totalCogs.isZero()) {
    const debits = [...buckets.values()]
      .filter((b) => !b.total.isZero())
      .map((b) => ({ accountCode: b.cogsCode, debit: b.total }));
    const credits = [...buckets.values()]
      .filter((b) => !b.total.isZero())
      .map((b) => ({ accountCode: b.invCode, credit: b.total }));
    entry = await postEntry(client, {
      entryDate: input.deliveredOn,
      memo: input.memo,
      sourceType: "NUPORT_ORDER",
      sourceId: input.orderId,
      eventCode: "COGS_BOM",
      postedBy: input.postedBy ?? null,
      lines: [...debits, ...credits],
    });
    await linkMovementsToEntry(
      client,
      [...buckets.values()].flatMap((b) => b.movementIds),
      entry.entryId,
    );
  }

  return { entry, totalCogs, components, bomIdBySku, negativeStockSkus };
}
