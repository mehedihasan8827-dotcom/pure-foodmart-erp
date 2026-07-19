import { processNuportEvent } from "@pfm/pipeline";
import { Worker } from "bullmq";
import IORedis from "ioredis";
import type { Pool } from "pg";

export const NUPORT_EVENTS_QUEUE = "nuport-events";

/**
 * Consumes nuport-events jobs enqueued by the API webhook receiver.
 * concurrency: 1 keeps per-order processing serialized platform-wide —
 * correct and sufficient at current volume; if throughput ever demands
 * more, upgrade to per-order-ref job grouping, never plain concurrency.
 * Failed jobs stay in the queue (backoff), and the cron completeness
 * loop re-covers anything that ultimately drops.
 */
export function startNuportWorker(pool: Pool, redisUrl: string): Worker {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  return new Worker<{ tenantId: number; eventId: number }>(
    NUPORT_EVENTS_QUEUE,
    async (job) => {
      const { tenantId, eventId } = job.data;
      const result = await processNuportEvent(pool, tenantId, eventId);
      if (result.outcome === "FAILED") {
        // Recorded on the event row; do not retry a permanently-bad payload.
        return result;
      }
      return result;
    },
    {
      connection,
      concurrency: 1,
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
    } as never,
  );
}
