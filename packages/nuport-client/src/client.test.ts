import { describe, expect, it } from "vitest";
import { NuportApiError, NuportClient } from "./client";

const order = (ref: string) => ({
  orderRef: ref,
  status: "delivered",
  paymentMode: "COD",
  productAmount: "1050",
  deliveryCharge: "100",
  codAmount: "1150",
  lines: [{ sku: "JAG-5KG", qty: "1", unitPrice: "1050", lineTotal: "1050" }],
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeClient(fetchFn: typeof fetch) {
  return new NuportClient({
    baseUrl: "https://api.nuport.test",
    companyId: "PF-001",
    apiKey: "secret-key",
    fetchFn,
    retryDelaysMs: [1, 1, 1, 1], // fast tests; production default is 2s/4s/8s/16s
  });
}

describe("NuportClient", () => {
  it("sends auth headers and parses a canonical order", async () => {
    let seenHeaders: Record<string, string> = {};
    const client = makeClient(async (_url, init) => {
      seenHeaders = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      );
      return jsonResponse({ data: order("NP-1") });
    });
    const result = await client.getOrder("NP-1");
    expect(result.orderRef).toBe("NP-1");
    expect(result.productAmount).toBe("1050");
    expect(seenHeaders["X-Company-Id"]).toBe("PF-001");
    expect(seenHeaders["X-Api-Key"]).toBe("secret-key");
  });

  it("retries 429/5xx with backoff and then succeeds", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      if (calls <= 2) return jsonResponse({ error: "rate limited" }, 429);
      return jsonResponse({ data: order("NP-2") });
    });
    const result = await client.getOrder("NP-2");
    expect(result.orderRef).toBe("NP-2");
    expect(calls).toBe(3);
  });

  it("gives up after the backoff schedule is exhausted", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      return jsonResponse({ error: "down" }, 503);
    });
    await expect(client.getOrder("NP-3")).rejects.toThrow(NuportApiError);
    expect(calls).toBe(5); // initial + 4 retries
  });

  it("does NOT retry non-retryable client errors", async () => {
    let calls = 0;
    const client = makeClient(async () => {
      calls += 1;
      return jsonResponse({ error: "not found" }, 404);
    });
    await expect(client.getOrder("NP-4")).rejects.toThrow(/404/);
    expect(calls).toBe(1);
  });

  it("paginates until nextPage is null", async () => {
    const pages: Record<string, unknown> = {
      "1": { data: [order("A"), order("B")], next_page: 2 },
      "2": { data: [order("C")], next_page: null },
    };
    const client = makeClient(async (url) => {
      const page = new URL(String(url)).searchParams.get("page")!;
      return jsonResponse(pages[page]);
    });
    const refs: string[] = [];
    for await (const o of client.iterateOrders("2026-07-01T00:00:00Z")) {
      refs.push(o.orderRef);
    }
    expect(refs).toEqual(["A", "B", "C"]);
  });
});
