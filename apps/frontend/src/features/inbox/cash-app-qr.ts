export const DEFAULT_CASH_APP_AMOUNT = "5.00";
export const DEFAULT_CASH_APP_CENTS = 500;
export const CASH_APP_RESULT_VISIBLE_MS = 5000;

export interface CashAppInvoiceView {
  readonly id: string;
  readonly amountCents: number;
  readonly creationState: "CREATING" | "READY" | "UNKNOWN" | "FAILED";
  readonly deliveryState: "NOT_SENT" | "QUEUED" | "SENT" | "FAILED";
  readonly paymentState: "UNCONFIRMED" | "PAID" | "EXPIRED" | "UNKNOWN";
  readonly expiresAt: string | null;
  readonly errorCategory: string | null;
}

export interface CashAppCapability {
  readonly enabled: boolean;
  readonly testMode: boolean;
  readonly maxAmountCents: number;
  readonly userAllowed: boolean;
  readonly chatAllowed: boolean;
  readonly canSend: boolean;
}

export function cashAppAccessNotice(access: Pick<CashAppCapability, "enabled" | "userAllowed" | "chatAllowed">): string | null {
  if (!access.enabled) return "Live payments are not enabled.";
  if (!access.userAllowed) return "Cash App QR is limited to approved staff during testing.";
  if (!access.chatAllowed) return "This chat is not approved for Cash App QR testing.";
  return null;
}

export function canShowCashAppQr(role: string | null | undefined, permissions: readonly string[]): boolean {
  if (role !== "COADMIN" && role !== "STAFF") return false;
  return permissions.includes("payments:cash-app:send") && permissions.includes("telegram:message:send");
}

export function parseCashAppAmount(
  raw: string,
  maxAmountCents: number
): { readonly cents: number } | { readonly error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: "Enter an amount." };
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return { error: "Use a dollar amount with up to two decimals." };
  const [dollars, fraction = ""] = trimmed.split(".");
  const cents = Number(dollars) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents <= 0) return { error: "Amount must be greater than zero." };
  if (cents > maxAmountCents) return { error: "Amount is above the allowed maximum." };
  return { cents };
}

/** A cleared field returns to $5.00. A valid amount is kept. */
export function amountAfterBlur(raw: string, maxAmountCents: number): string {
  if (!raw.trim()) return DEFAULT_CASH_APP_AMOUNT;
  const parsed = parseCashAppAmount(raw, maxAmountCents);
  if ("error" in parsed) return raw;
  return (parsed.cents / 100).toFixed(2);
}

export function cashAppQrLayout(viewport: "desktop-panel" | "mobile"): { readonly row: string; readonly input: string; readonly button: string } {
  if (viewport === "mobile") {
    return {
      row: "flex w-full flex-col gap-2",
      input: "w-full min-w-0",
      button: "w-full"
    };
  }
  return {
    row: "flex w-full flex-row items-center gap-2",
    input: "min-w-0 flex-1",
    button: "shrink-0"
  };
}

export function formatCashAppHistory(invoice: CashAppInvoiceView): {
  readonly amount: string;
  readonly creationState: string;
  readonly deliveryState: string;
  readonly expiration: string;
  readonly error: string | null;
  readonly paid: boolean;
} {
  return {
    amount: `$${(invoice.amountCents / 100).toFixed(2)}`,
    creationState: invoice.creationState,
    deliveryState: invoice.deliveryState,
    expiration: invoice.expiresAt ? new Date(invoice.expiresAt).toISOString() : "No expiry",
    error: invoice.errorCategory,
    paid: invoice.paymentState === "PAID"
  };
}

export interface CashAppGateway {
  createInvoice(
    chatId: string,
    body: { readonly amountCents: number; readonly idempotencyKey: string }
  ): Promise<{ readonly invoice: CashAppInvoiceView }>;
  queueQr(chatId: string, invoiceId: string): Promise<{ readonly invoice: CashAppInvoiceView }>;
}

export type CashAppSendResult =
  | { readonly status: "disabled" }
  | { readonly status: "invalid"; readonly message: string }
  | { readonly status: "stale" }
  | { readonly status: "unknown"; readonly invoice: CashAppInvoiceView }
  | { readonly status: "queued"; readonly invoice: CashAppInvoiceView }
  | {
      readonly status: "failed";
      readonly invoiceId: string | null;
      readonly message: string;
      readonly invoice?: CashAppInvoiceView;
    };

export interface CashAppAttemptFeedback {
  readonly tone: "neutral" | "ok" | "bad";
  readonly message: string;
  readonly invoice: CashAppInvoiceView | null;
  readonly temporary: boolean;
}

/** Maps one send result to the temporary CRM message. It does not create or resend an invoice. */
export function cashAppAttemptFeedback(result: CashAppSendResult): CashAppAttemptFeedback | null {
  if (result.status === "queued") {
    const sent = result.invoice.deliveryState === "SENT";
    return {
      tone: "ok",
      message: sent ? "QR sent." : "QR queued for Telegram.",
      invoice: result.invoice,
      temporary: true
    };
  }
  if (result.status === "unknown") {
    return {
      tone: "bad",
      message: "Invoice outcome is unknown. It was not retried.",
      invoice: result.invoice,
      temporary: true
    };
  }
  if (result.status === "failed") {
    if (result.invoice?.deliveryState === "SENT") {
      return { tone: "ok", message: "QR sent.", invoice: result.invoice, temporary: true };
    }
    return {
      tone: "bad",
      message: result.invoiceId ? "QR was not queued. Send again to reuse this invoice." : result.message,
      invoice: result.invoice ?? null,
      temporary: true
    };
  }
  if (result.status === "invalid") return { tone: "bad", message: result.message, invoice: null, temporary: false };
  if (result.status === "disabled") return { tone: "neutral", message: "Live payments are not enabled.", invoice: null, temporary: false };
  return null;
}

export function createSendLock(): { tryBegin(): boolean; end(): void } {
  let busy = false;
  return {
    tryBegin() {
      if (busy) return false;
      busy = true;
      return true;
    },
    end() {
      busy = false;
    }
  };
}

/**
 * Creates at most one invoice for this click. QR failures keep that invoice id.
 * A chat change after the request started discards the result for the new chat.
 */
export async function sendCashAppQr(input: {
  readonly chatId: string;
  readonly amountRaw: string;
  readonly maxAmountCents: number;
  readonly enabled: boolean;
  readonly idempotencyKey: string;
  readonly recoverInvoiceId?: string | null;
  readonly gateway: CashAppGateway;
  readonly stillOnChat: () => boolean;
}): Promise<CashAppSendResult> {
  if (!input.enabled) return { status: "disabled" };
  const parsed = parseCashAppAmount(input.amountRaw, input.maxAmountCents);
  if ("error" in parsed) return { status: "invalid", message: parsed.error };
  let invoiceId = input.recoverInvoiceId ?? null;
  try {
    if (!invoiceId) {
      const created = await input.gateway.createInvoice(input.chatId, {
        amountCents: parsed.cents,
        idempotencyKey: input.idempotencyKey
      });
      if (!input.stillOnChat()) return { status: "stale" };
      invoiceId = created.invoice.id;
      if (created.invoice.creationState === "UNKNOWN" || created.invoice.creationState === "CREATING") {
        return { status: "unknown", invoice: created.invoice };
      }
      if (created.invoice.creationState !== "READY") {
        return { status: "failed", invoiceId, message: "The invoice was not confirmed.", invoice: created.invoice };
      }
    }
    const queued = await input.gateway.queueQr(input.chatId, invoiceId);
    if (!input.stillOnChat()) return { status: "stale" };
    return { status: "queued", invoice: queued.invoice };
  } catch (error) {
    if (!input.stillOnChat()) return { status: "stale" };
    return {
      status: "failed",
      invoiceId,
      message: error instanceof Error ? error.message : "The QR could not be sent."
    };
  }
}
