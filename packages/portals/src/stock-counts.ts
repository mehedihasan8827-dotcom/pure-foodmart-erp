import { Money } from "@pfm/domain";
import {
  getItemBySku,
  linkMovementsToEntry,
  recordInbound,
  recordOutbound,
} from "@pfm/inventory";
import { postEntry, withTransaction, type PostedEntry } from "@pfm/ledger";
import type { Pool } from "pg";
import { PortalError, assertDate, writeAudit } from "./shared";

export interface StockCountInput {
  countedOn: string;
  lines: { sku: string; countedQty: string }[];
  notes?: string | null;
  countedBy?: number | null;
}

export interface StockCountResult {
  stockCountId: number;
  entry: PostedEntry | null; // null when zero variance
  varianceValue: Money; // net: + book gain / − shrinkage
  lines: { sku: string; bookQty: string; countedQty: string; variance: string }[];
}

/**
 * Monthly physical count (blueprint §5.7): variance vs book becomes an
 * adjustment movement per item plus one SHRINKAGE entry — losses
 * Dr 5090 / Cr inventory, overages the reverse. The count is a permanent
 * record either way.
 */
export async function recordStockCount(
  pool: Pool,
  tenantId: number,
  input: StockCountInput,
): Promise<StockCountResult> {
  assertDate(input.countedOn, "countedOn");
  if (input.lines.length === 0) throw new PortalError("Count has no lines");
  return withTransaction(pool, tenantId, async (c) => {
    const count = await c.query<{ id: number }>(
      "INSERT INTO stock_counts (counted_on, counted_by, notes) VALUES ($1,$2,$3) RETURNING id",
      [input.countedOn, input.countedBy ?? null, input.notes ?? null],
    );
    const stockCountId = count.rows[0]!.id;

    const resolved: {
      itemId: number; sku: string; invCode: string;
      bookQty: string; countedQty: string; variance: string;
    }[] = [];
    for (const line of input.lines) {
      const item = await getItemBySku(c, line.sku);
      if (!item) throw new PortalError(`Unknown SKU: ${line.sku}`);
      if (item.kind === "FINISHED") {
        throw new PortalError(`${line.sku} is FINISHED — counts cover components`);
      }
      const stock = await c.query<{ on_hand: string; inv_code: string; diff: string }>(
        `SELECT s.on_hand::text, a.code AS inv_code,
                ($2::numeric(12,3) - s.on_hand)::numeric(12,3)::text AS diff
         FROM item_stock s
         JOIN items i ON i.id = s.item_id
         JOIN accounts a ON a.id = i.inventory_account_id
         WHERE s.item_id = $1`,
        [item.id, line.countedQty],
      );
      const row = stock.rows[0]!;
      resolved.push({
        itemId: item.id, sku: line.sku, invCode: row.inv_code,
        bookQty: row.on_hand, countedQty: line.countedQty, variance: row.diff,
      });
      await c.query(
        `INSERT INTO stock_count_lines (stock_count_id, item_id, book_qty, counted_qty)
         VALUES ($1,$2,$3::numeric(12,3),$4::numeric(12,3))`,
        [stockCountId, item.id, row.on_hand, line.countedQty],
      );
    }

    resolved.sort((a, b) => a.itemId - b.itemId); // lock order
    const movementIds: number[] = [];
    const lossByInv = new Map<string, Money>();
    const gainByInv = new Map<string, Money>();
    let net = Money.ZERO;
    for (const r of resolved) {
      const v = Number(r.variance);
      if (v === 0) continue;
      if (v < 0) {
        const res = await recordOutbound(c, r.itemId, r.variance.replace("-", ""), {
          movementType: "ADJUSTMENT", sourceType: "STOCK_COUNT", sourceId: stockCountId,
        });
        const loss = res.value.negate();
        lossByInv.set(r.invCode, (lossByInv.get(r.invCode) ?? Money.ZERO).add(loss));
        net = net.subtract(loss);
        movementIds.push(res.movementId);
      } else {
        // Overage restocks at current average cost.
        const avg = await c.query<{ avg_cost: string }>(
          "SELECT avg_cost::text FROM item_stock WHERE item_id=$1", [r.itemId],
        );
        const res = await recordInbound(c, r.itemId, r.variance, avg.rows[0]!.avg_cost, {
          movementType: "ADJUSTMENT", sourceType: "STOCK_COUNT", sourceId: stockCountId,
        });
        gainByInv.set(r.invCode, (gainByInv.get(r.invCode) ?? Money.ZERO).add(res.value));
        net = net.add(res.value);
        movementIds.push(res.movementId);
      }
    }

    let entry: PostedEntry | null = null;
    const totalLoss = [...lossByInv.values()].reduce((a, v) => a.add(v), Money.ZERO);
    const totalGain = [...gainByInv.values()].reduce((a, v) => a.add(v), Money.ZERO);
    if (!totalLoss.isZero() || !totalGain.isZero()) {
      entry = await postEntry(c, {
        entryDate: input.countedOn,
        memo: `Stock count #${stockCountId} adjustment`,
        sourceType: "STOCK_COUNT",
        sourceId: stockCountId,
        eventCode: "SHRINKAGE",
        postedBy: input.countedBy ?? null,
        lines: [
          // losses: Dr shrinkage / Cr inventory
          ...(totalLoss.isZero() ? [] : [{ accountCode: "5090", debit: totalLoss }]),
          ...[...lossByInv.entries()]
            .filter(([, v]) => !v.isZero())
            .map(([code, v]) => ({ accountCode: code, credit: v })),
          // overages: Dr inventory / Cr shrinkage
          ...[...gainByInv.entries()]
            .filter(([, v]) => !v.isZero())
            .map(([code, v]) => ({ accountCode: code, debit: v })),
          ...(totalGain.isZero() ? [] : [{ accountCode: "5090", credit: totalGain }]),
        ],
      });
      await linkMovementsToEntry(c, movementIds, entry.entryId);
      await c.query("UPDATE stock_counts SET posted_entry_id=$2 WHERE id=$1", [
        stockCountId, entry.entryId,
      ]);
    }
    await writeAudit(c, input.countedBy ?? null, "STOCK_COUNT", "stock_counts", stockCountId, {
      net: net.toTakaString(), lines: resolved.length,
    });
    return {
      stockCountId,
      entry,
      varianceValue: net,
      lines: resolved.map((r) => ({
        sku: r.sku, bookQty: r.bookQty, countedQty: r.countedQty, variance: r.variance,
      })),
    };
  });
}
