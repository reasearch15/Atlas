import { describe, expect, it } from "vitest";
import { validateProviderInvoice } from "./pye-cash.schema";

const BOLT_1 = "lnbc100n1qqqqqqqqqqqqqqqqqqqqqq";
const BOLT_5 = "lnbc500n1pppppppppppppppppppppp";

function body(amount: number, bolt11: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "provider01",
    lightning_invoice: bolt11,
    expires_at: "2026-11-18T12:00:00.000Z",
    status: "pending",
    amount,
    currency: "USD",
    target_amount: "0.0001",
    ...overrides
  };
}

describe("Pye-Cash provider validation", () => {
  it("accepts a 201-shaped $1 invoice and keeps the original BOLT11", () => {
    const mixed = `LNBC100N1${"qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(2)}`;
    const result = validateProviderInvoice(body(1, `  ${mixed}  `, { target_amount: null, currency: " usd " }), 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.amountCents).toBe(100);
    expect(result.invoice.lightningInvoice).toBe(mixed);
    expect(result.invoice.expiresAt).toBe("2026-11-18T12:00:00.000Z");
    expect(result.invoice.currency).toBe("USD");
  });

  it("accepts a $5 invoice when target_amount is missing", () => {
    const payload = body(5, BOLT_5);
    delete (payload as { target_amount?: unknown }).target_amount;
    const result = validateProviderInvoice(payload, 500);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.lightningInvoice).toBe(BOLT_5);
    expect(result.invoice.amountCents).toBe(500);
  });

  it("rejects an invalid BOLT11, the wrong amount, a bad expiration, and a numeric timestamp", () => {
    expect(validateProviderInvoice(body(1, "https://www.pye-cash.app/invoice/provider01"), 100)).toMatchObject({
      ok: false,
      reason: "INVALID_BOLT11"
    });
    expect(validateProviderInvoice(body(5, BOLT_1), 100)).toMatchObject({ ok: false, reason: "INVALID_AMOUNT" });
    expect(validateProviderInvoice(body(1, BOLT_1, { expires_at: "tomorrow" }), 100)).toMatchObject({
      ok: false,
      reason: "INVALID_EXPIRATION"
    });
    expect(validateProviderInvoice(body(1, BOLT_1, { expires_at: 1_763_500_000 }), 100)).toMatchObject({
      ok: false,
      reason: "INVALID_EXPIRATION"
    });
    expect(validateProviderInvoice(body(1, BOLT_1, { expires_at: 1_763_500_000_000 }), 100)).toMatchObject({
      ok: false,
      reason: "INVALID_EXPIRATION"
    });
    expect(validateProviderInvoice(body(1, BOLT_1, { target_amount: { btc: 1 } }), 100)).toMatchObject({
      ok: false,
      reason: "INVALID_TARGET_AMOUNT"
    });
    expect(validateProviderInvoice("not-json", 100)).toMatchObject({ ok: false, reason: "INVALID_JSON" });
  });
});
