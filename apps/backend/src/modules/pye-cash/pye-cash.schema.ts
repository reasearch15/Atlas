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

export interface ValidatedProviderInvoice {
  readonly providerInvoiceId: string;
  readonly lightningInvoice: string;
  readonly expiresAt: string;
  readonly status: string;
  readonly amountCents: number;
  readonly currency: "USD";
}

/**
 * Accepts only a complete provider payload whose USD amount matches the request.
 * A partial payload is not proof that no invoice was created.
 */
export function validateProviderInvoice(
  body: unknown,
  expectedAmountCents: number
): { readonly ok: true; readonly invoice: ValidatedProviderInvoice } | { readonly ok: false; readonly providerInvoiceId: string | null } {
  if (!body || typeof body !== "object") return { ok: false, providerInvoiceId: null };
  const record = body as Record<string, unknown>;
  const providerInvoiceId = typeof record.id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(record.id) ? record.id : null;
  const lightningInvoice = typeof record.lightning_invoice === "string" ? record.lightning_invoice.trim() : "";
  const expiresAt = typeof record.expires_at === "string" ? Date.parse(record.expires_at) : Number.NaN;
  const status = typeof record.status === "string" ? record.status.trim() : "";
  const currency = typeof record.currency === "string" ? record.currency.toUpperCase() : "";
  const amountCents = usdToCents(record.amount);
  const targetPresent = typeof record.target_amount === "string" || typeof record.target_amount === "number";
  if (
    !providerInvoiceId ||
    !bolt11Pattern.test(lightningInvoice) ||
    lightningInvoice.length > 2048 ||
    !Number.isFinite(expiresAt) ||
    !status ||
    status.length > 40 ||
    currency !== "USD" ||
    amountCents === null ||
    amountCents !== expectedAmountCents ||
    !targetPresent
  ) {
    return { ok: false, providerInvoiceId };
  }
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
