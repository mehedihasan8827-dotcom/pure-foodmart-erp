import { Money } from "@pfm/domain";
import { withTransaction } from "@pfm/ledger";
import type { Pool } from "pg";
import { raiseAlert } from "../shared/util";
import { ingestSteadfastEvent } from "./ingest";

export interface BalanceDriftReport {
  ok: boolean;
  reportedBalance: Money;
  ledgerCourierFunds: Money; // 1110 + 1115
  drift: Money; // |reported − ledger|
}

/**
 * Hourly cross-check (blueprint §6.4, §14.12): Steadfast's own reported
 * merchant balance vs our ledger's courier-fund accounts (1110 + 1115).
 * Drift beyond tolerance raises SF_BALANCE — usually a missed RTO charge
 * or an un-ingested invoice — and blocks month-close until explained.
 */
export async function checkSteadfastBalanceDrift(
  pool: Pool,
  tenantId: number,
  reportedBalanceTaka: string,
  toleranceTaka: Money = Money.fromTaka("500"),
): Promise<BalanceDriftReport> {
  return withTransaction(pool, tenantId, async (c) => {
    const reported = Money.fromTaka(reportedBalanceTaka);
    const res = await c.query<{ v: string }>(
      `SELECT COALESCE(SUM(balance), 0)::NUMERIC(14,2)::text AS v
       FROM account_balances WHERE code IN ('1110','1115')`,
    );
    const ledger = Money.fromTaka(res.rows[0]!.v);
    const signed = reported.subtract(ledger);
    const drift = signed.isNegative() ? signed.negate() : signed;
    const ok = drift.compare(toleranceTaka) <= 0;

    await ingestSteadfastEvent(c, {
      channel: "CRON",
      eventKind: "BALANCE_SNAPSHOT",
      payload: {
        reported: reported.toTakaString(),
        ledger: ledger.toTakaString(),
        drift: drift.toTakaString(),
        snapshotDate: new Date().toISOString().slice(0, 10),
      },
    });
    if (!ok) {
      await raiseAlert(c, "SF_BALANCE", {
        reported: reported.toTakaString(),
        ledger1110plus1115: ledger.toTakaString(),
        drift: drift.toTakaString(),
        tolerance: toleranceTaka.toTakaString(),
      });
    }
    return { ok, reportedBalance: reported, ledgerCourierFunds: ledger, drift };
  });
}
