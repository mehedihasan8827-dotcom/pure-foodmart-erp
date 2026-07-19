import { Money } from "@pfm/domain";
import type { PoolClient } from "pg";
import {
  InventoryError,
  assertQty,
  assertUnitCost,
  type MovementType,
  type QtyString,
  type UnitCostString,
} from "./types";

export interface MovementResult {
  movementId: number;
  /** Signed movement value (+ in / − out), exact NUMERIC from the DB. */
  value: Money;
  /** Unit cost applied (inbound: as given; outbound: moving average). */
  unitCost: UnitCostString;
  /** Stock on hand after the movement, NUMERIC(12,3) text. */
  onHandAfter: string;
}

interface MovementRef {
  movementType: MovementType;
  sourceType: string;
  sourceId: number;
  journalEntryId?: number | null;
}

/**
 * Inbound stock (purchase, restock, positive adjustment).
 * Moving weighted average (blueprint §5.3), computed entirely in
 * PostgreSQL NUMERIC — exact decimal, no JS floats:
 *
 *   new_avg = (on_hand·avg + qty·unit_cost) / (on_hand + qty)   [round 6dp]
 *
 * If on_hand ≤ 0 (stock was empty or driven negative), the average resets
 * to the incoming unit cost — the standard perpetual-inventory recovery.
 * Locks the item_stock row FOR UPDATE; callers with multiple items MUST
 * call in ascending item_id order (deadlock avoidance, §5.4).
 */
export async function recordInbound(
  client: PoolClient,
  itemId: number,
  qty: QtyString,
  unitCost: UnitCostString,
  ref: MovementRef,
): Promise<MovementResult> {
  assertQty(qty);
  assertUnitCost(unitCost);
  await lockStockRow(client, itemId);

  const upd = await client.query<{ on_hand: string; avg_cost: string }>(
    `UPDATE item_stock SET
       avg_cost = CASE
         WHEN on_hand <= 0 THEN $2::numeric(14,6)
         ELSE round((on_hand * avg_cost + $3::numeric * $2::numeric)
                    / (on_hand + $3::numeric), 6)
       END,
       on_hand = on_hand + $3::numeric,
       updated_at = now()
     WHERE item_id = $1
     RETURNING on_hand::text, avg_cost::text`,
    [itemId, unitCost, qty],
  );

  const mov = await client.query<{ id: string; value: string }>(
    `INSERT INTO inventory_movements
       (item_id, movement_type, qty, unit_cost, value,
        source_type, source_id, journal_entry_id)
     VALUES ($1, $2, $3::numeric(12,3), $4::numeric(14,6),
             round($3::numeric * $4::numeric, 2), $5, $6, $7)
     RETURNING id, value::text`,
    [
      itemId,
      ref.movementType,
      qty,
      unitCost,
      ref.sourceType,
      ref.sourceId,
      ref.journalEntryId ?? null,
    ],
  );

  return {
    movementId: Number(mov.rows[0]!.id),
    value: Money.fromTaka(mov.rows[0]!.value),
    unitCost,
    onHandAfter: upd.rows[0]!.on_hand,
  };
}

/**
 * Outbound stock (BOM sale deduction, shrinkage, drawing-in-kind).
 * Consumes at the CURRENT moving average and does not change it (§5.3).
 * on_hand may go negative — revenue must never be blocked; the caller
 * raises a NEG_STOCK integrity alert (§14.4).
 */
export async function recordOutbound(
  client: PoolClient,
  itemId: number,
  qty: QtyString,
  ref: MovementRef,
): Promise<MovementResult> {
  assertQty(qty);
  const stock = await lockStockRow(client, itemId);
  const avg = stock.avg_cost;

  const upd = await client.query<{ on_hand: string }>(
    `UPDATE item_stock
     SET on_hand = on_hand - $2::numeric, updated_at = now()
     WHERE item_id = $1
     RETURNING on_hand::text`,
    [itemId, qty],
  );

  const mov = await client.query<{ id: string; value: string }>(
    `INSERT INTO inventory_movements
       (item_id, movement_type, qty, unit_cost, value,
        source_type, source_id, journal_entry_id)
     VALUES ($1, $2, -($3::numeric(12,3)), $4::numeric(14,6),
             round(-($3::numeric) * $4::numeric, 2), $5, $6, $7)
     RETURNING id, value::text`,
    [
      itemId,
      ref.movementType,
      qty,
      avg,
      ref.sourceType,
      ref.sourceId,
      ref.journalEntryId ?? null,
    ],
  );

  return {
    movementId: Number(mov.rows[0]!.id),
    value: Money.fromTaka(mov.rows[0]!.value),
    unitCost: avg,
    onHandAfter: upd.rows[0]!.on_hand,
  };
}

export async function linkMovementsToEntry(
  client: PoolClient,
  movementIds: number[],
  journalEntryId: number,
): Promise<void> {
  if (movementIds.length === 0) return;
  await client.query(
    "UPDATE inventory_movements SET journal_entry_id = $2 WHERE id = ANY($1)",
    [movementIds, journalEntryId],
  );
}

async function lockStockRow(
  client: PoolClient,
  itemId: number,
): Promise<{ on_hand: string; avg_cost: string }> {
  const res = await client.query<{ on_hand: string; avg_cost: string }>(
    "SELECT on_hand::text, avg_cost::text FROM item_stock WHERE item_id = $1 FOR UPDATE",
    [itemId],
  );
  const row = res.rows[0];
  if (!row) {
    throw new InventoryError(
      `No item_stock row for item ${itemId} — FINISHED items carry no stock; components get one at creation`,
    );
  }
  return row;
}
