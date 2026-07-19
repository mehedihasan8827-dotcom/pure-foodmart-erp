import type { CanonicalNuportOrder } from "@pfm/domain";
import { withTransaction } from "@pfm/ledger";
import type { Pool } from "pg";
import { ingestNuportEvent } from "./ingest";
import { processNuportEvent, type ProcessResult } from "./process";

/** What the sync driver needs from a Nuport client (implemented in @pfm/nuport-client). */
export interface NuportOrderSource {
  listOrders(params: {
    updatedSince: string | null;
    page: number;
  }): Promise<{ orders: CanonicalNuportOrder[]; nextPage: number | null }>;
}

export interface SyncSummary {
  syncRunId: number;
  ordersSeen: number;
  ordersChanged: number;
  outcomes: ProcessResult[];
}

/**
 * Channel B (blueprint §2.2): the completeness loop. Pulls every order
 * changed since the stored cursor, funnels each through the SAME ingest +
 * process pipeline as webhooks (payload-hash dedup makes re-pulls no-ops),
 * and advances the cursor only on success. Failed runs keep the old
 * cursor, so nothing is ever skipped.
 */
export async function runNuportSync(
  pool: Pool,
  tenantId: number,
  source: NuportOrderSource,
): Promise<SyncSummary> {
  const startedAt = new Date().toISOString();

  const { runId, cursor } = await withTransaction(pool, tenantId, async (c) => {
    const prev = await c.query<{ cursor_after: string | null }>(
      `SELECT cursor_after FROM sync_runs
       WHERE channel='CRON' AND status='OK'
       ORDER BY id DESC LIMIT 1`,
    );
    const run = await c.query<{ id: string }>(
      `INSERT INTO sync_runs (channel, cursor_before) VALUES ('CRON', $1) RETURNING id`,
      [prev.rows[0]?.cursor_after ?? null],
    );
    return {
      runId: Number(run.rows[0]!.id),
      cursor: prev.rows[0]?.cursor_after ?? null,
    };
  });

  const outcomes: ProcessResult[] = [];
  let seen = 0;
  let changed = 0;
  try {
    let page: number | null = 1;
    while (page !== null) {
      const batch = await source.listOrders({ updatedSince: cursor, page });
      for (const order of batch.orders) {
        seen += 1;
        const ingest = await withTransaction(pool, tenantId, (c) =>
          ingestNuportEvent(c, {
            channel: "CRON",
            orderRef: order.orderRef,
            payload: order,
          }),
        );
        if (!ingest.duplicate && ingest.eventId !== null) {
          changed += 1;
          outcomes.push(await processNuportEvent(pool, tenantId, ingest.eventId));
        }
      }
      page = batch.nextPage;
    }
    await withTransaction(pool, tenantId, (c) =>
      c.query(
        `UPDATE sync_runs SET status='OK', finished_at=now(),
           cursor_after=$2, orders_seen=$3, orders_changed=$4
         WHERE id=$1`,
        [runId, startedAt, seen, changed],
      ),
    );
  } catch (err) {
    // Cursor does NOT advance — next run re-covers the same window.
    await withTransaction(pool, tenantId, (c) =>
      c.query(
        `UPDATE sync_runs SET status='FAILED', finished_at=now(),
           orders_seen=$2, orders_changed=$3, error=$4
         WHERE id=$1`,
        [runId, seen, changed, err instanceof Error ? err.message : String(err)],
      ),
    );
    throw err;
  }
  return { syncRunId: runId, ordersSeen: seen, ordersChanged: changed, outcomes };
}
