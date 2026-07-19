import type { CanonicalSteadfastStatus } from "@pfm/domain";
import { withTransaction } from "@pfm/ledger";
import type { Pool } from "pg";
import { postDeliveryFromDb } from "../shared/delivery";
import { raiseAlert, setOrderState } from "../shared/util";
import { ingestSteadfastEvent, markSteadfastEvent } from "./ingest";

export type StatusOutcome =
  | "POSTED" // Steadfast confirmed delivery first → revenue + COGS posted
  | "NEEDS_BOM"
  | "EXCEPTION"
  | "STATUS_RECORDED" // steadfast_status updated, no financial transition
  | "CLOSED_NO_REVENUE" // RTO before any revenue
  | "CONFLICT" // pipelines disagree (§14.11) — frozen for a human
  | "DUPLICATE" // no change since last observation
  | "UNKNOWN_CONSIGNMENT";

export interface StatusResult {
  outcome: StatusOutcome;
  orderId?: number;
}

/**
 * Steadfast status pipeline (§2.4): Steadfast is AUTHORITATIVE for
 * physical delivery. A consignment reported delivered while the order is
 * still SYNCED posts revenue+COGS right here — Nuport's later `delivered`
 * webhook becomes a no-op. Disagreements never guess: they freeze the
 * order and surface as SF_CONFLICT.
 */
export async function processSteadfastStatus(
  pool: Pool,
  tenantId: number,
  status: CanonicalSteadfastStatus,
): Promise<StatusResult> {
  return withTransaction(pool, tenantId, async (c) => {
    const ingest = await ingestSteadfastEvent(c, {
      channel: "CRON",
      eventKind: "STATUS_CHANGE",
      consignmentId: status.consignmentId,
      payload: { ...status, checkedAt: undefined }, // hash ignores poll time
    });
    if (ingest.duplicate) return { outcome: "DUPLICATE" };
    const eventId = ingest.eventId!;

    const orderRes = await c.query<{ id: string; fin_state: string }>(
      "SELECT id, fin_state FROM sales_orders WHERE consignment_id = $1 FOR UPDATE",
      [status.consignmentId],
    );
    const order = orderRes.rows[0];
    if (!order) {
      await raiseAlert(c, "SF_CONFLICT", {
        reason: "status for unknown consignment",
        consignmentId: status.consignmentId,
        rawStatus: status.rawStatus,
      });
      await markSteadfastEvent(c, eventId, "PROCESSED");
      return { outcome: "UNKNOWN_CONSIGNMENT" };
    }
    const orderId = Number(order.id);

    await c.query(
      "UPDATE sales_orders SET steadfast_status=$2, updated_at=now() WHERE id=$1",
      [orderId, status.rawStatus],
    );

    let result: StatusResult;
    switch (status.status) {
      case "DELIVERED":
        if (order.fin_state === "SYNCED") {
          const posted = await postDeliveryFromDb(c, orderId, status.checkedAt);
          result = { outcome: posted.outcome, orderId };
        } else if (
          order.fin_state === "RETURN_POSTED" ||
          order.fin_state === "CLOSED_NO_REVENUE"
        ) {
          // We already reversed/closed on Nuport's word; courier disagrees.
          await raiseAlert(c, "SF_CONFLICT", {
            orderId, consignmentId: status.consignmentId,
            finState: order.fin_state, steadfastStatus: status.rawStatus,
          });
          result = { outcome: "CONFLICT", orderId };
        } else {
          result = { outcome: "STATUS_RECORDED", orderId };
        }
        break;
      case "CANCELLED":
        if (order.fin_state === "SYNCED") {
          await setOrderState(c, orderId, "CLOSED_NO_REVENUE");
          await c.query(
            "UPDATE sales_orders SET returned_at=now(), updated_at=now() WHERE id=$1",
            [orderId],
          );
          result = { outcome: "CLOSED_NO_REVENUE", orderId };
        } else if (order.fin_state === "CLOSED_NO_REVENUE") {
          result = { outcome: "STATUS_RECORDED", orderId };
        } else {
          // Money already moved on a delivery signal — never auto-unwind.
          await raiseAlert(c, "SF_CONFLICT", {
            orderId, consignmentId: status.consignmentId,
            finState: order.fin_state, steadfastStatus: status.rawStatus,
          });
          result = { outcome: "CONFLICT", orderId };
        }
        break;
      case "PARTIAL":
        // §14.7: partial deliveries are a human decision until Phase 0
        // settles line-level granularity.
        await raiseAlert(c, "SF_CONFLICT", {
          orderId, consignmentId: status.consignmentId,
          reason: "partial delivery needs manual split",
          steadfastStatus: status.rawStatus,
        });
        result = { outcome: "CONFLICT", orderId };
        break;
      default:
        result = { outcome: "STATUS_RECORDED", orderId };
    }

    await markSteadfastEvent(c, eventId, "PROCESSED");
    return result;
  });
}
