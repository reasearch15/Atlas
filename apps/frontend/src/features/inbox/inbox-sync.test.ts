import { describe, expect, it } from "vitest";
import { applyChatActivity, mergeAndDeduplicate, sortConversations, toInboxConversation } from "./inbox-utils";
import type { TelegramChatDto, TelegramMessageDto } from "@atlas/shared";
import { emptyMediaFields } from "./media-message-helpers";

function chat(partial: Partial<TelegramChatDto> & Pick<TelegramChatDto, "id" | "title">): TelegramChatDto {
  return {
    telegramAccountId: "acc",
    telegramChatId: partial.id,
    chatType: "PRIVATE",
    username: null,
    firstName: null,
    lastName: null,
    phone: null,
    lastMessagePreview: null,
    lastMessageAt: null,
    lastMessageDirection: null,
    unreadCount: 0,
    isPinned: false,
    isBot: false,
    identityResolved: true,
    crmStatus: "OPEN",
    assignedUserId: null,
    assignedUserName: null,
    assignedAt: null,
    claimedAt: null,
    needsCrmAttention: false,
    tags: [],
    ...partial
  };
}

describe("inbox realtime merge", () => {
  it("moves the correct conversation on new activity and keeps selection by id", () => {
    const rows = sortConversations([
      toInboxConversation(chat({ id: "a", title: "A", lastMessageAt: "2026-01-01T00:00:00.000Z" }), "acc"),
      toInboxConversation(chat({ id: "b", title: "B", lastMessageAt: "2026-01-02T00:00:00.000Z" }), "acc")
    ]);
    const selectedId = "a";
    const next = applyChatActivity(rows, {
      chatId: "a",
      previewText: "hello",
      sentAt: "2026-01-03T00:00:00.000Z",
      direction: "INBOUND",
      bumpUnread: true
    });
    expect(next[0]?.chat.id).toBe("a");
    expect(next.find((row) => row.chat.id === selectedId)?.chat.lastMessagePreview).toBe("hello");
    expect(next.filter((row) => row.chat.id === "a")).toHaveLength(1);
  });

  it("upgrades Unknown User title from chat.updated identity fields", () => {
    const rows = [
      toInboxConversation(chat({ id: "c1", title: "Unknown User", username: null }), "acc")
    ];
    const next = applyChatActivity(rows, {
      chatId: "c1",
      previewText: "hi",
      sentAt: "2026-01-03T00:00:00.000Z",
      direction: "INBOUND",
      title: "joemas020",
      username: "joemas020",
      identityResolved: true
    });
    expect(next[0]?.chat.title).toBe("joemas020");
    expect(next[0]?.displayTitle).not.toMatch(/^unknown/i);
  });

  it("upgrades temporary Telegram user title on the same row without duplicates", () => {
    const rows = [
      toInboxConversation(
        chat({
          id: "c2",
          title: "Telegram user 8291583373",
          telegramChatId: "8291583373",
          identityResolved: false,
          unreadCount: 2,
          lastMessagePreview: "first"
        }),
        "acc"
      )
    ];
    const next = applyChatActivity(rows, {
      chatId: "c2",
      previewText: "first",
      sentAt: "2026-01-03T00:00:00.000Z",
      direction: "INBOUND",
      title: "John Smith",
      firstName: "John",
      lastName: "Smith",
      identityResolved: true,
      unreadCount: 2
    });
    expect(next).toHaveLength(1);
    expect(next[0]?.chat.title).toBe("John Smith");
    expect(next[0]?.chat.unreadCount).toBe(2);
    expect(next[0]?.chat.lastMessagePreview).toBe("first");
    expect(next[0]?.displayTitle).toBe("John Smith");
  });

  it("inserts a new conversation from chat.updated without naked numeric title", () => {
    const next = applyChatActivity([], {
      chatId: "new-1",
      telegramAccountId: "acc",
      telegramChatId: "8291583373",
      previewText: "hello",
      sentAt: "2026-01-03T00:00:00.000Z",
      direction: "INBOUND",
      title: "Telegram user 8291583373",
      unreadCount: 1,
      bumpUnread: false
    });
    expect(next).toHaveLength(1);
    expect(next[0]?.chat.title).toBe("Telegram user 8291583373");
    expect(next[0]?.displayTitle).not.toBe("8291583373");
    expect(next[0]?.displayTitle).toMatch(/Telegram user/i);
  });

  it("preserves mediaUrl when a status update arrives without urls", () => {
    const proxyUrl = "/api/telegram/messages/m1/media";
    const base: TelegramMessageDto = {
      id: "m1",
      telegramAccountId: "acc",
      chatId: "c1",
      telegramMessageId: "10",
      direction: "OUTBOUND",
      contentType: "PHOTO",
      mediaType: "PHOTO",
      text: "",
      sentAt: "2026-01-01T00:00:00.000Z",
      editedAt: null,
      isEdited: false,
      isDeleted: false,
      senderTelegramUserId: null,
      senderDisplayName: null,
      replyToTelegramMessageId: null,
      internalSenderUserId: null,
      internalSenderSessionId: null,
      internalSenderRole: null,
      internalSenderName: null,
      attributionSource: "ATLAS",
      sendStatus: "SENT",
      ...emptyMediaFields(),
      mediaUrl: proxyUrl,
      mediaDownloadState: "STORED",
      mediaUploadState: "STORED"
    };
    const merged = mergeAndDeduplicate([base], {
      ...base,
      sendStatus: "DELIVERED",
      mediaUrl: null
    });
    expect(merged[0]?.mediaUrl).toBe(proxyUrl);
    expect(merged[0]?.sendStatus).toBe("DELIVERED");
  });

  it("rejects private MinIO URLs during realtime merge", () => {
    const proxyUrl = "/api/telegram/messages/m1/media";
    const base: TelegramMessageDto = {
      id: "m1",
      telegramAccountId: "acc",
      chatId: "c1",
      telegramMessageId: "10",
      direction: "INBOUND",
      contentType: "VIDEO",
      mediaType: "VIDEO",
      text: "",
      sentAt: "2026-01-01T00:00:00.000Z",
      editedAt: null,
      isEdited: false,
      isDeleted: false,
      senderTelegramUserId: null,
      senderDisplayName: null,
      replyToTelegramMessageId: null,
      internalSenderUserId: null,
      internalSenderSessionId: null,
      internalSenderRole: null,
      internalSenderName: null,
      attributionSource: null,
      sendStatus: "SENT",
      ...emptyMediaFields(),
      mediaUrl: proxyUrl,
      mediaDownloadState: "STORED",
      mediaUploadState: "STORED"
    };
    const merged = mergeAndDeduplicate([base], {
      ...base,
      mediaUrl: "http://127.0.0.1:9000/bucket/key?X-Amz-Signature=abc"
    });
    expect(merged[0]?.mediaUrl).toBe(proxyUrl);
  });

  it("does not duplicate rows for repeated realtime events", () => {
    const rows = [toInboxConversation(chat({ id: "x", title: "X", lastMessageAt: "2026-01-01T00:00:00.000Z" }), "acc")];
    const once = applyChatActivity(rows, {
      chatId: "x",
      previewText: "1",
      sentAt: "2026-01-02T00:00:00.000Z",
      direction: "INBOUND",
      unreadCount: 1
    });
    const twice = applyChatActivity(once, {
      chatId: "x",
      previewText: "1",
      sentAt: "2026-01-02T00:00:00.000Z",
      direction: "INBOUND",
      unreadCount: 1
    });
    expect(twice.filter((row) => row.chat.id === "x")).toHaveLength(1);
  });
});
