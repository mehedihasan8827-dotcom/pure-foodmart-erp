/**
 * Quantities are decimal strings with up to 3 dp ("5", "5.000", "0.25") —
 * matching NUMERIC(12,3). Unit costs allow up to 6 dp — NUMERIC(14,6).
 * All arithmetic on them happens in PostgreSQL NUMERIC (exact decimal),
 * never in JS floats (blueprint §5.5, §11.3).
 */
export type QtyString = string;
export type UnitCostString = string;

const QTY_PATTERN = /^\d+(\.\d{1,3})?$/;
const COST_PATTERN = /^\d+(\.\d{1,6})?$/;

export function assertQty(qty: QtyString, label = "qty"): void {
  if (!QTY_PATTERN.test(qty) || Number(qty) === 0) {
    throw new InventoryError(`Invalid ${label}: "${qty}" (positive, ≤3 dp)`);
  }
}

export function assertUnitCost(cost: UnitCostString): void {
  if (!COST_PATTERN.test(cost)) {
    throw new InventoryError(`Invalid unit cost: "${cost}" (non-negative, ≤6 dp)`);
  }
}

export type ItemKind = "RAW" | "PACKAGING" | "FINISHED";

export type MovementType =
  | "PURCHASE"
  | "SALE_BOM"
  | "RETURN_RESTOCK"
  | "ADJUSTMENT"
  | "DRAWING_KIND"
  | "SHIP_OUT"
  | "TRANSIT_TO_COGS"
  | "TRANSIT_RESTOCK";

export class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryError";
  }
}

/** Order stops in NEEDS_BOM (blueprint §14.3): revenue may post, COGS is deferred. */
export class NeedsBomError extends Error {
  constructor(readonly skusWithoutBom: string[]) {
    super(`No active BOM for SKU(s): ${skusWithoutBom.join(", ")}`);
    this.name = "NeedsBomError";
  }
}
