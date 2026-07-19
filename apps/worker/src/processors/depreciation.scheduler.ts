import { runDepreciation } from "@pfm/portals";
import type { Pool } from "pg";

/**
 * Monthly depreciation cron (blueprint §8): on the 1st at 03:00 Asia/Dhaka
 * (UTC+6), charge the month that just ended for every ACTIVE tenant.
 * The 30-minute tick + UNIQUE(asset_id, period) idempotency means missed
 * or duplicate ticks are harmless. Runs on the platform connection
 * (tenants listing is a platform concern; per-tenant work goes through
 * the normal tenant-scoped transactions inside runDepreciation).
 */
const TICK_MS = 30 * 60 * 1000;
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(`[worker] ${new Date().toISOString()} ${message}`);
}

export function startDepreciationScheduler(pool: Pool): NodeJS.Timeout {
  let lastRunPeriod: string | null = null;

  const tick = async (): Promise<void> => {
    const dhaka = new Date(Date.now() + DHAKA_OFFSET_MS);
    if (dhaka.getUTCDate() !== 1 || dhaka.getUTCHours() !== 3) return;
    // The month that just ended, in Dhaka time.
    const prev = new Date(Date.UTC(dhaka.getUTCFullYear(), dhaka.getUTCMonth() - 1, 1));
    const period = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
    if (lastRunPeriod === period) return;
    lastRunPeriod = period;

    const tenants = await pool.query<{ id: number; slug: string }>(
      "SELECT id, slug FROM tenants WHERE status = 'ACTIVE' ORDER BY id",
    );
    for (const t of tenants.rows) {
      try {
        const result = await runDepreciation(pool, t.id, period);
        log(
          `depreciation ${period} tenant=${t.slug}: ` +
            (result.entry
              ? `charged ${result.totalCharge.toTakaString()} across ${result.perAsset.length} asset(s)`
              : "nothing to charge"),
        );
      } catch (err) {
        log(
          `depreciation ${period} tenant=${t.slug} FAILED: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  };

  return setInterval(() => void tick(), TICK_MS);
}
