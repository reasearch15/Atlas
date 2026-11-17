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

export interface ExpirationDiagnostic {
  readonly type: "missing" | "null" | "string" | "number" | "boolean" | "object" | "array" | "other";
  readonly format: "absent" | "empty" | "iso" | "unix_seconds" | "unix_milliseconds" | "numeric_string" | "other";
}

export type ProviderValidation =
  | { readonly ok: true; readonly invoice: ValidatedProviderInvoice }
  | {
      readonly ok: false;
      readonly reason: ProviderValidationReason;
      readonly providerInvoiceId: string | null;
      readonly expiration: ExpirationDiagnostic;
    };

const absentExpiration: ExpirationDiagnostic = { type: "missing", format: "absent" };

/**
 * Accepts a provider payload whose id, BOLT11, USD amount, currency, and expiration are valid.
 * `target_amount` may be missing or null. Expiration may be a timezone-marked ISO string or an
 * unambiguous Unix timestamp in seconds or milliseconds. The BOLT11 string is trimmed only at the ends.
 */
export function validateProviderInvoice(body: unknown, expectedAmountCents: number, nowMs = Date.now()): ProviderValidation {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reason: "INVALID_JSON", providerInvoiceId: null, expiration: absentExpiration };
  }
  const record = body as Record<string, unknown>;
  const expiration = describeExpiration(record);
  const providerInvoiceId = typeof record.id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(record.id) ? record.id : null;
  if (!providerInvoiceId) return { ok: false, reason: "INVALID_ID", providerInvoiceId: null, expiration };

  const lightningInvoice = typeof record.lightning_invoice === "string" ? record.lightning_invoice.trim() : "";
  if (!bolt11Pattern.test(lightningInvoice) || lightningInvoice.length > 2048) {
    return { ok: false, reason: "INVALID_BOLT11", providerInvoiceId, expiration };
  }

  const amountCents = usdToCents(record.amount);
  if (amountCents === null || amountCents !== expectedAmountCents) {
    return { ok: false, reason: "INVALID_AMOUNT", providerInvoiceId, expiration };
  }

  const expiresAt = parseProviderExpiration(record.expires_at, nowMs);
  if (expiresAt === null) return { ok: false, reason: "INVALID_EXPIRATION", providerInvoiceId, expiration };

  const currency = typeof record.currency === "string" ? record.currency.trim().toUpperCase() : "";
  if (currency !== "USD") return { ok: false, reason: "INVALID_CURRENCY", providerInvoiceId, expiration };

  const status = typeof record.status === "string" ? record.status.trim() : "";
  if (!status || status.length > 40) return { ok: false, reason: "INVALID_STATUS", providerInvoiceId, expiration };

  if (!isOptionalTargetAmount(record)) return { ok: false, reason: "INVALID_TARGET_AMOUNT", providerInvoiceId, expiration };

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

const ISO_EXPIRATION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const SECONDS_MIN = 1_000_000_000;
const SECONDS_MAX = 4_102_444_800;
const MILLISECONDS_MIN = SECONDS_MIN * 1000;
const MILLISECONDS_MAX = SECONDS_MAX * 1000;
const MAX_FUTURE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_PAST_MS = 10 * 60 * 1000;

function describeExpiration(record: Record<string, unknown>): ExpirationDiagnostic {
  if (!Object.prototype.hasOwnProperty.call(record, "expires_at")) return { type: "missing", format: "absent" };
  const value = record.expires_at;
  if (value === null) return { type: "null", format: "absent" };
  if (Array.isArray(value)) return { type: "array", format: "other" };
  if (typeof value === "string") return { type: "string", format: expirationFormat(value.trim()) };
  if (typeof value === "number") return { type: "number", format: numericExpirationFormat(value) };
  if (typeof value === "boolean") return { type: "boolean", format: "other" };
  if (typeof value === "object") return { type: "object", format: "other" };
  return { type: "other", format: "other" };
}

function expirationFormat(value: string): ExpirationDiagnostic["format"] {
  if (!value) return "empty";
  if (ISO_EXPIRATION.test(value)) return "iso";
  if (/^\d+$/.test(value)) {
    const numeric = numericExpirationFormat(Number(value));
    return numeric === "other" ? "numeric_string" : numeric;
  }
  return "other";
}

function numericExpirationFormat(value: number): ExpirationDiagnostic["format"] {
  if (!Number.isInteger(value)) return "other";
  if (value >= SECONDS_MIN && value <= SECONDS_MAX) return "unix_seconds";
  if (value >= MILLISECONDS_MIN && value <= MILLISECONDS_MAX) return "unix_milliseconds";
  return "other";
}

/**
 * ISO strings must include a timezone. A 10-digit integer is seconds and a 13-digit integer is
 * milliseconds; those ranges do not overlap between years 2001 and 2100. The instant must also
 * fall within 10 minutes in the past through 14 days in the future.
 */
function parseProviderExpiration(value: unknown, nowMs: number): number | null {
  const instant = expirationInstant(value);
  if (instant === null) return null;
  if (instant < nowMs - MAX_PAST_MS || instant > nowMs + MAX_FUTURE_MS) return null;
  return instant;
}

function expirationInstant(value: unknown): number | null {
  if (typeof value === "number") return instantFromNumber(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (ISO_EXPIRATION.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (!/^\d{10}$/.test(trimmed) && !/^\d{13}$/.test(trimmed)) return null;
  return instantFromNumber(Number(trimmed));
}

function instantFromNumber(value: number): number | null {
  if (!Number.isInteger(value)) return null;
  if (value >= SECONDS_MIN && value <= SECONDS_MAX) return value * 1000;
  if (value >= MILLISECONDS_MIN && value <= MILLISECONDS_MAX) return value;
  return null;
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
