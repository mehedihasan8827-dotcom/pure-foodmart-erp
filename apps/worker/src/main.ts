import "dotenv/config";

/**
 * Worker process skeleton (B0).
 *
 * BullMQ queues and the real processors arrive per roadmap §18.3:
 *  B4 → nuport-event processor, order revenue+COGS pipeline, cron pullers
 *  B5 → steadfast status/invoice/balance pollers, settlement auto-poster
 *  B6 → depreciation job
 *  B2+ → integrity verifier, hash-chain verifier
 *
 * For now it boots, heartbeats, and shuts down cleanly so process
 * supervision and deploys can be wired and tested end to end.
 */

const HEARTBEAT_MS = 60_000;

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(`[worker] ${new Date().toISOString()} ${message}`);
}

log("Pure Foodmart ERP worker booted (B0 skeleton — processors arrive in B4/B5)");

if (process.env.WORKER_RUN_ONCE === "1") {
  log("WORKER_RUN_ONCE=1 → exiting after boot check");
  process.exit(0);
}

const heartbeat = setInterval(() => log("heartbeat"), HEARTBEAT_MS);

function shutdown(signal: string): void {
  log(`received ${signal}, shutting down`);
  clearInterval(heartbeat);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
