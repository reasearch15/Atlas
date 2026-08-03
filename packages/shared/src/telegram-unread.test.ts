import { describe, expect, it } from "vitest";
import { resolveSyncedUnreadCount, compareTelegramMessageIds } from "./telegram-unread";
import { shouldIgnoreTelegramDialog } from "./telegram-crm-identity";

describe("resolveSyncedUnreadCount", () => {
  it("uses dialog unread on create", () => {
    expect(
      resolveSyncedUnreadCount({
        dialogUnreadCount: 7,
        existingUnreadCount: null,
        lastReadTelegramMessageId: null,
        dialogTopMessageId: "100",
        isCreate: true
      })
    ).toBe(7);
  });

  it("does not restore stale unread after Atlas mark-read", () => {
    expect(
      resolveSyncedUnreadCount({
        dialogUnreadCount: 7,
        existingUnreadCount: 0,
        lastReadTelegramMessageId: "100",
        dialogTopMessageId: "100"
      })
    ).toBe(0);
  });

  it("adopts dialog unread when a newer message arrives after read", () => {
    expect(
      resolveSyncedUnreadCount({
        dialogUnreadCount: 2,
        existingUnreadCount: 0,
        lastReadTelegramMessageId: "100",
        dialogTopMessageId: "105"
      })
    ).toBe(2);
  });
});

describe("compareTelegramMessageIds", () => {
  it("compares numeric ids", () => {
    expect(compareTelegramMessageIds("9", "10")).toBeLessThan(0);
    expect(compareTelegramMessageIds("10", "10")).toBe(0);
  });
});

describe("service dialog filtering safety", () => {
  it("does not remove a normal private user named Telegram", () => {
    expect(
      shouldIgnoreTelegramDialog({
        telegramChatId: "999888777",
        chatType: "PRIVATE",
        title: "Telegram",
        firstName: "Telegram",
        lastName: "User",
        isSupport: false,
        isSelf: false,
        isArchived: false
      })
    ).toBe(false);
  });

  it("still ignores official service peer ids", () => {
    expect(
      shouldIgnoreTelegramDialog({
        telegramChatId: "777000",
        chatType: "PRIVATE",
        title: "Telegram",
        firstName: "Telegram"
      })
    ).toBe(true);
  });
});
