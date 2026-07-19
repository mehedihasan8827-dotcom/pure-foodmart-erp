import { z } from "zod";

/**
 * Canonical Steadfast shapes (blueprint §2.3). Raw API/CSV payloads are
 * mapped into these by @pfm/steadfast-client and the CSV fallback parser;
 * the settlement engine consumes ONLY these.
 */

/** Canonical delivery status — collapsed from Steadfast's raw status set. */
export const steadfastDeliveryStatusSchema = z.enum([
  "IN_TRANSIT", // pending / hold / in_review
  "DELIVERED", // delivered, delivered_approval_pending
  "PARTIAL", // partial_delivered* — manual review (§14.7)
  "CANCELLED", // cancelled*, i.e. RTO
  "UNKNOWN",
]);
export type SteadfastDeliveryStatus = z.infer<
  typeof steadfastDeliveryStatusSchema
>;

export const canonicalSteadfastStatusSchema = z.object({
  consignmentId: z.string().min(1),
  status: steadfastDeliveryStatusSchema,
  rawStatus: z.string(),
  checkedAt: z.string().datetime({ offset: true }),
});
export type CanonicalSteadfastStatus = z.infer<
  typeof canonicalSteadfastStatusSchema
>;

const moneyString = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((v) => /^-?\d+(\.\d{1,2})?$/.test(v), "invalid money amount");

export const payoutInvoiceLineSchema = z.object({
  consignmentId: z.string().min(1),
  orderRef: z.string().optional(),
  codCollected: moneyString,
  courierCharge: moneyString.default("0"),
});

export const canonicalPayoutInvoiceSchema = z.object({
  invoiceRef: z.string().min(1),
  statementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** '1020' bank or '1030' bKash — where Steadfast pays this merchant. */
  payoutAccountCode: z.enum(["1020", "1030"]).default("1020"),
  lines: z.array(payoutInvoiceLineSchema).min(1),
});
export type CanonicalPayoutInvoice = z.infer<
  typeof canonicalPayoutInvoiceSchema
>;
export type PayoutInvoiceLine = z.infer<typeof payoutInvoiceLineSchema>;
