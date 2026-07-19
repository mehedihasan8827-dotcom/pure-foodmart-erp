import {
  canonicalPayoutInvoiceSchema,
  type CanonicalPayoutInvoice,
  type CanonicalSteadfastStatus,
  type SteadfastDeliveryStatus,
} from "@pfm/domain";
import { z } from "zod";

/**
 * Typed Steadfast merchant API client (blueprint §2.3).
 *
 * The public merchant API (portal.packzy.com) reliably exposes
 * status-by-consignment and merchant balance. Payout-invoice detail is
 * NOT guaranteed on every tier — it is a configured capability
 * (payoutsPath); when absent, listPayoutInvoices throws
 * SteadfastCapabilityError and the CSV fallback (§6.3) carries stages 2–3.
 */
export interface SteadfastClientConfig {
  apiKey: string;
  secretKey: string;
  baseUrl?: string; // default https://portal.packzy.com/api/v1
  /** Set after Phase 0 IF the account tier exposes payout invoices. */
  payoutsPath?: string;
  fetchFn?: typeof fetch;
  retryDelaysMs?: number[]; // default 2s/4s/8s/16s
}

export class SteadfastApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SteadfastApiError";
  }
}

export class SteadfastCapabilityError extends Error {
  constructor() {
    super(
      "Payout-invoice API is not configured for this account tier — use the CSV statement fallback (blueprint §6.3)",
    );
    this.name = "SteadfastCapabilityError";
  }
}

/** Collapse Steadfast's raw status vocabulary into the canonical enum. */
export function mapDeliveryStatus(raw: string): SteadfastDeliveryStatus {
  const s = raw.toLowerCase().trim();
  if (s === "delivered" || s === "delivered_approval_pending") return "DELIVERED";
  if (s.startsWith("partial_delivered")) return "PARTIAL";
  if (s.startsWith("cancelled")) return "CANCELLED";
  if (s === "pending" || s === "hold" || s === "in_review") return "IN_TRANSIT";
  return "UNKNOWN";
}

const statusResponseSchema = z.object({
  delivery_status: z.string(),
});
const balanceResponseSchema = z.object({
  current_balance: z.union([z.string(), z.number()]).transform(String),
});

const DEFAULT_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000];

export class SteadfastClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly retryDelaysMs: number[];

  constructor(private readonly config: SteadfastClientConfig) {
    this.baseUrl = config.baseUrl ?? "https://portal.packzy.com/api/v1";
    this.fetchFn = config.fetchFn ?? fetch;
    this.retryDelaysMs = config.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  async getStatusByConsignment(
    consignmentId: string,
  ): Promise<CanonicalSteadfastStatus> {
    const body = await this.request(
      `/status_by_cid/${encodeURIComponent(consignmentId)}`,
    );
    const parsed = statusResponseSchema.parse(body);
    return {
      consignmentId,
      rawStatus: parsed.delivery_status,
      status: mapDeliveryStatus(parsed.delivery_status),
      checkedAt: new Date().toISOString(),
    };
  }

  /** Funds Steadfast is currently holding for this merchant (drift check I2). */
  async getBalance(): Promise<{ currentBalance: string }> {
    const body = await this.request("/get_balance");
    const parsed = balanceResponseSchema.parse(body);
    return { currentBalance: parsed.current_balance };
  }

  get supportsPayoutApi(): boolean {
    return Boolean(this.config.payoutsPath);
  }

  async listPayoutInvoices(params: {
    since: string | null;
  }): Promise<CanonicalPayoutInvoice[]> {
    if (!this.config.payoutsPath) throw new SteadfastCapabilityError();
    const query = params.since ? `?since=${encodeURIComponent(params.since)}` : "";
    const body = (await this.request(
      `${this.config.payoutsPath}${query}`,
    )) as { data?: unknown[] };
    return (body.data ?? []).map((raw) =>
      canonicalPayoutInvoiceSchema.parse(raw),
    );
  }

  private async request(path: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const attempts = this.retryDelaysMs.length + 1;
    let lastError: SteadfastApiError | null = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(this.retryDelaysMs[attempt - 1]!);
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          headers: {
            "Api-Key": this.config.apiKey,
            "Secret-Key": this.config.secretKey,
            "Content-Type": "application/json",
          },
        });
      } catch (err) {
        lastError = new SteadfastApiError(
          `network error: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (res.ok) return res.json();
      if (res.status === 429 || res.status >= 500) {
        lastError = new SteadfastApiError(
          `Steadfast responded ${res.status}`,
          res.status,
        );
        continue;
      }
      throw new SteadfastApiError(`Steadfast responded ${res.status}`, res.status);
    }
    throw lastError ?? new SteadfastApiError("request failed");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
