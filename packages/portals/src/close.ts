import { checkInventoryIntegrity } from "@pfm/inventory";
import { trialBalance, verifyHashChain, withTransaction } from "@pfm/ledger";
import { checkCourierFunds } from "@pfm/pipeline";
import type { Pool, PoolClient } from "pg";
import { PortalError, writeAudit } from "./shared";

export interface CloseGate {
  gate: string;
  ok: boolean;
  detail: string;
}

export interface CloseChecklist {
  period: string;
  allOk: boolean;
  gates: CloseGate[];
}

/**
 * §10.4 period-close checklist. Every gate must be green before the
 * period can lock; a locked period rejects postings at the DATABASE
 * level (trigger in migration 003), so this is the last human decision
 * of the month, not a soft flag.
 */
export async function runCloseChecklist(
  pool: Pool,
  tenantId: number,
  period: string,
): Promise<CloseChecklist> {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new PortalError("period must be YYYY-MM");
  return withTransaction(pool, tenantId, async (c) => {
    const p = await c.query<{ ends_on: string; is_locked: boolean }>(
      "SELECT ends_on::text, is_locked FROM fiscal_periods WHERE period=$1",
      [period],
    );
    if (!p.rows[0]) throw new PortalError(`Unknown fiscal period ${period}`);
    const periodEnd = p.rows[0].ends_on;
    const gates: CloseGate[] = [];

    const push = (gate: string, count: number, what: string) =>
      gates.push({
        gate,
        ok: count === 0,
        detail: count === 0 ? "clear" : `${count} ${what}`,
      });

    push("events_processed", await countQ(c,
      `SELECT (SELECT count(*) FROM nuport_events WHERE status IN ('RECEIVED','QUEUED','FAILED'))
            + (SELECT count(*) FROM steadfast_events WHERE status IN ('RECEIVED','QUEUED','FAILED'))`),
      "unprocessed ingestion events");
    push("no_open_alerts", await countQ(c,
      "SELECT count(*) FROM integrity_alerts WHERE status='OPEN'"),
      "open integrity alerts");
    push("orders_clean", await countQ(c,
      "SELECT count(*) FROM sales_orders WHERE fin_state IN ('NEEDS_BOM','EXCEPTION')"),
      "orders needing BOM/exception resolution");
    push("no_negative_stock", await countQ(c,
      "SELECT count(*) FROM item_stock WHERE on_hand < 0"),
      "items with negative stock");
    push("settlements_posted", await countQ(c,
      "SELECT count(*) FROM courier_settlements WHERE status IN ('DRAFT','MATCHED')"),
      "unresolved settlements");
    push("depreciation_posted", await countQ(c,
      `SELECT count(*) FROM fixed_assets a
       WHERE a.status='ACTIVE' AND a.acquired_on <= $1::date
         AND (a.cost - COALESCE((SELECT SUM(d.amount) FROM depreciation_entries d
                                 WHERE d.asset_id=a.id),0)) > a.salvage_value
         AND NOT EXISTS (SELECT 1 FROM depreciation_entries d
                         WHERE d.asset_id=a.id AND d.period=$2)`,
      [periodEnd, period]),
      "active assets missing this period's depreciation");

    const tb = await trialBalance(c);
    gates.push({
      gate: "trial_balance", ok: tb.balanced,
      detail: tb.balanced
        ? `balanced at ${tb.totalDebit.toTakaString()}`
        : `Dr ${tb.totalDebit.toTakaString()} != Cr ${tb.totalCredit.toTakaString()}`,
    });
    const chain = await verifyHashChain(c);
    gates.push({
      gate: "hash_chain", ok: chain.ok,
      detail: chain.ok
        ? `${chain.entriesChecked} entries verified`
        : `broken at entry ${chain.brokenAtEntryNo}: ${chain.reason}`,
    });
    const funds = await checkCourierFunds(c);
    gates.push({
      gate: "courier_funds_I2", ok: funds.ok,
      detail: funds.ok
        ? "1110/1115 match order stages"
        : `1110 ${funds.ledger1110.toTakaString()} vs ${funds.expected1110.toTakaString()}; 1115 ${funds.ledger1115.toTakaString()} vs ${funds.expected1115.toTakaString()}`,
    });
    const inv = await checkInventoryIntegrity(c);
    gates.push({
      gate: "inventory_I3", ok: inv.ok,
      detail: inv.ok
        ? `ledger=movements=${inv.ledgerValue.toTakaString()} (drift ${inv.roundingDiff.toTakaString()})`
        : `ledger ${inv.ledgerValue.toTakaString()} / movements ${inv.movementsValue.toTakaString()} / stock ${inv.stockValue.toTakaString()}`,
    });

    return { period, allOk: gates.every((g) => g.ok), gates };
  });
}

export interface ClosePeriodResult {
  locked: boolean;
  checklist: CloseChecklist;
}

export async function closePeriod(
  pool: Pool,
  tenantId: number,
  period: string,
  userId: number | null,
): Promise<ClosePeriodResult> {
  const already = await withTransaction(pool, tenantId, (c) =>
    c.query<{ is_locked: boolean }>(
      "SELECT is_locked FROM fiscal_periods WHERE period=$1", [period],
    ),
  );
  if (!already.rows[0]) throw new PortalError(`Unknown fiscal period ${period}`);
  if (already.rows[0].is_locked) throw new PortalError(`Period ${period} is already locked`);

  const checklist = await runCloseChecklist(pool, tenantId, period);
  if (!checklist.allOk) return { locked: false, checklist };

  await withTransaction(pool, tenantId, async (c) => {
    await c.query(
      "UPDATE fiscal_periods SET is_locked=TRUE, locked_at=now(), locked_by=$2 WHERE period=$1",
      [period, userId],
    );
    await writeAudit(c, userId, "PERIOD_LOCKED", "fiscal_periods", null, { period });
  });
  return { locked: true, checklist };
}

/** OWNER-only escape hatch — every unlock is audited with its reason. */
export async function unlockPeriod(
  pool: Pool,
  tenantId: number,
  period: string,
  userId: number | null,
  reason: string,
): Promise<void> {
  if (!reason.trim()) throw new PortalError("An unlock reason is required");
  await withTransaction(pool, tenantId, async (c) => {
    const res = await c.query(
      "UPDATE fiscal_periods SET is_locked=FALSE, locked_at=NULL, locked_by=NULL WHERE period=$1 AND is_locked",
      [period],
    );
    if (res.rowCount === 0) throw new PortalError(`Period ${period} is not locked`);
    await writeAudit(c, userId, "PERIOD_UNLOCKED", "fiscal_periods", null, {
      period, reason: reason.trim(),
    });
  });
}

async function countQ(
  c: PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const res = await c.query<{ count: string }>(sql, params);
  return Number(res.rows[0]!.count ?? Object.values(res.rows[0]!)[0]);
}
