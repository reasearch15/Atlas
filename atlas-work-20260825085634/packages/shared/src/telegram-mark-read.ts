/**
 * Helpers for Telegram mark-read boundaries.
 * Never use pending:/upload: Atlas placeholders as Telegram ReadHistory max IDs.
 */

import { isAtlasPendingTelegramMessageId } from "./message-attribution";

/**
 * True when the id is a real Telegram numeric message id (not an Atlas local placeholder).
 */
export function isRemoteTelegramMessageId(telegramMessageId: string | null | undefined): boolean {
  if (!telegramMessageId) return false;
  const value = telegramMessageId.trim();
  if (!value || isAtlasPendingTelegramMessageId(value)) return false;
  return /^-?\d+$/.test(value);
}

/**
 * Picks the newest remote Telegram message id from candidates (newest-first).
 * Prefers INBOUND/RECEIVED when direction metadata is available.
 */
export function resolveMarkReadMaxTelegramMessageId(
  candidates: ReadonlyArray<{
    readonly telegramMessageId: string;
    readonly direction?: "INBOUND" | "OUTBOUND" | string | null;
    readonly sendStatus?: string | null;
    readonly deletedAt?: Date | string | null;
  }>
): string | null {
  let bestInbound: string | null = null;
  let bestAny: string | null = null;

  for (const row of candidates) {
    if (row.deletedAt) continue;
    if (!isRemoteTelegramMessageId(row.telegramMessageId)) continue;
    const status = row.sendStatus ?? "";
    if (status === "FAILED_RETRYABLE" || status === "FAILED_PERMANENT" || status === "QUEUED" || status === "SENDING") {
      // Still allow remote ids that already exist on Telegram for outbound SENT/DELIVERED.
      if (status === "QUEUED" || status === "SENDING") continue;
    }
    if (!bestAny) bestAny = row.telegramMessageId;
    if (!bestInbound && row.direction === "INBOUND") {
      bestInbound = row.telegramMessageId;
    }
    if (bestInbound && bestAny) break;
  }

  return bestInbound ?? bestAny;
}
