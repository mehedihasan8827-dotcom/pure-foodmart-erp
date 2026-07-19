import type { PoolClient } from "pg";
import { sha256Canonical } from "../hash";

export type SteadfastEventKind =
  | "STATUS_CHANGE"
  | "BALANCE_SNAPSHOT"
  | "INVOICE_CREATED"
  | "PAYOUT_DISBURSED";

export interface SteadfastIngestInput {
  channel: "WEBHOOK" | "CRON";
  eventKind: SteadfastEventKind;
  consignmentId?: string | null;
  invoiceRef?: string | null;
  payload: unknown;
}

export interface SteadfastIngestResult {
  eventId: number | null;
  duplicate: boolean;
}

/**
 * Append-only Steadfast ingestion log (mirror of nuport_events).
 * Dedup: same (kind, consignment, invoice, payload-hash) seen twice —
 * so an hourly poll that observes no change writes nothing.
 */
export async function ingestSteadfastEvent(
  client: PoolClient,
  input: SteadfastIngestInput,
): Promise<SteadfastIngestResult> {
  const payloadHash = sha256Canonical(input.payload);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO steadfast_events
       (channel, event_kind, consignment_id, invoice_ref, payload, payload_hash)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      input.channel,
      input.eventKind,
      input.consignmentId ?? null,
      input.invoiceRef ?? null,
      JSON.stringify(input.payload),
      payloadHash,
    ],
  );
  if (inserted.rows[0]) {
    return { eventId: Number(inserted.rows[0].id), duplicate: false };
  }
  return { eventId: null, duplicate: true };
}

export async function markSteadfastEvent(
  client: PoolClient,
  eventId: number,
  status: "PROCESSED" | "FAILED",
  error: string | null = null,
): Promise<void> {
  await client.query(
    "UPDATE steadfast_events SET status=$2, processed_at=now(), error=$3 WHERE id=$1",
    [eventId, status, error],
  );
}
