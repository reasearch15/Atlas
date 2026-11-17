import { describe, expect, it } from "vitest";
import { validateProviderInvoice } from "./pye-cash.schema";

const BOLT_1 = "lnbc100n1qqqqqqqqqqqqqqqqqqqqqq";
const BOLT_5 = "lnbc500n1pppppppppppppppppppppp";
const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const EXPIRES = "2026-11-18T12:00:00.000Z";
const EXPIRES_MS = Date.parse(EXPIRES);
const EXPIRES_SECONDS = EXPIRES_MS / 1000;

function body(amount: number, bolt11: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "provider01",
    lightning_invoice: bolt11,
    expires_at: EXPIRES,
    status: "pending",
    amount,
    currency: "USD",
    target_amount: "0.0001",
    ...overrides
  };
}

function validate(payload: unknown, cents: number) {
  return validateProviderInvoice(payload, cents, NOW);
}

describe("Pye-Cash provider validation", () => {
  it("accepts a 201-shaped $1 invoice and keeps the original BOLT11", () => {
    const mixed = `LNBC100N1${"qpzry9x8gf2tvdw0s3jn54khce6mua7l".repeat(2)}`;
    const result = validate(body(1, `  ${mixed}  `, { target_amount: null, currency: " usd " }), 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.amountCents).toBe(100);
    expect(result.invoice.lightningInvoice).toBe(mixed);
    expect(result.invoice.expiresAt).toBe(EXPIRES);
    expect(result.invoice.currency).toBe("USD");
  });

  it("accepts a $5 invoice when target_amount is missing", () => {
    const payload = body(5, BOLT_5);
    delete (payload as { target_amount?: unknown }).target_amount;
    const result = validate(payload, 500);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.lightningInvoice).toBe(BOLT_5);
    expect(result.invoice.amountCents).toBe(500);
  });

  it("accepts ISO offsets, Unix seconds, Unix milliseconds, and numeric strings as the same UTC instant", () => {
    const forms = [
      "2026-11-18T12:00:00+00:00",
      EXPIRES_SECONDS,
      EXPIRES_MS,
      String(EXPIRES_SECONDS),
      String(EXPIRES_MS)
    ];
    for (const expiresAt of forms) {
      const result = validate(body(1, BOLT_1, { expires_at: expiresAt }), 100);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.invoice.expiresAt).toBe(EXPIRES);
      expect(result.invoice.amountCents).toBe(100);
    }
  });

  it("rejects an invalid BOLT11, the wrong amount, and an unusable expiration", () => {
    expect(validate(body(1, "https://www.pye-cash.app/invoice/provider01"), 100)).toMatchObject({
      ok: false,
      reason: "INVALID_BOLT11"
    });
    expect(validate(body(5, BOLT_1), 100)).toMatchObject({ ok: false, reason: "INVALID_AMOUNT" });
    expect(validate(body(1, BOLT_1, { expires_at: "tomorrow" }), 100)).toMatchObject({
      ok: false,
      reason: "INVALID_EXPIRATION",
      expiration: { type: "string", format: "other" }
    });
    expect(validate(body(1, BOLT_1, { expires_at: "2026-11-18T12:00:00" }), 100)).toMatchObject({
      ok: false,
      reason: "INVALID_EXPIRATION",
      expiration: { type: "string", format: "other" }
    });
    const staleSeconds = Math.floor(Date.parse("2001-09-09T01:46:40.000Z") / 1000);
    expect(validate(body(1, BOLT_1, { expires_at: staleSeconds }), 100)).toMatchObject({
      ok: false,
      reason: "INVALID_EXPIRATION",
      expiration: { type: "number", format: "unix_seconds" }
    });
    expect(validate(body(1, BOLT_1, { expires_at: 50_000_000_000 }), 100)).toMatchObject({
      ok: false,
      reason: "INVALID_EXPIRATION",
      expiration: { type: "number", format: "other" }
    });
    expect(validate(body(1, BOLT_1, { expires_at: EXPIRES_SECONDS + 0.5 }), 100)).toMatchObject({
      ok: false,
      reason: "INVALID_EXPIRATION",
      expiration: { type: "number", format: "other" }
    });
    const distant = Math.floor(Date.parse("2026-12-17T12:00:00.000Z") / 1000);
    expect(validate(body(1, BOLT_1, { expires_at: distant }), 100)).toMatchObject({
      ok: false,
      reason: "INVALID_EXPIRATION",
      expiration: { type: "number", format: "unix_seconds" }
    });
    const withoutExpiry = body(1, BOLT_1);
    delete (withoutExpiry as { expires_at?: unknown }).expires_at;
    expect(validate(withoutExpiry, 100)).toMatchObject({
      ok: false,
      reason: "INVALID_EXPIRATION",
      expiration: { type: "missing", format: "absent" }
    });
    expect(validate(body(1, BOLT_1, { expires_at: null }), 100)).toMatchObject({
      ok: false,
      reason: "INVALID_EXPIRATION",
      expiration: { type: "null", format: "absent" }
    });
    expect(validate(body(1, BOLT_1, { target_amount: { btc: 1 } }), 100)).toMatchObject({
      ok: false,
      reason: "INVALID_TARGET_AMOUNT"
    });
    expect(validate("not-json", 100)).toMatchObject({ ok: false, reason: "INVALID_JSON" });
  });
});
