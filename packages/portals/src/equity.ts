import { Money } from "@pfm/domain";
import { getItemBySku, linkMovementsToEntry, recordOutbound } from "@pfm/inventory";
import { postEntry, withTransaction, type PostedEntry } from "@pfm/ledger";
import type { Pool, PoolClient } from "pg";
import {
  PortalError,
  assertDate,
  assertPaymentAccount,
  getAccount,
  writeAudit,
} from "./shared";

export interface CreatePartnerInput {
  name: string;
  capitalAccountCode: string; // e.g. '3010'
  drawingsAccountCode: string; // e.g. '3110'
  sharePct: string; // "50", "33.333"
  validFrom: string;
}

export async function createPartner(
  pool: Pool,
  tenantId: number,
  input: CreatePartnerInput,
): Promise<{ partnerId: number }> {
  if (!input.name.trim()) throw new PortalError("Partner name is required");
  assertDate(input.validFrom, "validFrom");
  return withTransaction(pool, tenantId, async (c) => {
    const capital = await getAccount(c, input.capitalAccountCode);
    const drawings = await getAccount(c, input.drawingsAccountCode);
    if (capital.type !== "EQUITY" || drawings.type !== "EQUITY") {
      throw new PortalError("Capital and drawings accounts must be EQUITY accounts");
    }
    // Personalize the seeded generic account names.
    await c.query("UPDATE accounts SET name=$2 WHERE id=$1", [
      capital.id, `Partner Capital — ${input.name.trim()}`,
    ]);
    await c.query("UPDATE accounts SET name=$2 WHERE id=$1", [
      drawings.id, `Partner Drawings — ${input.name.trim()}`,
    ]);
    const partner = await c.query<{ id: number }>(
      `INSERT INTO partners (name, capital_account_id, drawings_account_id)
       VALUES ($1,$2,$3) RETURNING id`,
      [input.name.trim(), capital.id, drawings.id],
    );
    const partnerId = partner.rows[0]!.id;
    await c.query(
      `INSERT INTO partner_share_versions (partner_id, share_pct, valid_from)
       VALUES ($1,$2::numeric(6,3),$3)`,
      [partnerId, input.sharePct, input.validFrom],
    );
    return { partnerId };
  });
}

interface EquityCashInput {
  partnerId: number;
  amount: string;
  txDate: string;
  /** Cash location the money moves through. */
  cashAccountCode: string;
  notes?: string | null;
  enteredBy?: number | null;
}

export interface EquityTxResult {
  equityTransactionId: number;
  entry: PostedEntry;
}

/** §4.5: Dr cash / Cr partner capital. */
export async function recordCapitalInjection(
  pool: Pool,
  tenantId: number,
  input: EquityCashInput,
): Promise<EquityTxResult> {
  return equityCashTx(pool, tenantId, input, "CAPITAL_IN");
}

/** §4.5: Dr partner drawings / Cr cash. */
export async function recordCashDrawing(
  pool: Pool,
  tenantId: number,
  input: EquityCashInput,
): Promise<EquityTxResult> {
  return equityCashTx(pool, tenantId, input, "DRAWING_CASH");
}

async function equityCashTx(
  pool: Pool,
  tenantId: number,
  input: EquityCashInput,
  kind: "CAPITAL_IN" | "DRAWING_CASH",
): Promise<EquityTxResult> {
  assertDate(input.txDate, "txDate");
  const amount = Money.fromTaka(input.amount);
  if (amount.isZero() || amount.isNegative()) {
    throw new PortalError("Amount must be positive");
  }
  return withTransaction(pool, tenantId, async (c) => {
    const partner = await loadPartner(c, input.partnerId);
    const cash = await assertPaymentAccount(c, input.cashAccountCode);
    const tx = await insertEquityTx(c, input.partnerId, kind, amount, input.txDate, cash.id, input);
    const entry = await postEntry(c, {
      entryDate: input.txDate,
      memo:
        kind === "CAPITAL_IN"
          ? `Capital injection — ${partner.name}`
          : `Drawing — ${partner.name}`,
      sourceType: "EQUITY",
      sourceId: tx,
      eventCode: kind,
      postedBy: input.enteredBy ?? null,
      lines:
        kind === "CAPITAL_IN"
          ? [
              { accountCode: cash.code, debit: amount },
              { accountCode: partner.capitalCode, credit: amount },
            ]
          : [
              { accountCode: partner.drawingsCode, debit: amount },
              { accountCode: cash.code, credit: amount },
            ],
    });
    await c.query("UPDATE equity_transactions SET posted_entry_id=$2 WHERE id=$1", [tx, entry.entryId]);
    await writeAudit(c, input.enteredBy ?? null, kind, "equity_transactions", tx, {
      partner: partner.name, amount: amount.toTakaString(),
    });
    return { equityTransactionId: tx, entry };
  });
}

export interface DrawingInKindInput {
  partnerId: number;
  txDate: string;
  /** Component SKUs taken at BOM cost (moving average). */
  lines: { sku: string; qty: string }[];
  notes?: string | null;
  enteredBy?: number | null;
}

/** §4.5: Dr drawings (at current avg cost) / Cr 1310/1320, with stock deducted. */
export async function recordDrawingInKind(
  pool: Pool,
  tenantId: number,
  input: DrawingInKindInput,
): Promise<EquityTxResult & { total: Money }> {
  assertDate(input.txDate, "txDate");
  if (input.lines.length === 0) throw new PortalError("Drawing has no lines");
  return withTransaction(pool, tenantId, async (c) => {
    const partner = await loadPartner(c, input.partnerId);
    const tx = await insertEquityTx(c, input.partnerId, "DRAWING_KIND", Money.fromTaka("0.01"), input.txDate, null, input);

    // Deduct stock at moving average; group value per inventory account.
    const items: { itemId: number; sku: string; qty: string; invCode: string }[] = [];
    for (const line of input.lines) {
      const item = await getItemBySku(c, line.sku);
      if (!item) throw new PortalError(`Unknown SKU: ${line.sku}`);
      if (item.kind === "FINISHED") {
        throw new PortalError(`${line.sku} is FINISHED — draw components at cost`);
      }
      const inv = await c.query<{ code: string }>(
        `SELECT a.code FROM items i JOIN accounts a ON a.id=i.inventory_account_id WHERE i.id=$1`,
        [item.id],
      );
      items.push({ itemId: item.id, sku: line.sku, qty: line.qty, invCode: inv.rows[0]!.code });
    }
    items.sort((a, b) => a.itemId - b.itemId); // lock order (§5.4)

    let total = Money.ZERO;
    const movementIds: number[] = [];
    const byInv = new Map<string, Money>();
    for (const it of items) {
      const res = await recordOutbound(c, it.itemId, it.qty, {
        movementType: "DRAWING_KIND",
        sourceType: "EQUITY",
        sourceId: tx,
      });
      const value = res.value.negate();
      total = total.add(value);
      movementIds.push(res.movementId);
      byInv.set(it.invCode, (byInv.get(it.invCode) ?? Money.ZERO).add(value));
    }
    if (total.isZero()) throw new PortalError("Drawing value is zero — nothing to post");

    const entry = await postEntry(c, {
      entryDate: input.txDate,
      memo: `Drawing in kind — ${partner.name}`,
      sourceType: "EQUITY",
      sourceId: tx,
      eventCode: "DRAWING_KIND",
      postedBy: input.enteredBy ?? null,
      lines: [
        { accountCode: partner.drawingsCode, debit: total },
        ...[...byInv.entries()]
          .filter(([, v]) => !v.isZero())
          .map(([code, v]) => ({ accountCode: code, credit: v })),
      ],
    });
    await linkMovementsToEntry(c, movementIds, entry.entryId);
    await c.query(
      "UPDATE equity_transactions SET amount=$2, posted_entry_id=$3 WHERE id=$1",
      [tx, total.toTakaString(), entry.entryId],
    );
    await writeAudit(c, input.enteredBy ?? null, "DRAWING_KIND", "equity_transactions", tx, {
      partner: partner.name, total: total.toTakaString(),
    });
    return { equityTransactionId: tx, entry, total };
  });
}

async function loadPartner(c: PoolClient, partnerId: number) {
  const res = await c.query<{
    id: number;
    name: string;
    capital_code: string;
    drawings_code: string;
  }>(
    `SELECT p.id, p.name, ca.code AS capital_code, da.code AS drawings_code
     FROM partners p
     JOIN accounts ca ON ca.id = p.capital_account_id
     JOIN accounts da ON da.id = p.drawings_account_id
     WHERE p.id = $1 AND p.is_active`,
    [partnerId],
  );
  const row = res.rows[0];
  if (!row) throw new PortalError(`Unknown partner ${partnerId}`);
  return {
    id: row.id,
    name: row.name,
    capitalCode: row.capital_code,
    drawingsCode: row.drawings_code,
  };
}

async function insertEquityTx(
  c: PoolClient,
  partnerId: number,
  kind: string,
  amount: Money,
  txDate: string,
  counterAccountId: number | null,
  input: { notes?: string | null; enteredBy?: number | null },
): Promise<number> {
  const res = await c.query<{ id: string }>(
    `INSERT INTO equity_transactions
       (partner_id, kind, amount, tx_date, counter_account_id, notes, entered_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      partnerId, kind, amount.toTakaString(), txDate,
      counterAccountId, input.notes ?? null, input.enteredBy ?? null,
    ],
  );
  return Number(res.rows[0]!.id);
}
