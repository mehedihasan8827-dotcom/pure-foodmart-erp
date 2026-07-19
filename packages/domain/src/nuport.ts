import { z } from "zod";

/**
 * Canonical Nuport order — the ONE shape the whole platform processes.
 * Webhook payloads and cron pulls are mapped into this by @pfm/nuport-client
 * (field mapping is finalized against the real API in Phase 0 discovery);
 * everything downstream (ingestion log, state machine, posting) depends
 * only on this schema, never on raw Nuport JSON.
 *
 * Money fields are 2-dp decimal strings (numbers are stringified and
 * validated — float noise is rejected). productAmount is NET of discounts.
 */

const moneyString = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((v) => /^-?\d+(\.\d{1,2})?$/.test(v), "invalid money amount");

const qtyString = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine((v) => /^\d+(\.\d{1,3})?$/.test(v) && Number(v) > 0, "invalid qty");

export const nuportOrderStatusSchema = z.enum([
  "pending",
  "confirmed",
  "shipped",
  "delivered",
  "cancelled",
  "returned",
]);

export const canonicalNuportOrderSchema = z.object({
  orderRef: z.string().min(1),
  wooRef: z.string().optional(),
  consignmentId: z.string().optional(),
  status: nuportOrderStatusSchema,
  paymentMode: z.enum(["COD", "BKASH", "NAGAD", "BANK", "CARD", "OTHER"]),
  productAmount: moneyString,
  deliveryCharge: moneyString.default("0"),
  discountAmount: moneyString.default("0"),
  codAmount: moneyString.default("0"),
  orderedAt: z.string().datetime({ offset: true }).optional(),
  deliveredAt: z.string().datetime({ offset: true }).optional(),
  lines: z
    .array(
      z.object({
        sku: z.string().min(1),
        qty: qtyString,
        unitPrice: moneyString,
        lineTotal: moneyString,
      }),
    )
    .min(1),
});

export type CanonicalNuportOrder = z.infer<typeof canonicalNuportOrderSchema>;
export type NuportOrderStatus = z.infer<typeof nuportOrderStatusSchema>;
