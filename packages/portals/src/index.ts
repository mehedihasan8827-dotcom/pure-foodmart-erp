/**
 * @pfm/portals — merchant-facing write services (blueprint B6):
 * expenses, purchases, partner equity, fixed assets + depreciation,
 * stock counts, and the §10.4 period-close engine. All tenant-scoped
 * via withTransaction/RLS; every mutation is a balanced journal entry
 * plus an audit row.
 */
export { PortalError } from "./shared";
export {
  recordExpense,
  type RecordExpenseInput,
  type RecordExpenseResult,
} from "./expenses";
export {
  createSupplier,
  recordPurchase,
  type RecordPurchaseInput,
  type RecordPurchaseResult,
} from "./purchases";
export {
  createPartner,
  recordCapitalInjection,
  recordCashDrawing,
  recordDrawingInKind,
  type CreatePartnerInput,
  type DrawingInKindInput,
  type EquityTxResult,
} from "./equity";
export {
  disposeAsset,
  registerAsset,
  runDepreciation,
  type DepreciationRunResult,
  type DisposeAssetInput,
  type DisposeAssetResult,
  type RegisterAssetInput,
} from "./assets";
export {
  recordStockCount,
  type StockCountInput,
  type StockCountResult,
} from "./stock-counts";
export {
  closePeriod,
  runCloseChecklist,
  unlockPeriod,
  type CloseChecklist,
  type CloseGate,
  type ClosePeriodResult,
} from "./close";
