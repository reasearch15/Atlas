import { z } from "zod";

const bolt11Pattern = /^lnbc[0-9]+[munp]?1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/i;

export const createInvoiceBodySchema = z.object({
  amountCents: z.number().int().positive(),
  idempotencyKey: z
    .string()
    .trim()
    .min(8)
    .max(80)
    .regex(/^[A-Za-z0-9:_-]+$/, "Idempotency key contains unsupported characters")
});

export const listInvoiceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20)
});

export const providerValidationReasons = [
  "INVALID_JSON",
  "INVALID_ID",
  "INVALID_BOLT11",
  "INVALID_EXPIRATION",
  "INVALID_STATUS",
  "INVALID_CURRENCY",
  "INVALID_AMOUNT",
  "INVALID_TARGET_AMOUNT"
] as const;

export type ProviderValidationReason = (typeof providerValidationReasons)[number];

export interface ValidatedProviderInvoice {
  readonly providerInvoiceId: string;
  readonly lightningInvoice: string;
  readonly expiresAt: string;
  readonly status: string;
  readonly amountCents: number;
  readonly currency: "USD";
}

export type ProviderValidation =
  | { readonly ok: true; readonly invoice: ValidatedProviderInvoice }
  | { readonly ok: false; readonly reason: ProviderValidationReason; readonly providerInvoiceId: string | null };

/**
 * Accepts a provider payload whose id, BOLT11, USD amount, currency, and expiration are valid.
 * `target_amount` may be missing or null. A numeric expiration is rejected because its unit is not verified.
 * The BOLT11 string is trimmed only at the ends and is otherwise unchanged.
 */
export function validateProviderInvoice(body: unknown, expectedAmountCents: number): ProviderValidation {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "INVALID_JSON", providerInvoiceId: null };
  }
  const record = body as Record<string, unknown>;
  const providerInvoiceId = typeof record.id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(record.id) ? record.id : null;
  if (!providerInvoiceId) return { ok: false, reason: "INVALID_ID", providerInvoiceId: null };

  const lightningInvoice = typeof record.lightning_invoice === "string" ? record.lightning_invoice.trim() : "";
  if (!bolt11Pattern.test(lightningInvoice) || lightningInvoice.length > 2048) {
    return { ok: false, reason: "INVALID_BOLT11", providerInvoiceId };
  }

  const amountCents = usdToCents(record.amount);
  if (amountCents === null || amountCents !== expectedAmountCents) {
    return { ok: false, reason: "INVALID_AMOUNT", providerInvoiceId };
  }

  const expiresAt = parseProviderExpiration(record.expires_at);
  if (expiresAt === null) return { ok: false, reason: "INVALID_EXPIRATION", providerInvoiceId };

  const currency = typeof record.currency === "string" ? record.currency.trim().toUpperCase() : "";
  if (currency !== "USD") return { ok: false, reason: "INVALID_CURRENCY", providerInvoiceId };

  const status = typeof record.status === "string" ? record.status.trim() : "";
  if (!status || status.length > 40) return { ok: false, reason: "INVALID_STATUS", providerInvoiceId };

  if (!isOptionalTargetAmount(record)) return { ok: false, reason: "INVALID_TARGET_AMOUNT", providerInvoiceId };

  return {
    ok: true,
    invoice: {
      providerInvoiceId,
      lightningInvoice,
      expiresAt: new Date(expiresAt).toISOString(),
      status,
      amountCents,
      currency: "USD"
    }
  };
}

function isOptionalTargetAmount(record: Record<string, unknown>): boolean {
  if (!Object.prototype.hasOwnProperty.call(record, "target_amount")) return true;
  const value = record.target_amount;
  return value === null || typeof value === "string" || typeof value === "number";
}

/**
 * ISO date strings are accepted. Numbers are not: a second and a millisecond timestamp are both plausible,
 * and no captured Pye-Cash response establishes which unit the provider uses.
 */
function parseProviderExpiration(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function usdToCents(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const cents = Math.round(value * 100);
    if (Math.abs(value * 100 - cents) > 0.000001) return null;
    return cents;
  }
  if (typeof value === "string" && /^\d+(\.\d{1,2})?$/.test(value)) {
    const [whole = "0", fraction = ""] = value.split(".");
    return Number(whole) * 100 + Number(`${fraction}00`.slice(0, 2));
  }
  return null;
}

export function centsToUsdAmount(amountCents: number): number {
  return amountCents / 100;
}
