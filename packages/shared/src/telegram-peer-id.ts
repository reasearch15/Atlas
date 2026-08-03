/**
 * Canonical Telegram peer id helpers.
 * Channels/supergroups use -100{id}; basic groups use -{id}; private users stay positive.
 */

export type TelegramPeerChatType = "PRIVATE" | "GROUP" | "SUPERGROUP" | "CHANNEL" | "UNKNOWN";

/**
 * Returns Telegram's marked peer id string used as the stable chat key.
 */
export function normalizeMarkedTelegramChatId(
  rawId: string | number | null | undefined,
  chatType: TelegramPeerChatType | string
): string {
  if (rawId === null || rawId === undefined) return "";
  const id = String(rawId).trim();
  if (!/^-?\d+$/.test(id)) return id;

  if (id.startsWith("-100") && id.length > 4) {
    return id;
  }
  if (id.startsWith("-")) {
    return id;
  }

  const type = String(chatType).toUpperCase();
  if (type === "CHANNEL" || type === "SUPERGROUP") {
    return `-100${id}`;
  }
  if (type === "GROUP") {
    return `-${id}`;
  }
  return id;
}

/**
 * Returns true when two stored telegram_chat_id values refer to the same peer.
 */
export function areEquivalentTelegramChatIds(
  left: string,
  right: string,
  chatType: TelegramPeerChatType | string
): boolean {
  if (left === right) return true;
  const markedLeft = normalizeMarkedTelegramChatId(left, chatType);
  const markedRight = normalizeMarkedTelegramChatId(right, chatType);
  return markedLeft.length > 0 && markedLeft === markedRight;
}
