import { Money } from "@pfm/domain";
import type { PoolClient } from "pg";

export interface InventoryIntegrityReport {
  ok: boolean;
  /** Σ balances of every account used as an item's inventory account. */
  ledgerValue: Money;
  /** Σ inventory_movements.value — the subledger. */
  movementsValue: Money;
  /** Σ round(on_hand × avg_cost) — the stock cache valuation. */
  stockValue: Money;
  /** |movements − stock|: bounded rounding drift, must stay ≤ tolerance. */
  roundingDiff: Money;
  ledgerMatchesMovements: boolean;
}

/**
 * Invariant I3 (blueprint §10): three-way match for the current tenant.
 * ledger == movements must hold EXACTLY (journal amounts are written from
 * the same movement rows). movements vs stock-cache valuation may differ
 * by bounded per-item rounding (avg_cost is 6 dp, values 2 dp).
 */
export async function checkInventoryIntegrity(
  client: PoolClient,
  toleranceTaka: Money = Money.fromTaka("1"),
): Promise<InventoryIntegrityReport> {
  const ledger = await client.query<{ v: string }>(
    `SELECT COALESCE(SUM(ab.balance), 0)::NUMERIC(14,2)::text AS v
     FROM account_balances ab
     WHERE ab.account_id IN (
       SELECT DISTINCT inventory_account_id FROM items
       WHERE inventory_account_id IS NOT NULL
     )`,
  );
  const movements = await client.query<{ v: string }>(
    `SELECT COALESCE(SUM(value), 0)::NUMERIC(14,2)::text AS v
     FROM inventory_movements`,
  );
  const stock = await client.query<{ v: string }>(
    `SELECT COALESCE(SUM(round(on_hand * avg_cost, 2)), 0)::NUMERIC(14,2)::text AS v
     FROM item_stock`,
  );

  const ledgerValue = Money.fromTaka(ledger.rows[0]!.v);
  const movementsValue = Money.fromTaka(movements.rows[0]!.v);
  const stockValue = Money.fromTaka(stock.rows[0]!.v);

  const diff = movementsValue.subtract(stockValue);
  const roundingDiff = diff.isNegative() ? diff.negate() : diff;
  const ledgerMatchesMovements = ledgerValue.equals(movementsValue);
  const ok =
    ledgerMatchesMovements && roundingDiff.compare(toleranceTaka) <= 0;

  return {
    ok,
    ledgerValue,
    movementsValue,
    stockValue,
    roundingDiff,
    ledgerMatchesMovements,
  };
}
