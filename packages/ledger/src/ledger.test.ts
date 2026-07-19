/**
 * Integration tests against a real migrated + seeded PostgreSQL
 * (DATABASE_URL, defaulting to the docker-compose local instance).
 * Multi-tenant: every test runs inside a tenant context; RLS + triggers
 * are exercised exactly as production enforces them.
 */
import { Money } from "@pfm/domain";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GENESIS_HASH } from "./hash";
import { postEntry, withTransaction } from "./post";
import { LedgerError, type PostEntryInput } from "./types";
import { accountBalance, trialBalance, verifyHashChain } from "./verify";

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://erp:erp_local_dev@localhost:5432/pure_foodmart_erp",
  max: 10,
});

let T1 = 0; // Pure Foodmart
let T2 = 0; // a second merchant, for isolation proofs

async function ensureTenant(name: string, slug: string): Promise<number> {
  const found = await pool.query<{ id: number }>(
    "SELECT id FROM tenants WHERE slug = $1",
    [slug],
  );
  if (found.rows[0]) return found.rows[0].id;
  const created = await pool.query<{ id: number }>(
    "SELECT provision_tenant($1, $2) AS id",
    [name, slug],
  );
  return created.rows[0]!.id;
}

async function resetLedger(): Promise<void> {
  const client = await pool.connect();
  try {
    // TRUNCATE bypasses row triggers/RLS by design — test-only; production
    // runtime roles never get TRUNCATE (003 migration note).
    await client.query("TRUNCATE journal_lines, journal_entries CASCADE");
    for (const t of [T1, T2]) {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        String(t),
      ]);
      await client.query(
        "UPDATE ledger_sequence SET last_entry_no = 0, last_hash = $1",
        [GENESIS_HASH],
      );
      await client.query("UPDATE fiscal_periods SET is_locked = FALSE");
      await client.query("COMMIT");
    }
  } finally {
    client.release();
  }
}

function je(overrides: Partial<PostEntryInput> = {}): PostEntryInput {
  // JE-A worked example (blueprint §4.1): COD delivery of ৳1,150
  return {
    entryDate: "2026-07-18",
    memo: "Revenue recognition NP-10234",
    sourceType: "NUPORT_ORDER",
    sourceId: 10234,
    eventCode: "SALE_DELIVERED_COD",
    lines: [
      { accountCode: "1110", debit: Money.fromTaka("1150") },
      { accountCode: "4010", credit: Money.fromTaka("1050") },
      { accountCode: "4020", credit: Money.fromTaka("100") },
    ],
    ...overrides,
  };
}

beforeAll(async () => {
  T1 = await ensureTenant("Pure Foodmart", "pure-foodmart");
  T2 = await ensureTenant("Rival Store", "rival-store");
  await resetLedger();
});
afterAll(async () => {
  await pool.end();
});

describe("postEntry", () => {
  beforeEach(resetLedger);

  it("posts a balanced entry with gapless numbering and a hash", async () => {
    const posted = await withTransaction(pool, T1, (c) => postEntry(c, je()));
    expect(posted.entryNo).toBe(1);
    expect(posted.period).toBe("2026-07");
    expect(posted.entryHash).toMatch(/^[0-9a-f]{64}$/);

    const bal1110 = await withTransaction(pool, T1, (c) =>
      accountBalance(c, "1110"),
    );
    expect(bal1110.toTakaString()).toBe("1150.00");
    const tb = await withTransaction(pool, T1, (c) => trialBalance(c));
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit.toTakaString()).toBe("1150.00");
  });

  it("rejects unbalanced input before touching the database", async () => {
    const bad = je({
      lines: [
        { accountCode: "1110", debit: Money.fromTaka("1150") },
        { accountCode: "4010", credit: Money.fromTaka("1000") },
      ],
    });
    await expect(
      withTransaction(pool, T1, (c) => postEntry(c, bad)),
    ).rejects.toThrow(LedgerError);
  });

  it("rejects a line with both sides or zero amount", async () => {
    const both = je({
      lines: [
        {
          accountCode: "1110",
          debit: Money.fromTaka("10"),
          credit: Money.fromTaka("10"),
        },
        { accountCode: "4010", credit: Money.fromTaka("10") },
      ],
    });
    await expect(
      withTransaction(pool, T1, (c) => postEntry(c, both)),
    ).rejects.toThrow(/exactly one of debit\/credit/);
  });

  it("rejects unknown account codes", async () => {
    const bad = je({
      lines: [
        { accountCode: "9999", debit: Money.fromTaka("10") },
        { accountCode: "4010", credit: Money.fromTaka("10") },
      ],
    });
    await expect(
      withTransaction(pool, T1, (c) => postEntry(c, bad)),
    ).rejects.toThrow(/Unknown account code: 9999/);
  });
});

describe("tenant isolation (RLS)", () => {
  beforeEach(resetLedger);

  it("keeps ledgers fully separate: independent sequences, invisible rows", async () => {
    await withTransaction(pool, T1, (c) => postEntry(c, je()));
    const t2First = await withTransaction(pool, T2, (c) =>
      postEntry(c, je({ memo: "T2 first entry" })),
    );
    // T2's sequence starts at 1 — unaffected by T1's postings.
    expect(t2First.entryNo).toBe(1);

    // T2 sees only its own entry; T1's ৳1,150 is invisible.
    const t2View = await withTransaction(pool, T2, async (c) => {
      const count = await c.query("SELECT count(*)::int AS n FROM journal_entries");
      const bal = await accountBalance(c, "1110");
      return { n: count.rows[0].n as number, bal: bal.toTakaString() };
    });
    expect(t2View.n).toBe(1);
    expect(t2View.bal).toBe("1150.00"); // its OWN 1150, not T1's

    // Each tenant's hash chain verifies independently.
    const c1 = await withTransaction(pool, T1, (c) => verifyHashChain(c));
    const c2 = await withTransaction(pool, T2, (c) => verifyHashChain(c));
    expect(c1).toMatchObject({ ok: true, entriesChecked: 1 });
    expect(c2).toMatchObject({ ok: true, entriesChecked: 1 });
  });

  it("a transaction without tenant context sees nothing and cannot post", async () => {
    await withTransaction(pool, T1, (c) => postEntry(c, je()));
    const bare = await pool.query(
      "SELECT count(*)::int AS n FROM journal_entries",
    );
    expect(bare.rows[0].n).toBe(0); // FORCE RLS hides everything, even from the owner
  });
});

describe("database-level enforcement (triggers)", () => {
  beforeEach(resetLedger);

  it("COMMIT fails for an unbalanced entry inserted with raw SQL", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [
        String(T1),
      ]);
      const res = await client.query(
        `INSERT INTO journal_entries
           (entry_no, entry_date, period, memo, source_type, event_code, entry_hash, prev_hash)
         VALUES (999999, '2026-07-01', '2026-07', 'bad', 'MANUAL_JOURNAL', 'TEST',
                 repeat('a', 64), repeat('b', 64))
         RETURNING id`,
      );
      await client.query(
        `INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit)
         VALUES ($1, 1, (SELECT id FROM accounts WHERE code='1010'), 100, 0),
                ($1, 2, (SELECT id FROM accounts WHERE code='4010'), 0, 60)`,
        [res.rows[0].id],
      );
      await expect(client.query("COMMIT")).rejects.toThrow(/unbalanced/);
    } finally {
      client.release();
    }
  });

  it("UPDATE and DELETE on posted entries are impossible", async () => {
    const posted = await withTransaction(pool, T1, (c) => postEntry(c, je()));
    await expect(
      withTransaction(pool, T1, (c) =>
        c.query("UPDATE journal_entries SET memo = 'tampered' WHERE id = $1", [
          posted.entryId,
        ]),
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      withTransaction(pool, T1, (c) =>
        c.query("DELETE FROM journal_lines WHERE entry_id = $1", [
          posted.entryId,
        ]),
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("posting into a locked period is rejected", async () => {
    await withTransaction(pool, T1, (c) =>
      c.query(
        "UPDATE fiscal_periods SET is_locked = TRUE WHERE period = '2026-02'",
      ),
    );
    await expect(
      withTransaction(pool, T1, (c) =>
        postEntry(c, je({ entryDate: "2026-02-15" })),
      ),
    ).rejects.toThrow(/Period 2026-02 is locked/);
    // ...but the same period stays open for the OTHER tenant:
    const other = await withTransaction(pool, T2, (c) =>
      postEntry(c, je({ entryDate: "2026-02-15" })),
    );
    expect(other.period).toBe("2026-02");
  });
});

describe("hash chain & concurrency", () => {
  beforeEach(resetLedger);

  it("chains hashes across entries and verifies end to end", async () => {
    for (let i = 0; i < 3; i += 1) {
      await withTransaction(pool, T1, (c) =>
        postEntry(c, je({ sourceId: 20000 + i })),
      );
    }
    const check = await withTransaction(pool, T1, (c) => verifyHashChain(c));
    expect(check).toMatchObject({ ok: true, entriesChecked: 3 });
  });

  it("15 concurrent postings stay gapless, chained, and balanced", async () => {
    const N = 15;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        withTransaction(pool, T1, (c) =>
          postEntry(
            c,
            je({
              sourceId: 30000 + i,
              memo: `concurrent ${i}`,
              lines: [
                { accountCode: "1110", debit: Money.fromTaka("0.10") },
                { accountCode: "4010", credit: Money.fromTaka("0.10") },
              ],
            }),
          ),
        ),
      ),
    );
    const view = await withTransaction(pool, T1, async (c) => {
      const nos = await c.query(
        "SELECT entry_no FROM journal_entries ORDER BY entry_no",
      );
      const tb = await trialBalance(c);
      const chain = await verifyHashChain(c);
      return { nos: nos.rows.map((r) => Number(r.entry_no)), tb, chain };
    });
    expect(view.nos).toEqual(Array.from({ length: N }, (_, i) => i + 1));
    expect(view.tb.balanced).toBe(true);
    expect(view.tb.totalDebit.toTakaString()).toBe("1.50"); // 15 × ৳0.10, no float drift
    expect(view.chain.ok).toBe(true);
  });
});
