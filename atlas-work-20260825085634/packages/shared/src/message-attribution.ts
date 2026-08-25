/**
 * Durable origin classification for Telegram messages in Atlas.
 * Distinguishes Atlas-composer sends from native Telegram-app outbound that was later synced.
 */
export type TelegramMessageOriginKind =
  | "OUTBOUND_ATLAS"
  | "OUTBOUND_TELEGRAM_SYNCED"
  | "INBOUND_TELEGRAM";

export type MessageOriginInput = {
  readonly direction: "INBOUND" | "OUTBOUND";
  readonly internalSenderUserId?: string | null;
  readonly attributionSource?: "ATLAS" | "TELEGRAM_EXTERNAL" | null;
  readonly telegramMessageId?: string | null;
};

/**
 * True when the telegram_message_id is still an Atlas-local pending / upload placeholder.
 */
export function isAtlasPendingTelegramMessageId(telegramMessageId: string | null | undefined): boolean {
  if (!telegramMessageId) return false;
  return telegramMessageId.startsWith("pending:") || telegramMessageId.startsWith("upload:");
}

/**
 * Classifies message origin for diagnostics and UI.
 * Atlas outbound = composed in Atlas (internal sender and/or pending: id).
 * Telegram-synced outbound = native app send later mirrored into Atlas (real Telegram id, no Atlas sender).
 */
export function classifyMessageOrigin(input: MessageOriginInput): TelegramMessageOriginKind {
  if (input.direction === "INBOUND") return "INBOUND_TELEGRAM";
  if (
    input.internalSenderUserId ||
    input.attributionSource === "ATLAS" ||
    isAtlasPendingTelegramMessageId(input.telegramMessageId)
  ) {
    return "OUTBOUND_ATLAS";
  }
  return "OUTBOUND_TELEGRAM_SYNCED";
}

/**
 * Aggregates outbound diagnostics without mixing Telegram-app sync into Atlas send success.
 */
export function summarizeOutboundSendDiagnostics(
  messages: ReadonlyArray<
    MessageOriginInput & {
      readonly sendStatus?: string | null;
    }
  >
): {
  readonly atlasSendAttempts: number;
  readonly atlasSendsDelivered: number;
  readonly atlasSendsFailed: number;
  readonly telegramAppOutboundSynced: number;
} {
  let atlasSendAttempts = 0;
  let atlasSendsDelivered = 0;
  let atlasSendsFailed = 0;
  let telegramAppOutboundSynced = 0;

  for (const message of messages) {
    const origin = classifyMessageOrigin(message);
    if (origin === "OUTBOUND_TELEGRAM_SYNCED") {
      telegramAppOutboundSynced += 1;
      continue;
    }
    if (origin !== "OUTBOUND_ATLAS") continue;
    atlasSendAttempts += 1;
    const status = message.sendStatus ?? "";
    if (status === "SENT" || status === "DELIVERED" || status === "READ") {
      atlasSendsDelivered += 1;
    } else if (status === "FAILED_RETRYABLE" || status === "FAILED_PERMANENT") {
      atlasSendsFailed += 1;
    }
  }

  return { atlasSendAttempts, atlasSendsDelivered, atlasSendsFailed, telegramAppOutboundSynced };
}

/**
 * Formats outbound message attribution for Atlas operators.
 * Customers never see these labels — they are Atlas-only UI.
 */
export function formatOutboundAttribution(input: {
  readonly direction: "INBOUND" | "OUTBOUND";
  readonly internalSenderUserId?: string | null;
  readonly internalSenderName?: string | null;
  readonly attributionSource?: "ATLAS" | "TELEGRAM_EXTERNAL" | null;
  readonly viewerUserId?: string | null;
}): string | null {
  if (input.direction !== "OUTBOUND") return null;
  if (input.internalSenderUserId) {
    if (input.viewerUserId && input.viewerUserId === input.internalSenderUserId) {
      return "You";
    }
    const name = input.internalSenderName?.trim();
    return name ? `Sent by ${name}` : "Sent by Atlas operator";
  }
  if (input.attributionSource === "TELEGRAM_EXTERNAL" || !input.internalSenderUserId) {
    return "Sent from Telegram";
  }
  return null;
}

/**
 * Resolves attribution source for persistence/serialization.
 */
export function resolveAttributionSource(internalSenderUserId: string | null | undefined): "ATLAS" | "TELEGRAM_EXTERNAL" | null {
  if (internalSenderUserId) return "ATLAS";
  return "TELEGRAM_EXTERNAL";
}
