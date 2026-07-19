import type { PoolClient } from "pg";
import { sha256Canonical } from "../hash";

export interface IngestInput {
  channel: "WEBHOOK" | "CRON";
  /** Nuport's webhook event id, when the payload carries one. */
  externalEventId?: string | null;
  orderRef: string;
  payload: unknown;
}

export interface IngestResult {
  eventId: number | null; // null only in the pathological both-duplicate race
  duplicate: boolean;
}

/**
 * Idempotency gate #1 (blueprint §2.2, P3). Append the raw payload to
 * nuport_events. Two unique constraints dedup replays:
 *   (tenant, external_event_id)          — same webhook delivered twice
 *   (tenant, order_ref, payload_hash)    — same order state seen twice
 *                                          (webhook + cron double-cover)
 * Runs in the caller's tenant transaction; RLS scopes everything.
 */
export async function ingestNuportEvent(
  client: PoolClient,
  input: IngestInput,
): Promise<IngestResult> {
  const payloadHash = sha256Canonical(input.payload);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO nuport_events
       (channel, external_event_id, nuport_order_ref, payload, payload_hash)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      input.channel,
      input.externalEventId ?? null,
      input.orderRef,
      JSON.stringify(input.payload),
      payloadHash,
    ],
  );
  if (inserted.rows[0]) {
    return { eventId: Number(inserted.rows[0].id), duplicate: false };
  }
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM nuport_events
     WHERE (external_event_id = $1 AND $1 IS NOT NULL)
        OR (nuport_order_ref = $2 AND payload_hash = $3)
     ORDER BY id LIMIT 1`,
    [input.externalEventId ?? null, input.orderRef, payloadHash],
  );
  return { eventId: existing.rows[0] ? Number(existing.rows[0].id) : null, duplicate: true };
}
