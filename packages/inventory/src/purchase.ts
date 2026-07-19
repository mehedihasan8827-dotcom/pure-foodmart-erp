import { Money } from "@pfm/domain";
import { postEntry, type PostedEntry } from "@pfm/ledger";
import type { PoolClient } from "pg";
import { linkMovementsToEntry, recordInbound } from "./movements";
import { InventoryError, type QtyString, type UnitCostString } from "./types";

export interface PurchaseLineInput {
  itemId: number;
  qty: QtyString;
  unitCost: UnitCostString;
}

export interface ApplyPurchaseInput {
  purchaseId: number;
  purchasedOn: string; // YYYY-MM-DD
  /** Credit side: cash/bank/bKash code, or '2010' for on-credit (AP). */
  creditAccountCode: string;
  lines: PurchaseLineInput[];
  memo: string;
  postedBy?: number | null;
}

export interface ApplyPurchaseResult {
  entries: PostedEntry[];
  total: Money;
}

/**
 * Book a bulk purchase as Current Assets (blueprint §4.3): inbound
 * movements update the moving average, and one journal entry per
 * inventory kind posts Dr 1310/1320 / Cr cash-bank-AP — movement values
 * and journal amounts come from the same rows, so they agree to the poisha.
 * Call inside a transaction (the caller owns commit/rollback).
 */
export async function applyPurchase(
  client: PoolClient,
  input: ApplyPurchaseInput,
): Promise<ApplyPurchaseResult> {
  if (input.lines.length === 0) {
    throw new InventoryError("Purchase has no lines");
  }

  // Resolve account mappings; enforce components only.
  const ids = input.lines.map((l) => l.itemId);
  const meta = await client.query<{
    id: number;
    kind: string;
    inv_code: string | null;
  }>(
    `SELECT i.id, i.kind, inv.code AS inv_code
     FROM items i LEFT JOIN accounts inv ON inv.id = i.inventory_account_id
     WHERE i.id = ANY($1)`,
    [ids],
  );
  const metaById = new Map(meta.rows.map((r) => [r.id, r]));
  for (const l of input.lines) {
    const m = metaById.get(l.itemId);
    if (!m) throw new InventoryError(`Unknown item id ${l.itemId}`);
    if (m.kind === "FINISHED" || !m.inv_code) {
      throw new InventoryError(
        `Item ${l.itemId} is FINISHED — purchases book components only`,
      );
    }
  }

  // Ascending item_id lock order (§5.4).
  const sorted = [...input.lines].sort((a, b) => a.itemId - b.itemId);

  const movementsByInvCode = new Map<string, { ids: number[]; total: Money }>();
  for (const line of sorted) {
    const res = await recordInbound(client, line.itemId, line.qty, line.unitCost, {
      movementType: "PURCHASE",
      sourceType: "PURCHASE",
      sourceId: input.purchaseId,
    });
    const invCode = metaById.get(line.itemId)!.inv_code!;
    const bucket =
      movementsByInvCode.get(invCode) ?? { ids: [], total: Money.ZERO };
    bucket.ids.push(res.movementId);
    bucket.total = bucket.total.add(res.value);
    movementsByInvCode.set(invCode, bucket);
  }

  // One entry per inventory account, matching the seeded rule matrix.
  const entries: PostedEntry[] = [];
  let grandTotal = Money.ZERO;
  for (const [invCode, bucket] of movementsByInvCode) {
    grandTotal = grandTotal.add(bucket.total);
    if (bucket.total.isZero()) continue;
    const entry = await postEntry(client, {
      entryDate: input.purchasedOn,
      memo: input.memo,
      sourceType: "PURCHASE",
      sourceId: input.purchaseId,
      eventCode: invCode === "1320" ? "PURCHASE_PACKAGING" : "PURCHASE_RAW",
      postedBy: input.postedBy ?? null,
      lines: [
        { accountCode: invCode, debit: bucket.total },
        { accountCode: input.creditAccountCode, credit: bucket.total },
      ],
    });
    await linkMovementsToEntry(client, bucket.ids, entry.entryId);
    entries.push(entry);
  }
  return { entries, total: grandTotal };
}
