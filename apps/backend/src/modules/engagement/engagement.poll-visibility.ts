import { VISIBLE_NATIVE_POLL_LIMIT } from "./engagement.constants";

/**
 * Durable refs for native engagement poll sets still visible in a Telegram channel.
 * A set is the decorative header message plus the native poll message.
 * Selection is restricted to rows with both telegramPollId and telegramMessageId
 * so only polls created by this system can be chosen for cleanup.
 */
export interface VisibleNativePollRef {
  readonly id: string;
  readonly channelId: string;
  readonly telegramMessageId: string;
  readonly telegramPollId: string;
  readonly telegramHeaderMessageId: string | null;
  readonly postedAt: Date | null;
}

/**
 * Returns the oldest native poll sets that must be deleted so at most
 * `keepLimit` remain. Never invents message IDs — only returns refs the caller
 * already loaded from durable engagement_polls rows.
 */
export function selectNativePollMessagesToPrune<T extends VisibleNativePollRef>(
  polls: readonly T[],
  keepLimit: number = VISIBLE_NATIVE_POLL_LIMIT
): T[] {
  if (keepLimit < 0) {
    throw new Error(`keepLimit must be >= 0, got ${keepLimit}`);
  }
  const eligible = polls.filter(
    (poll) =>
      Boolean(poll.channelId) &&
      Boolean(poll.telegramMessageId) &&
      Boolean(poll.telegramPollId)
  );
  const sorted = [...eligible].sort((a, b) => {
    const aTime = a.postedAt?.getTime() ?? 0;
    const bTime = b.postedAt?.getTime() ?? 0;
    if (aTime !== bTime) return aTime - bTime;
    return a.id.localeCompare(b.id);
  });
  if (sorted.length <= keepLimit) return [];
  return sorted.slice(0, sorted.length - keepLimit);
}
