import { Money } from "@pfm/domain";
import type { Pool, PoolClient } from "pg";
import { computeEntryHash, type HashableLine } from "./hash";
import {
  LedgerError,
  type JournalLineInput,
  type PostEntryInput,
  type PostedEntry,
} from "./types";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface NormalizedLine {
  lineNo: number;
  accountCode: string;
  debit: Money;
  credit: Money;
  description: string | null;
}

/**
 * Post one journal entry. MUST be called inside an open transaction —
 * callers own the transaction so that revenue + COGS + inventory movements
 * commit or roll back together (blueprint P1/P5). Use withTransaction()
 * for the single-entry case.
 *
 * Serialization: locks the ledger_sequence row, which yields gapless
 * entry numbers AND a race-free hash chain. The database re-verifies
 * balance (deferred trigger), immutability, and period locks regardless
 * of anything this function does.
 */
export async function postEntry(
  client: PoolClient,
  input: PostEntryInput,
): Promise<PostedEntry> {
  const lines = normalizeAndValidate(input);
  if (!DATE_PATTERN.test(input.entryDate)) {
    throw new LedgerError(
      `entryDate must be 'YYYY-MM-DD', got "${input.entryDate}"`,
    );
  }
  const period = input.entryDate.slice(0, 7);

  const accountIdByCode = await resolveAccounts(
    client,
    lines.map((l) => l.accountCode),
  );

  // Serialization point: gapless numbering + hash-chain head.
  const seq = await client.query<{ last_entry_no: string; last_hash: string }>(
    "SELECT last_entry_no, last_hash FROM ledger_sequence FOR UPDATE",
  );
  const seqRow = seq.rows[0];
  if (!seqRow) throw new LedgerError("ledger_sequence row missing");
  const entryNo = Number(seqRow.last_entry_no) + 1;
  const prevHash = seqRow.last_hash;

  const hashable: HashableLine[] = lines.map((l) => ({
    lineNo: l.lineNo,
    accountId: mustGet(accountIdByCode, l.accountCode),
    debit: l.debit.toTakaString(),
    credit: l.credit.toTakaString(),
  }));
  const entryHash = computeEntryHash(prevHash, entryNo, input.entryDate, hashable);

  const entryRes = await client.query<{ id: string }>(
    `INSERT INTO journal_entries
       (entry_no, entry_date, period, memo, source_type, source_id,
        event_code, reversal_of, posted_by, entry_hash, prev_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id`,
    [
      entryNo,
      input.entryDate,
      period,
      input.memo,
      input.sourceType,
      input.sourceId ?? null,
      input.eventCode,
      input.reversalOf ?? null,
      input.postedBy ?? null,
      entryHash,
      prevHash,
    ],
  );
  const entryId = Number(entryRes.rows[0]!.id);

  const values: string[] = [];
  const params: unknown[] = [];
  lines.forEach((l, i) => {
    const base = i * 5;
    values.push(
      `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`,
    );
    params.push(
      entryId,
      l.lineNo,
      mustGet(accountIdByCode, l.accountCode),
      l.debit.toTakaString(),
      l.credit.toTakaString(),
    );
  });
  await client.query(
    `INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit)
     VALUES ${values.join(",")}`,
    params,
  );

  await client.query(
    "UPDATE ledger_sequence SET last_entry_no = $1, last_hash = $2",
    [entryNo, entryHash],
  );

  return { entryId, entryNo, period, entryHash };
}

/**
 * Run fn inside BEGIN/COMMIT with rollback on failure, with the tenant
 * context set for the whole transaction. Every RLS policy and every
 * tenant_id column default reads this context — queries inside fn are
 * automatically scoped to (and stamped with) this tenant, and rows of
 * other tenants are invisible and un-writable.
 */
export async function withTransaction<T>(
  pool: Pool,
  tenantId: number,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new LedgerError(`Invalid tenantId: ${tenantId}`);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [
      String(tenantId),
    ]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection-level failure; original error matters more */
    }
    throw err;
  } finally {
    client.release();
  }
}

function normalizeAndValidate(input: PostEntryInput): NormalizedLine[] {
  if (input.lines.length < 2) {
    throw new LedgerError("A journal entry needs at least 2 lines");
  }
  let totalDebit = Money.ZERO;
  let totalCredit = Money.ZERO;
  const normalized = input.lines.map((line, i) =>
    normalizeLine(line, i + 1),
  );
  for (const l of normalized) {
    totalDebit = totalDebit.add(l.debit);
    totalCredit = totalCredit.add(l.credit);
  }
  if (!totalDebit.equals(totalCredit)) {
    throw new LedgerError(
      `Unbalanced entry: debits ${totalDebit.toTakaString()} != credits ${totalCredit.toTakaString()}`,
    );
  }
  if (totalDebit.isZero()) {
    throw new LedgerError("Entry total must be non-zero");
  }
  return normalized;
}

function normalizeLine(line: JournalLineInput, lineNo: number): NormalizedLine {
  const hasDebit = line.debit !== undefined && !line.debit.isZero();
  const hasCredit = line.credit !== undefined && !line.credit.isZero();
  if (hasDebit === hasCredit) {
    throw new LedgerError(
      `Line ${lineNo} (${line.accountCode}): exactly one of debit/credit must be set and non-zero`,
    );
  }
  const amount = hasDebit ? line.debit! : line.credit!;
  if (amount.isNegative()) {
    throw new LedgerError(
      `Line ${lineNo} (${line.accountCode}): amounts must be positive; use the opposite side instead`,
    );
  }
  return {
    lineNo,
    accountCode: line.accountCode,
    debit: hasDebit ? amount : Money.ZERO,
    credit: hasCredit ? amount : Money.ZERO,
    description: line.description ?? null,
  };
}

async function resolveAccounts(
  client: PoolClient,
  codes: string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(codes)];
  const res = await client.query<{ id: number; code: string; is_active: boolean }>(
    "SELECT id, code, is_active FROM accounts WHERE code = ANY($1)",
    [unique],
  );
  const map = new Map(res.rows.map((r) => [r.code, r]));
  for (const code of unique) {
    const row = map.get(code);
    if (!row) throw new LedgerError(`Unknown account code: ${code}`);
    if (!row.is_active) throw new LedgerError(`Account ${code} is inactive`);
  }
  return new Map(res.rows.map((r) => [r.code, r.id]));
}

function mustGet<K, V>(map: Map<K, V>, key: K): V {
  const v = map.get(key);
  if (v === undefined) throw new LedgerError(`Internal: missing key ${String(key)}`);
  return v;
}
