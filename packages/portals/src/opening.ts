import { Money } from "@pfm/domain";
import {
  getItemBySku,
  linkMovementsToEntry,
  recordInbound,
} from "@pfm/inventory";
import { postEntry, withTransaction, type PostedEntry } from "@pfm/ledger";
import type { Pool } from "pg";
import { PortalError, assertDate, getAccount, writeAudit } from "./shared";

export interface OpeningBalanceLine {
  accountCode: string;
  amount: string;
  side: "DEBIT" | "CREDIT";
}

export interface OpeningStockLine {
  sku: string; // RAW/PACKAGING item
  qty: string;
  unitCost: string;
}

export interface OpeningBalancesInput {
  asOf: string; // YYYY-MM-DD — the genesis date (blueprint §16 GO)
  lines: OpeningBalanceLine[];
  /** Physical stock at known cost — inventory Dr lines are derived from
   *  the SAME movements that set on-hand/avg-cost, so I3 holds from day 0. */
  stockLines?: OpeningStockLine[];
  /** The residual plugs to partner capital per §16 (default 3010). */
  plugAccountCode?: string;
  enteredBy?: number | null;
}

export interface OpeningBalancesResult {
  entry: PostedEntry;
  plugged: Money; // signed: + credited to plug / − debited
}

/**
 * The go-live genesis entry (blueprint §16): counted cash/bank/bKash,
 * courier dues, stock at cost, fixed assets at net book value — with the
 * residual plugged to partner capital. One balanced entry, hash-chain
 * root for the tenant. Refuses to run on a tenant that already has
 * journal entries: opening balances are a once-only event.
 */
export async function postOpeningBalances(
  pool: Pool,
  tenantId: number,
  input: OpeningBalancesInput,
): Promise<OpeningBalancesResult> {
  assertDate(input.asOf, "asOf");
  if (input.lines.length === 0 && (input.stockLines?.length ?? 0) === 0) {
    throw new PortalError("Opening balances need at least one line");
  }
  return withTransaction(pool, tenantId, async (c) => {
    const existing = await c.query<{ n: string }>(
      "SELECT count(*) AS n FROM journal_entries",
    );
    if (Number(existing.rows[0]!.n) > 0) {
      throw new PortalError(
        "This tenant already has journal entries — opening balances are once-only",
      );
    }

    const entryLines: {
      accountCode: string;
      debit?: Money;
      credit?: Money;
    }[] = [];
    let net = Money.ZERO; // debits − credits, before the plug

    for (const line of input.lines) {
      await getAccount(c, line.accountCode); // validates existence/active
      const amount = Money.fromTaka(line.amount);
      if (amount.isZero() || amount.isNegative()) {
        throw new PortalError(`${line.accountCode}: amount must be positive`);
      }
      if (line.side === "DEBIT") {
        entryLines.push({ accountCode: line.accountCode, debit: amount });
        net = net.add(amount);
      } else {
        entryLines.push({ accountCode: line.accountCode, credit: amount });
        net = net.subtract(amount);
      }
    }

    // Opening stock: inbound movements first, inventory Dr lines derived
    // from the movement values themselves.
    const movementIds: number[] = [];
    const invTotals = new Map<string, Money>();
    const stock = [...(input.stockLines ?? [])];
    if (stock.length > 0) {
      const resolved: { itemId: number; qty: string; unitCost: string; invCode: string }[] = [];
      for (const s of stock) {
        const item = await getItemBySku(c, s.sku);
        if (!item) throw new PortalError(`Unknown SKU: ${s.sku}`);
        if (item.kind === "FINISHED") {
          throw new PortalError(`${s.sku} is FINISHED — opening stock covers components`);
        }
        const inv = await c.query<{ code: string }>(
          "SELECT a.code FROM items i JOIN accounts a ON a.id=i.inventory_account_id WHERE i.id=$1",
          [item.id],
        );
        resolved.push({ itemId: item.id, qty: s.qty, unitCost: s.unitCost, invCode: inv.rows[0]!.code });
      }
      resolved.sort((a, b) => a.itemId - b.itemId);
      for (const r of resolved) {
        const res = await recordInbound(c, r.itemId, r.qty, r.unitCost, {
          movementType: "ADJUSTMENT",
          sourceType: "CLOSING",
          sourceId: 0,
        });
        movementIds.push(res.movementId);
        invTotals.set(r.invCode, (invTotals.get(r.invCode) ?? Money.ZERO).add(res.value));
      }
      for (const [code, total] of invTotals) {
        if (total.isZero()) continue;
        entryLines.push({ accountCode: code, debit: total });
        net = net.add(total);
      }
    }

    // Plug the residual to capital: net debits > credits → Cr plug.
    const plugCode = input.plugAccountCode ?? "3010";
    const plugAcct = await getAccount(c, plugCode);
    if (plugAcct.type !== "EQUITY") {
      throw new PortalError(`Plug account ${plugCode} must be EQUITY`);
    }
    if (!net.isZero()) {
      entryLines.push(
        net.isNegative()
          ? { accountCode: plugCode, debit: net.negate() }
          : { accountCode: plugCode, credit: net },
      );
    }

    const entry = await postEntry(c, {
      entryDate: input.asOf,
      memo: `Opening balances as of ${input.asOf}`,
      sourceType: "CLOSING",
      sourceId: null,
      eventCode: "OPENING_BALANCE",
      postedBy: input.enteredBy ?? null,
      lines: entryLines,
    });
    await linkMovementsToEntry(c, movementIds, entry.entryId);
    await writeAudit(c, input.enteredBy ?? null, "OPENING_BALANCES", "journal_entries", entry.entryId, {
      asOf: input.asOf,
      plugged: net.toTakaString(),
      lines: entryLines.length,
    });
    return { entry, plugged: net };
  });
}
