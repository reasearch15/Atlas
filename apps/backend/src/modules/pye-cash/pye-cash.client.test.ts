import { describe, expect, it, vi } from "vitest";
import { HttpPyeCashClient } from "./pye-cash.client";

const BOLT = "lnbc2500u1qqqqqqqqqqqqqqqqqqqqqq";

function client(fetchImpl: typeof fetch, allowLiveFetch = true) {
  return new HttpPyeCashClient({
    baseUrl: "https://www.pye-cash.app",
    timeoutMs: 1000,
    fetchImpl,
    allowLiveFetch
  });
}

describe("Pye-Cash HTTP client", () => {
  it("does not call the network when live fetch is disabled", async () => {
    const fetchImpl = vi.fn();
    const http = client(fetchImpl as unknown as typeof fetch, false);
    await expect(http.createInvoice({ amountCents: 500, merchant: "sg" })).rejects.toThrow(/disabled/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("classifies success, rejection, server errors, malformed bodies, and timeouts without retrying", async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({
      id: "provider25",
      lightning_invoice: BOLT,
      expires_at: "2026-11-18T12:00:00.000Z",
      status: "pending",
      amount: 25,
      currency: "USD",
      target_amount: "1"
    }), { status: 201 }));
    const created = await client(ok as unknown as typeof fetch).createInvoice({ amountCents: 2500, merchant: "sg" });
    expect(created.kind).toBe("created");
    expect(ok).toHaveBeenCalledTimes(1);
    const request = ok.mock.calls[0] as unknown as [string, RequestInit];
    expect(request[0]).toBe("https://www.pye-cash.app/api/payments");
    expect(JSON.parse(String(request[1].body))).toEqual({
      amount: 25,
      currency: "USD",
      metadata: { merchant: "sg" }
    });

    const rejected = vi.fn(async () => new Response("no", { status: 400 }));
    await expect(client(rejected as unknown as typeof fetch).createInvoice({ amountCents: 500, merchant: "sg" })).resolves.toMatchObject({
      kind: "rejected",
      category: "HTTP_400",
      httpStatus: 400
    });

    const failed = vi.fn(async () => new Response("down", { status: 503 }));
    await expect(client(failed as unknown as typeof fetch).createInvoice({ amountCents: 500, merchant: "sg" })).resolves.toMatchObject({
      kind: "uncertain",
      category: "HTTP_503",
      httpStatus: 503
    });

    const malformed = vi.fn(async () => new Response("not-json", { status: 200 }));
    const invalidJson = await client(malformed as unknown as typeof fetch).createInvoice({ amountCents: 500, merchant: "sg" });
    expect(invalidJson).toMatchObject({ kind: "uncertain", category: "INVALID_JSON", httpStatus: 200 });
    expect(JSON.stringify(invalidJson)).not.toContain("not-json");

    const timedOut = vi.fn(async () => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      throw error;
    });
    await expect(client(timedOut as unknown as typeof fetch).createInvoice({ amountCents: 500, merchant: "sg" })).resolves.toEqual({
      kind: "uncertain",
      category: "TIMEOUT"
    });
    expect(timedOut).toHaveBeenCalledTimes(1);
  });
});
