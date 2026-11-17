import { hasPermission, type Role } from "@atlas/shared";
import { decryptSecret, type EncryptedSecret } from "@atlas/shared/session-encryption";
import { AppError, forbidden, unauthorized } from "../../utils/errors";
import { renderPyeCashCard } from "./pye-cash-card";
import { createInvoiceBodySchema, validateProviderInvoice } from "./pye-cash.schema";
import {
  toPublicInvoice,
  type PyeCashChatLookup,
  type PyeCashConfig,
  type PyeCashInvoiceStore,
  type PyeCashLogEvent,
  type PyeCashMediaStore,
  type PyeCashProvider,
  type PyeCashQrDelivery,
  type PyeCashStaff,
  type PyeCashCapability,
  type PublicPyeCashInvoice,
  type StoredPyeCashInvoice
} from "./pye-cash.types";

export interface PyeCashCreateResult {
  readonly statusCode: 200 | 201 | 202 | 422;
  readonly invoice: PublicPyeCashInvoice;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface PyeCashServiceDependencies {
  readonly config: PyeCashConfig;
  readonly provider: PyeCashProvider;
  readonly invoices: PyeCashInvoiceStore;
  readonly chats: PyeCashChatLookup;
  readonly encrypt: (plaintext: string) => EncryptedSecret;
  readonly decrypt?: (envelope: EncryptedSecret) => string;
  readonly media?: PyeCashMediaStore;
  readonly delivery?: PyeCashQrDelivery;
  readonly now?: () => Date;
  readonly log?: (event: PyeCashLogEvent) => void;
}

/**
 * Reserves one invoice row, calls the provider at most once, and never sends Telegram.
 */
export class PyeCashService {
  public constructor(private readonly deps: PyeCashServiceDependencies) {}

  public async create(user: PyeCashStaff | undefined, chatId: string, body: unknown): Promise<PyeCashCreateResult> {
    assertCashAppSender(user);
    const input = createInvoiceBodySchema.parse(body);
    if (input.amountCents > this.deps.config.maxAmountCents) {
      throw new AppError(400, "AMOUNT_EXCEEDS_LIMIT", "Amount is above the configured limit.");
    }
    const staff = user as PyeCashStaff;
    const workspaceId = staff.workspaceId as string;
    const chat = await this.deps.chats.findInWorkspace(workspaceId, chatId);
    if (!chat) {
      throw new AppError(404, "CHAT_NOT_FOUND", "Chat was not found in this workspace.");
    }
    if (!this.deps.config.enabled) {
      throw new AppError(403, "PYE_CASH_DISABLED", "Cash App QR payments are disabled.");
    }
    this.assertTestAccess(staff, chat.id, input.amountCents);

    const now = this.clock();
    const reserved = await this.deps.invoices.reserve({
      workspaceId,
      telegramChatDbId: chat.id,
      requestedByUserId: staff.id,
      merchant: this.deps.config.merchant,
      amountCents: input.amountCents,
      idempotencyKey: input.idempotencyKey,
      now
    });
    if (!reserved.created) {
      return this.replay(reserved.record, chat.id, input.amountCents);
    }

    let attempt;
    try {
      attempt = await this.deps.provider.createInvoice({
        amountCents: input.amountCents,
        merchant: this.deps.config.merchant
      });
    } catch {
      const unknown = await this.settle(reserved.record.id, {
        creationState: "UNKNOWN",
        errorCategory: "PROVIDER_THREW"
      });
      return { statusCode: 202, invoice: this.publish(unknown) };
    }

    if (attempt.kind === "rejected") {
      const failed = await this.settle(reserved.record.id, {
        creationState: "FAILED",
        errorCategory: attempt.category
      });
      if (failed.creationState !== "FAILED") {
        return { statusCode: 202, invoice: this.publish(failed) };
      }
      return {
        statusCode: 422,
        invoice: this.publish(failed),
        error: { code: "PYE_CASH_REJECTED", message: "The payment provider rejected this invoice." }
      };
    }

    if (attempt.kind === "uncertain") {
      this.logProvider(reserved.record.id, attempt.category, attempt.httpStatus ?? null, attempt.contentType ?? null);
      const unknown = await this.settle(reserved.record.id, {
        creationState: "UNKNOWN",
        errorCategory: attempt.category
      });
      return { statusCode: 202, invoice: this.publish(unknown) };
    }

    const validated = validateProviderInvoice(attempt.body, input.amountCents, this.clock().getTime());
    if (!validated.ok) {
      this.logProvider(reserved.record.id, validated.reason, attempt.httpStatus ?? null, attempt.contentType ?? null, validated.expiration);
      const unknown = await this.settle(reserved.record.id, {
        creationState: "UNKNOWN",
        errorCategory: validated.reason,
        ...(validated.providerInvoiceId ? { providerInvoiceId: validated.providerInvoiceId } : {})
      });
      return { statusCode: 202, invoice: this.publish(unknown) };
    }

    const encrypted = this.deps.encrypt(validated.invoice.lightningInvoice);
    const readyPatch = {
      creationState: "READY" as const,
      providerInvoiceId: validated.invoice.providerInvoiceId,
      lightningInvoiceEncrypted: encrypted,
      expiresAt: validated.invoice.expiresAt,
      errorCategory: null
    };
    try {
      const ready = await this.settle(reserved.record.id, readyPatch);
      return { statusCode: ready.creationState === "READY" ? 201 : 202, invoice: this.publish(ready) };
    } catch {
      try {
        const unknown = await this.deps.invoices.update(
          reserved.record.id,
          { ...readyPatch, creationState: "UNKNOWN", errorCategory: "PERSIST_FAILED" },
          this.clock()
        );
        return { statusCode: 202, invoice: this.publish(unknown) };
      } catch {
        throw new AppError(
          503,
          "PYE_CASH_OUTCOME_UNCERTAIN",
          "The provider may have created an invoice, but Atlas could not store the result. Do not retry automatically."
        );
      }
    }
  }

  public async capability(user: PyeCashStaff | undefined, chatId: string): Promise<PyeCashCapability> {
    assertCashAppSender(user);
    const staff = user as PyeCashStaff;
    const chat = await this.deps.chats.findInWorkspace(staff.workspaceId as string, chatId);
    if (!chat) throw new AppError(404, "CHAT_NOT_FOUND", "Chat was not found in this workspace.");
    const testMode = this.deps.config.testMode;
    const userAllowed = !testMode || this.deps.config.allowedUserIds.includes(staff.id);
    const chatAllowed = !testMode || this.deps.config.allowedChatIds.includes(chat.id);
    const maxAmountCents = testMode ? Math.min(this.deps.config.maxAmountCents, PYE_CASH_TEST_MAX_CENTS) : this.deps.config.maxAmountCents;
    return {
      enabled: this.deps.config.enabled,
      testMode,
      maxAmountCents,
      userAllowed,
      chatAllowed,
      canSend: this.deps.config.enabled && userAllowed && chatAllowed
    };
  }

  public async list(user: PyeCashStaff | undefined, chatId: string, limit: number): Promise<readonly PublicPyeCashInvoice[]> {
    assertCashAppSender(user);
    const staff = user as PyeCashStaff;
    const chat = await this.deps.chats.findInWorkspace(staff.workspaceId as string, chatId);
    if (!chat) {
      throw new AppError(404, "CHAT_NOT_FOUND", "Chat was not found in this workspace.");
    }
    this.assertTestAccess(staff, chat.id);
    const rows = await this.deps.invoices.listForChat(staff.workspaceId as string, chat.id, limit);
    return rows.map(toPublicInvoice);
  }

  public async queueQr(
    user: (PyeCashStaff & { readonly sessionId: string; readonly name: string }) | undefined,
    chatId: string,
    invoiceId: string
  ): Promise<PyeCashCreateResult> {
    assertCashAppSender(user);
    const staff = user as PyeCashStaff & { sessionId: string; name: string };
    if (!this.deps.config.enabled) {
      throw new AppError(403, "PYE_CASH_DISABLED", "Cash App QR payments are disabled.");
    }
    const chat = await this.deps.chats.findInWorkspace(staff.workspaceId as string, chatId);
    if (!chat) throw new AppError(404, "CHAT_NOT_FOUND", "Chat was not found in this workspace.");
    this.assertTestAccess(staff, chat.id);
    const invoice = await this.deps.invoices.get(invoiceId);
    if (invoice && invoice.workspaceId === staff.workspaceId && invoice.telegramChatDbId === chat.id) {
      this.assertTestAccess(staff, chat.id, invoice.amountCents);
    }
    if (!invoice || invoice.workspaceId !== staff.workspaceId || invoice.telegramChatDbId !== chat.id) {
      throw new AppError(404, "INVOICE_NOT_FOUND", "Invoice was not found for this chat.");
    }
    if (invoice.creationState !== "READY" || !invoice.providerInvoiceId || !invoice.lightningInvoiceEncrypted) {
      throw new AppError(409, "PYE_CASH_NOT_READY", "Only a confirmed invoice can be sent.");
    }
    if (invoice.expiresAt && Date.parse(invoice.expiresAt) <= this.clock().getTime()) {
      await this.deps.invoices.update(invoice.id, { paymentState: "EXPIRED" }, this.clock());
      throw new AppError(409, "INVOICE_EXPIRED", "This invoice has expired. Create a new one.");
    }
    if (invoice.deliveryState === "SENT") {
      return { statusCode: 200, invoice: this.publish(invoice) };
    }
    if (invoice.errorCategory === "TELEGRAM_AMBIGUOUS") {
      throw new AppError(409, "PYE_CASH_DELIVERY_AMBIGUOUS", "Telegram may already have this QR. It will not be sent again.");
    }
    if (!this.deps.media || !this.deps.delivery) {
      throw new AppError(503, "PYE_CASH_DELIVERY_UNAVAILABLE", "QR delivery is not configured.");
    }
    const resend = invoice.deliveryState === "FAILED" && invoice.errorCategory === "TELEGRAM_FAILED";
    let storageKey = invoice.mediaStorageKey;
    let fileSizeBytes = 0;
    try {
      if (!storageKey) {
        const bolt11 = (this.deps.decrypt ?? ((envelope: EncryptedSecret) => decryptSecret(envelope, this.deps.config.encryptionKey)))(
          invoice.lightningInvoiceEncrypted as EncryptedSecret
        );
        const card = await renderPyeCashCard({
          bolt11,
          amountCents: invoice.amountCents,
          expiresAt: invoice.expiresAt ?? this.clock().toISOString()
        });
        fileSizeBytes = card.png.length;
        storageKey = await this.deps.media.putPng({
          workspaceId: invoice.workspaceId,
          telegramAccountId: chat.telegramAccountId,
          telegramChatId: chat.telegramChatId,
          invoiceId: invoice.id,
          png: card.png
        });
        await this.deps.invoices.update(invoice.id, { mediaStorageKey: storageKey }, this.clock());
      }
    } catch (error) {
      await this.deps.invoices
        .update(invoice.id, { deliveryState: "FAILED", errorCategory: "DELIVERY_FAILED" }, this.clock())
        .catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError(502, "PYE_CASH_DELIVERY_FAILED", "The QR could not be stored or queued.");
    }
    const caption = paymentCaption(invoice.amountCents, this.deps.config.baseUrl, invoice.providerInvoiceId as string);
    const outcome = await this.commitDelivery({
      user: staff,
      chat,
      invoiceId: invoice.id,
      storageKey,
      fileSizeBytes,
      caption,
      idempotencyKey: `pye-cash-qr:${invoice.id}`,
      resend
    });
    const latest = await this.deps.invoices.get(invoice.id);
    if (!latest) throw new AppError(404, "INVOICE_NOT_FOUND", "Invoice was not found for this chat.");
    const statusCode = outcome.outcome === "queued" || outcome.outcome === "already_queued" ? 202 : 200;
    return { statusCode, invoice: this.publish(latest) };
  }

  /**
   * Writes the outbound command and QUEUED invoice together.
   * A second attempt only recovers a command that was committed before the queue job existed.
   */
  private async commitDelivery(input: Parameters<PyeCashQrDelivery["enqueue"]>[0]) {
    const delivery = this.deps.delivery;
    if (!delivery) throw new AppError(503, "PYE_CASH_DELIVERY_UNAVAILABLE", "QR delivery is not configured.");
    try {
      return await delivery.enqueue(input);
    } catch (error) {
      if (error instanceof AppError) throw error;
      try {
        return await delivery.enqueue(input);
      } catch (retryError) {
        if (retryError instanceof AppError) throw retryError;
        const current = await this.deps.invoices.get(input.invoiceId);
        if (current?.deliveryState === "QUEUED") {
          return { outcome: "already_queued" as const, telegramMessageId: current.telegramMessageId };
        }
        await this.deps.invoices
          .update(input.invoiceId, { deliveryState: "FAILED", errorCategory: "DELIVERY_FAILED" }, this.clock())
          .catch(() => undefined);
        throw new AppError(502, "PYE_CASH_DELIVERY_FAILED", "The QR could not be stored or queued.");
      }
    }
  }

  private async replay(
    record: StoredPyeCashInvoice,
    chatId: string,
    amountCents: number,
    depth = 0
  ): Promise<PyeCashCreateResult> {
    if (record.telegramChatDbId !== chatId || record.amountCents !== amountCents) {
      throw new AppError(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was already used for a different invoice.");
    }
    if (record.creationState === "CREATING") {
      const age = this.clock().getTime() - Date.parse(record.updatedAt);
      if (age >= this.deps.config.staleCreatingMs) {
        const unknown = await this.deps.invoices.compareAndSet(
          record.id,
          { creationState: "CREATING", updatedAt: record.updatedAt },
          { creationState: "UNKNOWN", errorCategory: "STALE_CREATING" },
          this.clock()
        );
        if (unknown) return { statusCode: 202, invoice: this.publish(unknown) };
        const current = await this.deps.invoices.get(record.id);
        if (!current || depth > 0) {
          if (!current) {
            throw new AppError(503, "PYE_CASH_OUTCOME_UNCERTAIN", "The invoice record changed during recovery.");
          }
          return { statusCode: current.creationState === "READY" ? 200 : 202, invoice: this.publish(current) };
        }
        return this.replay(current, chatId, amountCents, depth + 1);
      }
      return { statusCode: 202, invoice: this.publish(record) };
    }
    if (record.creationState === "FAILED") {
      return {
        statusCode: 422,
        invoice: this.publish(record),
        error: { code: "PYE_CASH_REJECTED", message: "The payment provider rejected this invoice." }
      };
    }
    return {
      statusCode: record.creationState === "READY" ? 200 : 202,
      invoice: this.publish(record)
    };
  }

  private async settle(
    id: string,
    patch: Parameters<PyeCashInvoiceStore["update"]>[1]
  ): Promise<StoredPyeCashInvoice> {
    const updated = await this.deps.invoices.compareAndSet(id, { creationState: "CREATING" }, patch, this.clock());
    if (updated) return updated;
    if (patch.creationState === "READY" && patch.providerInvoiceId) {
      const current = await this.deps.invoices.get(id);
      if (current?.creationState === "UNKNOWN" && !current.providerInvoiceId) {
        const recovered = await this.deps.invoices.compareAndSet(
          id,
          { creationState: "UNKNOWN", updatedAt: current.updatedAt },
          patch,
          this.clock()
        );
        if (recovered) return recovered;
      }
    }
    const current = await this.deps.invoices.get(id);
    if (!current) {
      throw new AppError(
        503,
        "PYE_CASH_OUTCOME_UNCERTAIN",
        "The provider may have created an invoice, but Atlas could not store the result. Do not retry automatically."
      );
    }
    return current;
  }

  private async safeUpdate(
    id: string,
    patch: Parameters<PyeCashInvoiceStore["update"]>[1]
  ): Promise<StoredPyeCashInvoice> {
    try {
      return await this.deps.invoices.update(id, patch, this.clock());
    } catch {
      throw new AppError(
        503,
        "PYE_CASH_OUTCOME_UNCERTAIN",
        "The provider may have created an invoice, but Atlas could not store the result. Do not retry automatically."
      );
    }
  }

  private publish(record: StoredPyeCashInvoice): PublicPyeCashInvoice {
    this.deps.log?.({
      event: "pye_cash.invoice",
      correlationId: record.id,
      invoiceId: record.id,
      creationState: record.creationState,
      reason: record.errorCategory,
      httpStatus: null,
      contentType: null,
      expirationType: null,
      expirationFormat: null
    });
    return toPublicInvoice(record);
  }

  private logProvider(
    correlationId: string,
    reason: string,
    httpStatus: number | null,
    contentType: string | null,
    expiration?: { readonly type: string; readonly format: string }
  ): void {
    this.deps.log?.({
      event: "pye_cash.provider_response",
      correlationId,
      invoiceId: correlationId,
      creationState: null,
      reason,
      httpStatus,
      contentType,
      expirationType: expiration?.type ?? null,
      expirationFormat: expiration?.format ?? null
    });
  }

  private clock(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private assertTestAccess(user: PyeCashStaff, chatId: string, amountCents?: number): void {
    if (!this.deps.config.testMode) return;
    if (!this.deps.config.allowedUserIds.includes(user.id)) {
      throw new AppError(403, "PYE_CASH_STAFF_NOT_APPROVED", "Cash App QR is limited to approved staff during testing.");
    }
    if (!this.deps.config.allowedChatIds.includes(chatId)) {
      throw new AppError(403, "PYE_CASH_CHAT_NOT_APPROVED", "This chat is not approved for Cash App QR testing.");
    }
    if (amountCents !== undefined && amountCents > PYE_CASH_TEST_MAX_CENTS) {
      throw new AppError(400, "PYE_CASH_TEST_LIMIT", "Test mode allows invoices up to $5.00.");
    }
  }
}

const PYE_CASH_TEST_MAX_CENTS = 500;

function paymentCaption(amountCents: number, baseUrl: string, providerInvoiceId: string): string {
  const amount = `$${(amountCents / 100).toFixed(2)}`;
  const page = `${baseUrl.replace(/\/$/, "")}/invoice/${encodeURIComponent(providerInvoiceId)}`;
  return `Pay ${amount}. Scan the QR in Cash App, or open ${page}. Use this QR once.`;
}

export function assertCashAppSender(user: PyeCashStaff | undefined): void {
  if (!user) throw unauthorized();
  if (user.role !== "COADMIN" && user.role !== "STAFF") throw forbidden();
  if (!user.workspaceId) throw forbidden();
  if (!hasPermission(user.role as Role, "payments:cash-app:send")) throw forbidden();
  if (!hasPermission(user.role as Role, "telegram:message:send")) throw forbidden();
}
