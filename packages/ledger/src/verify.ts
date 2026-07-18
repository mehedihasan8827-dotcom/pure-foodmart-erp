import { Money } from "@pfm/domain";
import type { PoolClient } from "pg";
import { GENESIS_HASH, computeEntryHash, type HashableLine } from "./hash";

export interface TrialBalance {
  totalDebit: Money;
  totalCredit: Money;
  balanced: boolean;
}

/** Invariant I1: Σ debits = Σ credits across the whole ledger. */
export async function trialBalance(client: PoolClient): Promise<TrialBalance> {
  const res = await client.query<{ d: string; c: string }>(
    `SELECT COALESCE(SUM(debit), 0)::NUMERIC(14,2)::text  AS d,
            COALESCE(SUM(credit), 0)::NUMERIC(14,2)::text AS c
     FROM journal_lines`,
  );
  const totalDebit = Money.fromTaka(res.rows[0]!.d);
  const totalCredit = Money.fromTaka(res.rows[0]!.c);
  return { totalDebit, totalCredit, balanced: totalDebit.equals(totalCredit) };
}

/** Signed balance of one account (per its normal side), from the account_balances view. */
export async function accountBalance(
  client: PoolClient,
  accountCode: string,
): Promise<Money> {
  const res = await client.query<{ balance: string }>(
    "SELECT balance::text FROM account_balances WHERE code = $1",
    [accountCode],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`Unknown account code: ${accountCode}`);
  return Money.fromTaka(row.balance);
}

export interface ChainVerification {
  ok: boolean;
  entriesChecked: number;
  brokenAtEntryNo?: number;
  reason?: string;
}

/**
 * Walk the whole hash chain (blueprint §10.3): recompute every entry hash
 * from its lines, check prev_hash linkage, and confirm the sequence head
 * matches the last entry. Any direct DB tampering breaks this walk.
 */
export async function verifyHashChain(
  client: PoolClient,
): Promise<ChainVerification> {
  const entries = await client.query<{
    id: string;
    entry_no: string;
    entry_date: string;
    entry_hash: string;
    prev_hash: string;
  }>(
    `SELECT id, entry_no, entry_date::text AS entry_date, entry_hash, prev_hash
     FROM journal_entries ORDER BY entry_no`,
  );
  const lines = await client.query<{
    entry_id: string;
    line_no: number;
    account_id: number;
    debit: string;
    credit: string;
  }>(
    `SELECT entry_id, line_no, account_id, debit::text, credit::text
     FROM journal_lines ORDER BY entry_id, line_no`,
  );
  const linesByEntry = new Map<string, HashableLine[]>();
  for (const l of lines.rows) {
    const list = linesByEntry.get(l.entry_id) ?? [];
    list.push({
      lineNo: l.line_no,
      accountId: l.account_id,
      debit: l.debit,
      credit: l.credit,
    });
    linesByEntry.set(l.entry_id, list);
  }

  let running = GENESIS_HASH;
  let expectedNo = 0;
  for (const e of entries.rows) {
    const entryNo = Number(e.entry_no);
    expectedNo += 1;
    if (entryNo !== expectedNo) {
      return fail(entryNo, `gap in entry numbering (expected ${expectedNo})`);
    }
    if (e.prev_hash !== running) {
      return fail(entryNo, "prev_hash does not match preceding entry");
    }
    const recomputed = computeEntryHash(
      running,
      entryNo,
      e.entry_date,
      linesByEntry.get(e.id) ?? [],
    );
    if (recomputed !== e.entry_hash) {
      return fail(entryNo, "entry_hash does not match recomputed content hash");
    }
    running = e.entry_hash;
  }

  const head = await client.query<{ last_entry_no: string; last_hash: string }>(
    "SELECT last_entry_no, last_hash FROM ledger_sequence",
  );
  const h = head.rows[0]!;
  if (Number(h.last_entry_no) !== expectedNo || h.last_hash !== running) {
    return fail(expectedNo, "ledger_sequence head does not match chain tail");
  }
  return { ok: true, entriesChecked: entries.rows.length };

  function fail(at: number, reason: string): ChainVerification {
    return { ok: false, entriesChecked: entries.rows.length, brokenAtEntryNo: at, reason };
  }
}
