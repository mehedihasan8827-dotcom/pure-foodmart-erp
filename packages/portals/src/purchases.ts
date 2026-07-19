import { applyPurchase, getItemBySku } from "@pfm/inventory";
import { withTransaction, type PostedEntry } from "@pfm/ledger";
import type { Money } from "@pfm/domain";
import type { Pool } from "pg";
import { PortalError, assertDate, assertPaymentAccount, writeAudit } from "./shared";

export interface RecordPurchaseInput {
  purchasedOn: string;
  supplierId?: number | null;
  invoiceRef?: string | null;
  /** Cash location code, or omit for on-credit (AP 2010). */
  paidFromAccountCode?: string | null;
  lines: { sku: string; qty: string; unitCost: string }[];
  memo?: string;
  enteredBy?: number | null;
}

export interface RecordPurchaseResult {
  purchaseId: number;
  entries: PostedEntry[];
  total: Money;
}

/**
 * Bulk asset logging (blueprint §4.3): the purchase rows, the inbound
 * MWA movements, and the Dr 1310/1320 postings all come from the same
 * lines in one transaction — book value and stock can never diverge.
 */
export async function recordPurchase(
  pool: Pool,
  tenantId: number,
  input: RecordPurchaseInput,
): Promise<RecordPurchaseResult> {
  assertDate(input.purchasedOn, "purchasedOn");
  if (input.lines.length === 0) throw new PortalError("Purchase has no lines");

  return withTransaction(pool, tenantId, async (c) => {
    const creditCode = input.paidFromAccountCode ?? "2010";
    if (creditCode !== "2010") await assertPaymentAccount(c, creditCode);

    if (input.supplierId != null) {
      const sup = await c.query("SELECT id FROM suppliers WHERE id=$1 AND is_active", [
        input.supplierId,
      ]);
      if (!sup.rows[0]) throw new PortalError(`Unknown supplier ${input.supplierId}`);
    }

    const purchase = await c.query<{ id: string }>(
      `INSERT INTO purchases
         (supplier_id, purchased_on, invoice_ref, paid_from_account_id, total_amount, entered_by)
       VALUES ($1,$2,$3,
               (SELECT id FROM accounts WHERE code=$4),
               0, $5)
       RETURNING id`,
      [
        input.supplierId ?? null,
        input.purchasedOn,
        input.invoiceRef ?? null,
        input.paidFromAccountCode ?? null,
        input.enteredBy ?? null,
      ],
    );
    const purchaseId = Number(purchase.rows[0]!.id);

    const resolved: { itemId: number; qty: string; unitCost: string }[] = [];
    for (const line of input.lines) {
      const item = await getItemBySku(c, line.sku);
      if (!item) throw new PortalError(`Unknown SKU: ${line.sku}`);
      if (item.kind === "FINISHED") {
        throw new PortalError(`${line.sku} is FINISHED — purchases book components only`);
      }
      await c.query(
        `INSERT INTO purchase_lines (purchase_id, item_id, qty, unit_cost, line_total)
         VALUES ($1,$2,$3::numeric(12,3),$4::numeric(14,6),
                 round($3::numeric * $4::numeric, 2))`,
        [purchaseId, item.id, line.qty, line.unitCost],
      );
      resolved.push({ itemId: item.id, qty: line.qty, unitCost: line.unitCost });
    }

    const applied = await applyPurchase(c, {
      purchaseId,
      purchasedOn: input.purchasedOn,
      creditAccountCode: creditCode,
      memo: input.memo ?? `Purchase #${purchaseId}${input.invoiceRef ? ` (${input.invoiceRef})` : ""}`,
      lines: resolved,
      postedBy: input.enteredBy ?? null,
    });
    await c.query(
      "UPDATE purchases SET total_amount=$2, posted_entry_id=$3 WHERE id=$1",
      [purchaseId, applied.total.toTakaString(), applied.entries[0]?.entryId ?? null],
    );
    await writeAudit(c, input.enteredBy ?? null, "PURCHASE_RECORDED", "purchases", purchaseId, {
      total: applied.total.toTakaString(),
      credit: creditCode,
      lines: input.lines.length,
    });
    return { purchaseId, entries: applied.entries, total: applied.total };
  });
}

export async function createSupplier(
  pool: Pool,
  tenantId: number,
  input: { name: string; phone?: string | null },
): Promise<{ supplierId: number }> {
  if (!input.name.trim()) throw new PortalError("Supplier name is required");
  return withTransaction(pool, tenantId, async (c) => {
    const res = await c.query<{ id: number }>(
      "INSERT INTO suppliers (name, phone) VALUES ($1,$2) RETURNING id",
      [input.name.trim(), input.phone ?? null],
    );
    return { supplierId: res.rows[0]!.id };
  });
}
