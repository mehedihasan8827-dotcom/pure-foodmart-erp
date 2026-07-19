export { Money } from "./money";
export {
  canonicalNuportOrderSchema,
  nuportOrderStatusSchema,
  type CanonicalNuportOrder,
  type NuportOrderStatus,
} from "./nuport";

/**
 * Shared domain types grow here batch by batch:
 *  - B2: journal entry / posting types, event codes (blueprint §4.7)
 *  - B3: item, BOM, movement types (§5)
 *  - B4: Nuport order payload schemas (zod)
 *  - B5: Steadfast status/payout schemas (zod)
 */
export const DOMAIN_PACKAGE = "@pfm/domain";
