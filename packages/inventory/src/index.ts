/**
 * @pfm/inventory — BOM explosion, moving weighted-average costing,
 * stock movements, and BOM-driven COGS deduction (blueprint §5).
 * Tenant-scoped transparently via RLS: run inside withTransaction(pool,
 * tenantId, …) from @pfm/ledger and every query here is isolated.
 */
export {
  createBom,
  explodeAndMerge,
  getActiveBomId,
  type BomComponentInput,
  type BomVersion,
  type ComponentRequirement,
  type CreateBomInput,
} from "./bom";
export {
  createItem,
  getItemBySku,
  type CreateItemInput,
  type Item,
} from "./items";
export {
  linkMovementsToEntry,
  recordInbound,
  recordOutbound,
  type MovementResult,
} from "./movements";
export {
  applyPurchase,
  type ApplyPurchaseInput,
  type ApplyPurchaseResult,
  type PurchaseLineInput,
} from "./purchase";
export {
  deductForSale,
  type DeductForSaleInput,
  type DeductForSaleResult,
  type DeductedComponent,
  type SaleLineInput,
} from "./sale";
export {
  InventoryError,
  NeedsBomError,
  type ItemKind,
  type MovementType,
  type QtyString,
  type UnitCostString,
} from "./types";
export {
  checkInventoryIntegrity,
  type InventoryIntegrityReport,
} from "./verify";
