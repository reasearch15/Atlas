import { describe, expect, it } from "vitest";
import { isRemoteTelegramMessageId, resolveMarkReadMaxTelegramMessageId } from "@atlas/shared";

/**
 * Contract: markChatRead must never enqueue pending:send as Telegram ReadHistory maxId.
 */
describe("markChatRead max id contract", () => {
  it("resolves numeric inbound over pending outbound lastMessageId", () => {
    const chatLastMessageId = "pending:send:5476500286:uuid-1";
    expect(isRemoteTelegramMessageId(chatLastMessageId)).toBe(false);

    const maxId = resolveMarkReadMaxTelegramMessageId([
      { telegramMessageId: chatLastMessageId, direction: "OUTBOUND", sendStatus: "QUEUED" },
      { telegramMessageId: "575", direction: "INBOUND", sendStatus: "RECEIVED" }
    ]);
    expect(maxId).toBe("575");
  });

  it("skips Telegram enqueue when only placeholders exist but local unread can still clear", () => {
    const maxId = resolveMarkReadMaxTelegramMessageId([
      { telegramMessageId: "pending:send:x", direction: "OUTBOUND", sendStatus: "SENDING" }
    ]);
    expect(maxId).toBeNull();
    // API still returns unreadCount: 0 without enqueueing MARK_CHAT_READ.
  });
});
