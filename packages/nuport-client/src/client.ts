import {
  canonicalNuportOrderSchema,
  type CanonicalNuportOrder,
} from "@pfm/domain";

/**
 * Typed Nuport API client (blueprint §2.2).
 *
 * PHASE 0 CONTRACT NOTE: endpoint paths, auth header names, and the
 * raw→canonical field mapping are configuration, because Nuport's exact
 * API surface is confirmed against real recorded payloads in Phase 0.
 * The defaults below assume a conventional REST shape; changing them is a
 * config edit per tenant integration, not a code change. Everything
 * downstream consumes only CanonicalNuportOrder.
 */
export interface NuportClientConfig {
  baseUrl: string;
  companyId: string;
  apiKey: string;
  /** Header names, overridable after Phase 0 discovery. */
  companyIdHeader?: string; // default 'X-Company-Id'
  apiKeyHeader?: string; // default 'X-Api-Key'
  ordersPath?: string; // default '/api/v1/orders'
  /** Map one raw API order object to the canonical shape. */
  mapOrder?: (raw: unknown) => unknown;
  /** Injectable transport — tests pass a fake; prod uses global fetch. */
  fetchFn?: typeof fetch;
  /** Backoff schedule for 429/5xx (blueprint §2.2): 2s/4s/8s/16s. */
  retryDelaysMs?: number[];
}

export class NuportApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "NuportApiError";
  }
}

const DEFAULT_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000];

export class NuportClient {
  private readonly cfg: Required<
    Pick<
      NuportClientConfig,
      "companyIdHeader" | "apiKeyHeader" | "ordersPath" | "retryDelaysMs"
    >
  > &
    NuportClientConfig;
  private readonly fetchFn: typeof fetch;
  private readonly mapOrder: (raw: unknown) => unknown;

  constructor(config: NuportClientConfig) {
    this.cfg = {
      companyIdHeader: "X-Company-Id",
      apiKeyHeader: "X-Api-Key",
      ordersPath: "/api/v1/orders",
      retryDelaysMs: DEFAULT_RETRY_DELAYS_MS,
      ...config,
    };
    this.fetchFn = config.fetchFn ?? fetch;
    this.mapOrder = config.mapOrder ?? ((raw) => raw);
  }

  async getOrder(orderRef: string): Promise<CanonicalNuportOrder> {
    const body = await this.request(
      `${this.cfg.ordersPath}/${encodeURIComponent(orderRef)}`,
    );
    const raw = (body as { data?: unknown }).data ?? body;
    return canonicalNuportOrderSchema.parse(this.mapOrder(raw));
  }

  async listOrders(params: {
    updatedSince: string | null;
    page: number;
    perPage?: number;
  }): Promise<{ orders: CanonicalNuportOrder[]; nextPage: number | null }> {
    const query = new URLSearchParams({ page: String(params.page) });
    query.set("per_page", String(params.perPage ?? 100));
    if (params.updatedSince) query.set("updated_since", params.updatedSince);
    const body = (await this.request(
      `${this.cfg.ordersPath}?${query.toString()}`,
    )) as {
      data?: unknown[];
      orders?: unknown[];
      next_page?: number | null;
      meta?: { current_page?: number; last_page?: number };
    };
    const rawList = body.data ?? body.orders ?? [];
    const orders = rawList.map((raw) =>
      canonicalNuportOrderSchema.parse(this.mapOrder(raw)),
    );
    let nextPage: number | null = null;
    if (typeof body.next_page === "number") nextPage = body.next_page;
    else if (
      body.meta?.current_page !== undefined &&
      body.meta?.last_page !== undefined &&
      body.meta.current_page < body.meta.last_page
    ) {
      nextPage = body.meta.current_page + 1;
    }
    return { orders, nextPage };
  }

  /** Drain all pages since a cursor — used by the completeness cron. */
  async *iterateOrders(
    updatedSince: string | null,
  ): AsyncGenerator<CanonicalNuportOrder> {
    let page: number | null = 1;
    while (page !== null) {
      const batch = await this.listOrders({ updatedSince, page });
      for (const order of batch.orders) yield order;
      page = batch.nextPage;
    }
  }

  private async request(path: string): Promise<unknown> {
    const url = new URL(path, this.cfg.baseUrl).toString();
    const attempts = this.cfg.retryDelaysMs.length + 1;
    let lastError: NuportApiError | null = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await sleep(this.cfg.retryDelaysMs[attempt - 1]!);
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          headers: {
            [this.cfg.companyIdHeader]: this.cfg.companyId,
            [this.cfg.apiKeyHeader]: this.cfg.apiKey,
            Accept: "application/json",
          },
        });
      } catch (err) {
        lastError = new NuportApiError(
          `network error: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue; // network failures are retryable
      }
      if (res.ok) return res.json();
      if (res.status === 429 || res.status >= 500) {
        lastError = new NuportApiError(
          `Nuport responded ${res.status}`,
          res.status,
        );
        continue; // retryable
      }
      throw new NuportApiError(`Nuport responded ${res.status}`, res.status);
    }
    throw lastError ?? new NuportApiError("request failed");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
