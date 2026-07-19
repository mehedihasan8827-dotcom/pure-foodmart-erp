import "dotenv/config";
import { Pool } from "pg";
import { startDepreciationScheduler } from "./processors/depreciation.scheduler";
import { startNuportWorker } from "./processors/nuport.worker";

/**
 * Worker process. Live consumers so far (roadmap §18.3):
 *  B4 → nuport-events queue consumer (requires REDIS_URL)
 * Still to come: Steadfast pollers + settlement poster (B5),
 * depreciation job (B6), integrity + hash-chain verifiers.
 */

const HEARTBEAT_MS = 60_000;

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(`[worker] ${new Date().toISOString()} ${message}`);
}

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://erp:erp_local_dev@localhost:5432/pure_foodmart_erp",
  max: 5,
});

const redisUrl = process.env.REDIS_URL;
const nuportWorker = redisUrl ? startNuportWorker(pool, redisUrl) : null;
const depreciationTimer = startDepreciationScheduler(pool);
log(
  nuportWorker
    ? "booted — nuport-events consumer + depreciation scheduler running"
    : "booted — no REDIS_URL; queue consumers idle (webhooks process inline, cron covers the rest); depreciation scheduler running",
);

if (process.env.WORKER_RUN_ONCE === "1") {
  log("WORKER_RUN_ONCE=1 → exiting after boot check");
  process.exit(0);
}

const heartbeat = setInterval(() => log("heartbeat"), HEARTBEAT_MS);

async function shutdown(signal: string): Promise<void> {
  log(`received ${signal}, shutting down`);
  clearInterval(heartbeat);
  clearInterval(depreciationTimer);
  await nuportWorker?.close();
  await pool.end();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
