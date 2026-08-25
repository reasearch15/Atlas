/**
 * Resolves durable unread count when Telegram dialog sync collides with Atlas read state.
 *
 * Source of truth after Atlas mark-read:
 * - DB unreadCount is authoritative until Telegram confirms via lower dialog unread
 *   OR a newer top message arrives after lastReadTelegramMessageId.
 */

export interface SyncedUnreadInput {
  readonly dialogUnreadCount: number;
  readonly existingUnreadCount: number | null | undefined;
  readonly lastReadTelegramMessageId: string | null | undefined;
  readonly dialogTopMessageId: string | null | undefined;
  /** True on first create (no existing row). */
  readonly isCreate?: boolean;
}

/**
 * Compares Telegram message ids as integers when possible (GramJS ids are integers).
 */
export function compareTelegramMessageIds(left: string | null | undefined, right: string | null | undefined): number {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  const leftNum = Number(left);
  const rightNum = Number(right);
  if (Number.isFinite(leftNum) && Number.isFinite(rightNum)) {
    return leftNum === rightNum ? 0 : leftNum < rightNum ? -1 : 1;
  }
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * Returns the unread count to persist during dialog sync.
 */
export function resolveSyncedUnreadCount(input: SyncedUnreadInput): number {
  const dialogUnread = Math.max(0, Math.floor(input.dialogUnreadCount));
  if (input.isCreate || input.existingUnreadCount == null) {
    return dialogUnread;
  }

  const existing = Math.max(0, Math.floor(input.existingUnreadCount));
  const readMax = input.lastReadTelegramMessageId?.trim() || null;
  if (!readMax) {
    return dialogUnread;
  }

  // Atlas has marked this chat read. Do not restore a stale Telegram unread snapshot
  // unless Telegram reports a newer top message than the read boundary.
  const topId = input.dialogTopMessageId?.trim() || null;
  if (topId && compareTelegramMessageIds(topId, readMax) > 0) {
    return dialogUnread;
  }

  if (existing === 0) {
    return 0;
  }

  // Prefer the lower of the two when Atlas already reduced unread locally.
  return Math.min(existing, dialogUnread);
}
