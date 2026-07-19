import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ingestNuportEvent, processNuportEvent } from "@pfm/pipeline";
import { withTransaction } from "@pfm/ledger";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import type { Pool } from "pg";
import { PG_POOL } from "../db/database.module";

export const NUPORT_EVENTS_QUEUE = "nuport-events";

export interface WebhookReceipt {
  received: true;
  duplicate: boolean;
}

/**
 * Webhook contract (blueprint §2.2): validate → append raw event →
 * acknowledge fast. Processing is asynchronous — queued when Redis is
 * configured, fire-and-forget locally — and is idempotent either way,
 * because the cron completeness loop re-covers anything dropped.
 */
@Injectable()
export class NuportWebhookService implements OnModuleDestroy {
  private readonly logger = new Logger(NuportWebhookService.name);
  private readonly queue: Queue | null;
  private readonly redis: IORedis | null;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    const redisUrl = process.env.REDIS_URL;
    if (redisUrl) {
      this.redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
      this.queue = new Queue(NUPORT_EVENTS_QUEUE, { connection: this.redis });
    } else {
      this.redis = null;
      this.queue = null;
    }
  }

  /** Token → tenant. webhook_tokens is an auth-layer table (no RLS). */
  async resolveTenant(token: string): Promise<number | null> {
    const res = await this.pool.query<{ tenant_id: number }>(
      `SELECT tenant_id FROM webhook_tokens
       WHERE token = $1 AND provider = 'NUPORT' AND is_active`,
      [token],
    );
    return res.rows[0]?.tenant_id ?? null;
  }

  async receive(
    tenantId: number,
    orderRef: string,
    externalEventId: string | null,
    payload: unknown,
  ): Promise<WebhookReceipt> {
    const ingest = await withTransaction(this.pool, tenantId, (c) =>
      ingestNuportEvent(c, {
        channel: "WEBHOOK",
        externalEventId,
        orderRef,
        payload,
      }),
    );
    if (!ingest.duplicate && ingest.eventId !== null) {
      await this.dispatch(tenantId, ingest.eventId);
    }
    return { received: true, duplicate: ingest.duplicate };
  }

  private async dispatch(tenantId: number, eventId: number): Promise<void> {
    if (this.queue) {
      await this.queue.add(
        "process",
        { tenantId, eventId },
        { jobId: `evt:${eventId}`, removeOnComplete: 1000, removeOnFail: false },
      );
      return;
    }
    // No Redis (local dev): process out-of-band of the HTTP response.
    void processNuportEvent(this.pool, tenantId, eventId).catch((err) =>
      this.logger.error(
        `inline processing failed for event ${eventId}: ${err instanceof Error ? err.message : err}`,
      ),
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
    this.redis?.disconnect();
  }
}
