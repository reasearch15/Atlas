import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  amountAfterBlur,
  canShowCashAppQr,
  cashAppQrLayout,
  createSendLock,
  cashAppAccessNotice,
  DEFAULT_CASH_APP_AMOUNT,
  cashAppAttemptFeedback,
  CASH_APP_RESULT_VISIBLE_MS,
  formatCashAppHistory,
  parseCashAppAmount,
  sendCashAppQr,
  type CashAppGateway,
  type CashAppInvoiceView
} from "./cash-app-qr";

const staffPermissions = ["payments:cash-app:send", "telegram:message:send", "leaderboard:read"];

function invoice(overrides: Partial<CashAppInvoiceView> = {}): CashAppInvoiceView {
  return {
    id: "invoice-1",
    amountCents: 500,
    creationState: "READY",
    deliveryState: "QUEUED",
    paymentState: "UNCONFIRMED",
    expiresAt: "2026-11-18T12:00:00.000Z",
    errorCategory: null,
    ...overrides
  };
}

describe("Cash App QR CRM controls", () => {
  it("is visible for every authorized player, including chats with no leaderboard profile", () => {
    expect(canShowCashAppQr("STAFF", staffPermissions)).toBe(true);
    expect(canShowCashAppQr("COADMIN", staffPermissions)).toBe(true);
    expect(canShowCashAppQr("STAFF", staffPermissions)).toBe(canShowCashAppQr("STAFF", staffPermissions));
  });

  it("hides the controls from unauthorized staff", () => {
    expect(canShowCashAppQr("STAFF", ["telegram:message:send"])).toBe(false);
    expect(canShowCashAppQr("STAFF", ["payments:cash-app:send"])).toBe(false);
    expect(canShowCashAppQr("PLATFORM_ADMIN", [...staffPermissions, "leaderboard:deposit"])).toBe(false);
    expect(canShowCashAppQr(null, staffPermissions)).toBe(false);
  });

  it("defaults to $5.00 and restores a cleared field without keeping invalid amounts as blank", () => {
    expect(DEFAULT_CASH_APP_AMOUNT).toBe("5.00");
    expect(parseCashAppAmount(DEFAULT_CASH_APP_AMOUNT, 100_000)).toEqual({ cents: 500 });
    expect(amountAfterBlur("   ", 100_000)).toBe("5.00");
    expect(amountAfterBlur("", 100_000)).toBe("5.00");
    expect(amountAfterBlur("25", 100_000)).toBe("25.00");
  });

  it("rejects zero, negative, excessive, and malformed amounts", () => {
    expect(parseCashAppAmount("0", 100_000)).toMatchObject({ error: expect.any(String) });
    expect(parseCashAppAmount("-5", 100_000)).toMatchObject({ error: expect.any(String) });
    expect(parseCashAppAmount("1000.01", 100_000)).toMatchObject({ error: expect.any(String) });
    expect(parseCashAppAmount("5.555", 100_000)).toMatchObject({ error: expect.any(String) });
    expect(parseCashAppAmount("abc", 100_000)).toMatchObject({ error: expect.any(String) });
    expect(parseCashAppAmount("12.5", 100_000)).toEqual({ cents: 1250 });
  });

  it("ignores a result after the chat changes and does not apply it to the new chat", async () => {
    let onOriginal = true;
    const gateway: CashAppGateway = {
      async createInvoice(chatId) {
        expect(chatId).toBe("chat-a");
        onOriginal = false;
        return { invoice: invoice() };
      },
      async queueQr() {
        throw new Error("must not queue after the chat changed");
      }
    };
    const result = await sendCashAppQr({
      chatId: "chat-a",
      amountRaw: "5.00",
      maxAmountCents: 100_000,
      enabled: true,
      idempotencyKey: "key-chat",
      gateway,
      stillOnChat: () => onOriginal
    });
    expect(result.status).toBe("stale");
  });

  it("prevents a second click while a send is in progress", () => {
    const lock = createSendLock();
    expect(lock.tryBegin()).toBe(true);
    expect(lock.tryBegin()).toBe(false);
    lock.end();
    expect(lock.tryBegin()).toBe(true);
  });

  it("explains test-mode access for this chat without exposing allowlists", () => {
    expect(cashAppAccessNotice({ enabled: false, userAllowed: true, chatAllowed: true })).toBe("Live payments are not enabled.");
    expect(cashAppAccessNotice({ enabled: true, userAllowed: false, chatAllowed: true })).toMatch(/approved staff/);
    expect(cashAppAccessNotice({ enabled: true, userAllowed: true, chatAllowed: false })).toMatch(/not approved/);
    expect(cashAppAccessNotice({ enabled: true, userAllowed: true, chatAllowed: true })).toBeNull();
  });

  it("does not call the provider flow when live payments are disabled", async () => {
    let calls = 0;
    const gateway: CashAppGateway = {
      async createInvoice() {
        calls += 1;
        return { invoice: invoice() };
      },
      async queueQr() {
        calls += 1;
        return { invoice: invoice() };
      }
    };
    const result = await sendCashAppQr({
      chatId: "chat-a",
      amountRaw: "5.00",
      maxAmountCents: 100_000,
      enabled: false,
      idempotencyKey: "key-off",
      gateway,
      stillOnChat: () => true
    });
    expect(result).toEqual({ status: "disabled" });
    expect(calls).toBe(0);
  });

  it("queues one READY invoice and does not retry an UNKNOWN outcome", async () => {
    const created: string[] = [];
    const queued: string[] = [];
    const gateway: CashAppGateway = {
      async createInvoice(_chatId, body) {
        created.push(body.idempotencyKey);
        return { invoice: invoice({ creationState: "READY", deliveryState: "NOT_SENT" }) };
      },
      async queueQr(_chatId, invoiceId) {
        queued.push(invoiceId);
        return { invoice: invoice({ deliveryState: "QUEUED" }) };
      }
    };
    const ok = await sendCashAppQr({
      chatId: "chat-a",
      amountRaw: "5.00",
      maxAmountCents: 100_000,
      enabled: true,
      idempotencyKey: "once",
      gateway,
      stillOnChat: () => true
    });
    expect(ok.status).toBe("queued");
    const unknown = await sendCashAppQr({
      chatId: "chat-a",
      amountRaw: "5.00",
      maxAmountCents: 100_000,
      enabled: true,
      idempotencyKey: "second-key",
      gateway: {
        async createInvoice() {
          created.push("unknown");
          return { invoice: invoice({ id: "unknown-1", creationState: "UNKNOWN", deliveryState: "NOT_SENT" }) };
        },
        async queueQr() {
          queued.push("unknown");
          return { invoice: invoice() };
        }
      },
      stillOnChat: () => true
    });
    expect(unknown.status).toBe("unknown");
    expect(created).toEqual(["once", "unknown"]);
    expect(queued).toEqual(["invoice-1"]);
  });

  it("reuses the same invoice when QR delivery fails and does not create another", async () => {
    const created: string[] = [];
    const queued: string[] = [];
    let queueAttempts = 0;
    const gateway: CashAppGateway = {
      async createInvoice() {
        created.push("create");
        return { invoice: invoice({ id: "keep-me", deliveryState: "NOT_SENT" }) };
      },
      async queueQr(_chatId, invoiceId) {
        queueAttempts += 1;
        queued.push(invoiceId);
        if (queueAttempts === 1) {
          const error = new Error("storage down");
          Object.assign(error, { code: "PYE_CASH_STORAGE_FAILED" });
          throw error;
        }
        return { invoice: invoice({ id: invoiceId, deliveryState: "QUEUED" }) };
      }
    };
    const failed = await sendCashAppQr({
      chatId: "chat-a",
      amountRaw: "25.00",
      maxAmountCents: 100_000,
      enabled: true,
      idempotencyKey: "first",
      gateway,
      stillOnChat: () => true
    });
    expect(failed).toMatchObject({ status: "failed", invoiceId: "keep-me", code: "PYE_CASH_STORAGE_FAILED" });
    const recovered = await sendCashAppQr({
      chatId: "chat-a",
      amountRaw: "25.00",
      maxAmountCents: 100_000,
      enabled: true,
      idempotencyKey: "unused",
      recoverInvoiceId: "keep-me",
      gateway,
      stillOnChat: () => true
    });
    expect(recovered.status).toBe("queued");
    expect(created).toEqual(["create"]);
    expect(queued).toEqual(["keep-me", "keep-me"]);
  });

  it("uses a compact desktop row and a stacked mobile layout", () => {
    expect(cashAppQrLayout("desktop-panel").row).toContain("flex-row");
    expect(cashAppQrLayout("desktop-panel").input).toContain("flex-1");
    expect(cashAppQrLayout("mobile").row).toContain("flex-col");
    expect(cashAppQrLayout("mobile").button).toContain("w-full");
  });

  it("shows invoice state without a BOLT11 payload or an unconfirmed paid label", () => {
    const line = formatCashAppHistory(invoice({ paymentState: "UNCONFIRMED", errorCategory: "TELEGRAM_FAILED" }));
    expect(line.amount).toBe("$5.00");
    expect(line.creationState).toBe("READY");
    expect(line.deliveryState).toBe("QUEUED");
    expect(line.paid).toBe(false);
    expect(line.error).toBe("TELEGRAM_FAILED");
    expect(JSON.stringify(line)).not.toContain("lnbc");
    expect(formatCashAppHistory(invoice({ paymentState: "PAID" })).paid).toBe(true);
  });

  it("places Cash App QR above Leaderboard and does not record deposits", () => {
    const panel = readFileSync(new URL("./crm-panel.tsx", import.meta.url), "utf8");
    const section = readFileSync(new URL("./cash-app-qr-section.tsx", import.meta.url), "utf8");
    const logic = readFileSync(new URL("./cash-app-qr.ts", import.meta.url), "utf8");
    expect(panel.indexOf("<CashAppQrSection")).toBeGreaterThan(0);
    expect(panel.indexOf("<CashAppQrSection")).toBeLessThan(panel.indexOf("<CrmGiveawaySection"));
    expect(panel).not.toContain("recordDeposit");
    expect(section).not.toContain("recordDeposit");
    expect(logic).not.toContain("recordDeposit");
    expect(section).toContain("Cash App QR");
    expect(section).toContain("Send QR");
    expect(section).toContain("Payment history");
    expect(section).toContain("clearTimeout");
    expect(section).toContain("CASH_APP_RESULT_VISIBLE_MS");
    expect(section).not.toContain("deleteInvoice");
  });

  it("shows a payment result for five seconds and does not describe a sent invoice as not queued", () => {
    expect(CASH_APP_RESULT_VISIBLE_MS).toBe(5000);
    expect(cashAppAttemptFeedback({ status: "queued", invoice: invoice({ deliveryState: "SENT" }) })).toMatchObject({
      message: "QR sent.",
      temporary: true,
      invoice: { deliveryState: "SENT" }
    });
    expect(cashAppAttemptFeedback({ status: "queued", invoice: invoice({ deliveryState: "QUEUED" }) })?.message).toBe("QR queued for Telegram.");
    expect(cashAppAttemptFeedback({ status: "unknown", invoice: invoice({ creationState: "UNKNOWN", deliveryState: "NOT_SENT" }) })).toMatchObject({
      temporary: true,
      message: "Invoice outcome is unknown. It was not retried."
    });
    expect(cashAppAttemptFeedback({ status: "queued", invoice: invoice({ deliveryState: "QUEUED" }) })?.message).not.toBe("QR sent.");
    expect(cashAppAttemptFeedback({
      status: "failed",
      invoiceId: "invoice-1",
      code: "PYE_CASH_QUEUE_UNAVAILABLE",
      message: "worker down"
    })?.message).toBe("Invoice created. Telegram delivery is pending because the queue is temporarily unavailable.");
    expect(cashAppAttemptFeedback({
      status: "failed",
      invoiceId: "invoice-1",
      code: "PYE_CASH_RENDER_FAILED",
      message: "render"
    })?.message).toBe("The QR image could not be rendered.");
    expect(cashAppAttemptFeedback({
      status: "failed",
      invoiceId: "invoice-1",
      code: "PYE_CASH_STORAGE_FAILED",
      message: "storage"
    })?.message).toBe("The QR image could not be stored.");
    expect(cashAppAttemptFeedback({
      status: "failed",
      invoiceId: "invoice-1",
      message: "queue down",
      invoice: invoice({ creationState: "FAILED", deliveryState: "FAILED", errorCategory: "DELIVERY_FAILED" })
    })).toMatchObject({
      temporary: true,
      message: "The delivery request failed before the queue was confirmed. Send again to reuse this invoice."
    });
    expect(cashAppAttemptFeedback({
      status: "failed",
      invoiceId: "invoice-1",
      code: "WORKER_UNAVAILABLE",
      message: "queue"
    })?.message).toContain("queue is temporarily unavailable");
    expect(cashAppAttemptFeedback({
      status: "failed",
      invoiceId: "invoice-1",
      message: "already delivered",
      invoice: invoice({ deliveryState: "SENT" })
    })?.message).toBe("QR sent.");
    expect(cashAppAttemptFeedback({ status: "invalid", message: "Enter an amount." })?.temporary).toBe(false);
  });
});
