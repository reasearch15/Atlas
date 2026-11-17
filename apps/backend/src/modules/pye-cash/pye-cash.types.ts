export const pyeCashCreationStates = ["CREATING", "READY", "UNKNOWN", "FAILED"] as const;
export const pyeCashDeliveryStates = ["NOT_SENT", "QUEUED", "SENT", "FAILED"] as const;
export const pyeCashPaymentStates = ["UNCONFIRMED", "PAID", "EXPIRED", "UNKNOWN"] as const;

export type PyeCashCreationState = (typeof pyeCashCreationStates)[number];
export type PyeCashDeliveryState = (typeof pyeCashDeliveryStates)[number];
export type PyeCashPaymentState = (typeof pyeCashPaymentStates)[number];

export interface PyeCashConfig {
  readonly enabled: boolean;
  readonly testMode: boolean;
  readonly allowedUserIds: readonly string[];
  readonly allowedChatIds: readonly string[];
  readonly merchant: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly maxAmountCents: number;
  readonly encryptionKey: string;
  readonly staleCreatingMs: number;
}

export interface PyeCashStaff {
  readonly id: string;
  readonly role: "COADMIN" | "STAFF" | "PLATFORM_ADMIN";
  readonly workspaceId: string | null;
}

export interface StoredPyeCashInvoice {
  readonly id: string;
  readonly workspaceId: string;
  readonly telegramChatDbId: string;
  readonly requestedByUserId: string;
  readonly merchant: string;
  readonly amountCents: number;
  readonly idempotencyKey: string;
  readonly providerInvoiceId: string | null;
  readonly lightningInvoiceEncrypted: unknown | null;
  readonly creationState: PyeCashCreationState;
  readonly deliveryState: PyeCashDeliveryState;
  readonly paymentState: PyeCashPaymentState;
  readonly telegramMessageId: string | null;
  readonly mediaStorageKey: string | null;
  readonly expiresAt: string | null;
  readonly errorCategory: string | null;
  readonly statusVerifiedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PyeCashCapability {
  readonly enabled: boolean;
  readonly testMode: boolean;
  readonly maxAmountCents: number;
  readonly userAllowed: boolean;
  readonly chatAllowed: boolean;
  readonly canSend: boolean;
}

export interface PublicPyeCashInvoice {
  readonly id: string;
  readonly chatId: string;
  readonly amountCents: number;
  readonly merchant: string;
  readonly idempotencyKey: string;
  readonly providerInvoiceId: string | null;
  readonly creationState: PyeCashCreationState;
  readonly deliveryState: PyeCashDeliveryState;
  readonly paymentState: PyeCashPaymentState;
  readonly telegramMessageId: string | null;
  readonly expiresAt: string | null;
  readonly errorCategory: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ProviderAttempt =
  | { readonly kind: "created"; readonly body: unknown }
  | { readonly kind: "rejected"; readonly category: string }
  | { readonly kind: "uncertain"; readonly category: string };

export interface PyeCashProvider {
  createInvoice(input: { readonly amountCents: number; readonly merchant: string }): Promise<ProviderAttempt>;
}

export interface InvoiceReservation {
  readonly record: StoredPyeCashInvoice;
  readonly created: boolean;
}

export interface PyeCashInvoiceStore {
  reserve(input: {
    readonly workspaceId: string;
    readonly telegramChatDbId: string;
    readonly requestedByUserId: string;
    readonly merchant: string;
    readonly amountCents: number;
    readonly idempotencyKey: string;
    readonly now: Date;
  }): Promise<InvoiceReservation>;
  update(
    id: string,
    patch: Partial<
      Pick<
        StoredPyeCashInvoice,
        | "providerInvoiceId"
        | "lightningInvoiceEncrypted"
        | "creationState"
        | "deliveryState"
        | "paymentState"
        | "telegramMessageId"
        | "mediaStorageKey"
        | "expiresAt"
        | "errorCategory"
        | "statusVerifiedAt"
      >
    >,
    now: Date
  ): Promise<StoredPyeCashInvoice>;
  compareAndSet(
    id: string,
    expected: {
      readonly creationState?: PyeCashCreationState;
      readonly deliveryState?: PyeCashDeliveryState;
      readonly updatedAt?: string;
    },
    patch: Parameters<PyeCashInvoiceStore["update"]>[1],
    now: Date
  ): Promise<StoredPyeCashInvoice | null>;
  get(id: string): Promise<StoredPyeCashInvoice | null>;
  listForChat(workspaceId: string, telegramChatDbId: string, limit: number): Promise<readonly StoredPyeCashInvoice[]>;
}

export interface PyeCashChatRecord {
  readonly id: string;
  readonly telegramAccountId: string;
  readonly telegramChatId: string;
}

export interface PyeCashChatLookup {
  findInWorkspace(workspaceId: string, chatId: string): Promise<PyeCashChatRecord | null>;
}

export interface PyeCashMediaStore {
  putPng(input: {
    readonly workspaceId: string;
    readonly telegramAccountId: string;
    readonly telegramChatId: string;
    readonly invoiceId: string;
    readonly png: Buffer;
  }): Promise<string>;
}

export interface PyeCashQrDelivery {
  enqueue(input: {
    readonly user: PyeCashStaff & { readonly sessionId: string; readonly name: string; readonly email?: string };
    readonly chat: PyeCashChatRecord;
    readonly invoiceId: string;
    readonly storageKey: string;
    readonly fileSizeBytes: number;
    readonly caption: string;
    readonly idempotencyKey: string;
    readonly resend: boolean;
  }): Promise<{
    readonly outcome: "queued" | "already_queued" | "already_sent" | "reconciled_failed";
    readonly telegramMessageId: string | null;
  }>;
}

export interface PyeCashLogEvent {
  readonly event: "pye_cash.invoice";
  readonly invoiceId: string;
  readonly creationState: PyeCashCreationState;
  readonly errorCategory: string | null;
  readonly providerInvoiceId: string | null;
}

export function toPublicInvoice(record: StoredPyeCashInvoice): PublicPyeCashInvoice {
  return {
    id: record.id,
    chatId: record.telegramChatDbId,
    amountCents: record.amountCents,
    merchant: record.merchant,
    idempotencyKey: record.idempotencyKey,
    providerInvoiceId: record.providerInvoiceId,
    creationState: record.creationState,
    deliveryState: record.deliveryState,
    paymentState: record.paymentState,
    telegramMessageId: record.telegramMessageId,
    expiresAt: record.expiresAt,
    errorCategory: record.errorCategory,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}
