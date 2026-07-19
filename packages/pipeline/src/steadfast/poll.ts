import type {
  CanonicalPayoutInvoice,
  CanonicalSteadfastStatus,
} from "@pfm/domain";
import { withTransaction } from "@pfm/ledger";
import type { Pool } from "pg";
import { checkSteadfastBalanceDrift, type BalanceDriftReport } from "./balance";
import {
  recordPayoutInvoice,
  type RecordInvoiceResult,
} from "./settlement";
import { processSteadfastStatus, type StatusResult } from "./status";

/**
 * What the poll driver needs from a Steadfast client. @pfm/steadfast-client
 * satisfies this; tests inject fakes. getPayoutInvoices is optional —
 * absent on tiers without the payout API (CSV fallback carries stages 2–3).
 */
export interface SteadfastPollSource {
  getStatus(consignmentId: string): Promise<CanonicalSteadfastStatus>;
  getBalance(): Promise<{ currentBalance: string }>;
  getPayoutInvoices?: (since: string | null) => Promise<CanonicalPayoutInvoice[]>;
}

export interface SteadfastPollSummary {
  consignmentsChecked: number;
  statusOutcomes: StatusResult[];
  invoiceOutcomes: RecordInvoiceResult[];
  balance: BalanceDriftReport;
}

/**
 * The hourly Steadfast sweep (blueprint §12.2): consignment statuses for
 * every open order, payout invoices (when the tier exposes them), and the
 * balance drift cross-check. Every sub-step is idempotent, so a crashed
 * or double-scheduled poll can never double-post.
 */
export async function runSteadfastPoll(
  pool: Pool,
  tenantId: number,
  source: SteadfastPollSource,
): Promise<SteadfastPollSummary> {
  const open = await withTransaction(pool, tenantId, (c) =>
    c.query<{ consignment_id: string }>(
      `SELECT DISTINCT consignment_id FROM sales_orders
       WHERE consignment_id IS NOT NULL
         AND fin_state IN ('SYNCED','REVENUE_POSTED','NEEDS_BOM','PAYMENT_PENDING')
       ORDER BY consignment_id`,
    ),
  );

  const statusOutcomes: StatusResult[] = [];
  for (const row of open.rows) {
    const status = await source.getStatus(row.consignment_id);
    statusOutcomes.push(await processSteadfastStatus(pool, tenantId, status));
  }

  const invoiceOutcomes: RecordInvoiceResult[] = [];
  if (source.getPayoutInvoices) {
    for (const invoice of await source.getPayoutInvoices(null)) {
      invoiceOutcomes.push(
        await recordPayoutInvoice(pool, tenantId, invoice, "API"),
      );
    }
  }

  const { currentBalance } = await source.getBalance();
  const balance = await checkSteadfastBalanceDrift(pool, tenantId, currentBalance);

  return {
    consignmentsChecked: open.rows.length,
    statusOutcomes,
    invoiceOutcomes,
    balance,
  };
}
