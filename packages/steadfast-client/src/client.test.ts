import { describe, expect, it } from "vitest";
import {
  SteadfastCapabilityError,
  SteadfastClient,
  mapDeliveryStatus,
} from "./client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(fetchFn: typeof fetch, payoutsPath?: string) {
  return new SteadfastClient({
    apiKey: "sf-key",
    secretKey: "sf-secret",
    fetchFn,
    payoutsPath,
    retryDelaysMs: [1, 1, 1, 1],
  });
}

describe("mapDeliveryStatus", () => {
  it("collapses the raw vocabulary into the canonical enum", () => {
    expect(mapDeliveryStatus("delivered")).toBe("DELIVERED");
    expect(mapDeliveryStatus("delivered_approval_pending")).toBe("DELIVERED");
    expect(mapDeliveryStatus("partial_delivered")).toBe("PARTIAL");
    expect(mapDeliveryStatus("cancelled_approval_pending")).toBe("CANCELLED");
    expect(mapDeliveryStatus("pending")).toBe("IN_TRANSIT");
    expect(mapDeliveryStatus("hold")).toBe("IN_TRANSIT");
    expect(mapDeliveryStatus("something_new")).toBe("UNKNOWN");
  });
});

describe("SteadfastClient", () => {
  it("sends both auth headers and maps consignment status", async () => {
    let seenHeaders: Record<string, string> = {};
    const client = makeClient(async (_url, init) => {
      seenHeaders = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      );
      return jsonResponse({ status: 200, delivery_status: "delivered_approval_pending" });
    });
    const status = await client.getStatusByConsignment("SF-88231");
    expect(status.status).toBe("DELIVERED");
    expect(status.rawStatus).toBe("delivered_approval_pending");
    expect(seenHeaders["Api-Key"]).toBe("sf-key");
    expect(seenHeaders["Secret-Key"]).toBe("sf-secret");
  });

  it("returns the merchant balance as a string", async () => {
    const client = makeClient(async () =>
      jsonResponse({ status: 200, current_balance: 3450.5 }),
    );
    expect(await client.getBalance()).toEqual({ currentBalance: "3450.5" });
  });

  it("retries 5xx then succeeds", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({}, 502);
      return jsonResponse({ status: 200, delivery_status: "pending" });
    });
    const status = await client.getStatusByConsignment("SF-1");
    expect(status.status).toBe("IN_TRANSIT");
    expect(calls).toBe(2);
  });

  it("gates the payout API behind configuration", async () => {
    const noPayout = makeClient(async () => jsonResponse({}));
    expect(noPayout.supportsPayoutApi).toBe(false);
    await expect(noPayout.listPayoutInvoices({ since: null })).rejects.toThrow(
      SteadfastCapabilityError,
    );

    const withPayout = makeClient(
      async () =>
        jsonResponse({
          data: [
            {
              invoiceRef: "INV-1",
              statementDate: "2026-07-15",
              lines: [
                { consignmentId: "SF-1", codCollected: "1150", courierCharge: "30" },
              ],
            },
          ],
        }),
      "/payouts",
    );
    expect(withPayout.supportsPayoutApi).toBe(true);
    const invoices = await withPayout.listPayoutInvoices({ since: null });
    expect(invoices[0]!.invoiceRef).toBe("INV-1");
    expect(invoices[0]!.payoutAccountCode).toBe("1020"); // schema default
  });
});
