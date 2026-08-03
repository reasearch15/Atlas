import { describe, expect, it } from "vitest";
import {
  applyChatActivity,
  computeInboxCounts,
  filterConversations,
  formatMessagePreview,
  mergeAndDeduplicate,
  mergeMessage,
  toInboxConversation
} from "./inbox-utils";
import { emptyMediaFields } from "./media-message-helpers";
import type { TelegramChatDto, TelegramMessageDto } from "@atlas/shared";

function chat(partial: Partial<TelegramChatDto> & Pick<TelegramChatDto, "id" | "title">): TelegramChatDto {
  return {
    telegramAccountId: "acc",
    telegramChatId: partial.id,
    chatType: "PRIVATE",
    username: null,
    firstName: partial.title,
    lastName: null,
    phone: null,
    lastMessagePreview: null,
    lastMessageAt: null,
    lastMessageDirection: null,
    unreadCount: 0,
    isPinned: false,
    isBot: false,
    identityResolved: true,
    crmStatus: "NEW",
    assignedUserId: null,
    assignedUserName: null,
    assignedAt: null,
    claimedAt: null,
    needsCrmAttention: false,
    tags: [],
    ...partial
  };
}

function message(partial: Partial<TelegramMessageDto> & Pick<TelegramMessageDto, "id" | "telegramMessageId" | "text">): TelegramMessageDto {
  return {
    telegramAccountId: "acc",
    chatId: "c",
    direction: "OUTBOUND",
    contentType: "TEXT",
    mediaType: "TEXT",
    sentAt: "2026-08-03T13:00:00.000Z",
    editedAt: null,
    isEdited: false,
    isDeleted: false,
    senderTelegramUserId: "1",
    senderDisplayName: "You",
    replyToTelegramMessageId: null,
    internalSenderUserId: "u",
    sendStatus: "QUEUED",
    ...emptyMediaFields(),
    ...partial
  };
}

describe("inbox ordering activity", () => {
  it("moves an unpinned chat to the top after outgoing activity and prefixes You:", () => {
    const older = toInboxConversation(chat({ id: "a", title: "Alpha", lastMessageAt: "2026-08-01T10:00:00.000Z", lastMessagePreview: "old" }), "acc");
    const newer = toInboxConversation(chat({ id: "b", title: "Beta", lastMessageAt: "2026-08-01T09:00:00.000Z", lastMessagePreview: "older" }), "acc");
    const pinned = toInboxConversation(
      chat({ id: "p", title: "Pinned", isPinned: true, lastMessageAt: "2026-08-01T08:00:00.000Z", lastMessagePreview: "pin" }),
      "acc"
    );

    const next = applyChatActivity([older, newer, pinned], {
      chatId: "b",
      previewText: "hello there",
      sentAt: "2026-08-03T12:00:00.000Z",
      direction: "OUTBOUND"
    });

    const visible = filterConversations(next, "all", "");
    expect(visible.map((row) => row.chat.id)).toEqual(["p", "b", "a"]);
    expect(visible[1]?.preview).toBe("You: hello there");
  });

  it("increments unread for inbound when requested and merges duplicate outbound messages", () => {
    const row = toInboxConversation(chat({ id: "c", title: "Charlie", unreadCount: 1 }), "acc");
    const bumped = applyChatActivity([row], {
      chatId: "c",
      previewText: "incoming",
      sentAt: "2026-08-03T13:00:00.000Z",
      direction: "INBOUND",
      bumpUnread: true
    });
    expect(bumped[0]?.chat.unreadCount).toBe(2);

    const pending = message({
      id: "msg-1",
      telegramMessageId: "pending:key",
      text: "hi"
    });
    const delivered: TelegramMessageDto = { ...pending, id: "msg-1", telegramMessageId: "99", sendStatus: "SENT" };
    expect(mergeMessage([pending], delivered)).toHaveLength(1);
    expect(mergeMessage([pending], delivered)[0]?.telegramMessageId).toBe("99");

    const older = message({ id: "a", telegramMessageId: "1", sentAt: "2026-08-03T12:00:00.000Z", text: "a" });
    const newer = message({ id: "b", telegramMessageId: "2", sentAt: "2026-08-03T13:00:00.000Z", text: "b" });
    expect(mergeMessage([newer], older).map((row) => row.id)).toEqual(["a", "b"]);

    const history = [
      message({ id: "h1", telegramMessageId: "10", sentAt: "2026-08-03T10:00:00.000Z", text: "old" }),
      message({ id: "h2", telegramMessageId: "11", sentAt: "2026-08-03T11:00:00.000Z", text: "mid" })
    ];
    const incoming = message({
      id: "h3",
      telegramMessageId: "12",
      sentAt: "2026-08-03T12:00:00.000Z",
      text: "new",
      direction: "INBOUND"
    });
    const merged = mergeAndDeduplicate(history, incoming);
    expect(merged.map((row) => row.id)).toEqual(["h1", "h2", "h3"]);
    expect(mergeAndDeduplicate(merged, incoming)).toHaveLength(3);

    // Same telegram identity across different db ids must collapse (account + chat + telegramMessageId).
    const twin = message({
      id: "other-db-id",
      telegramMessageId: "12",
      telegramAccountId: "acc",
      chatId: "c",
      sentAt: "2026-08-03T12:00:00.000Z",
      text: "new edited",
      direction: "INBOUND"
    });
    expect(mergeAndDeduplicate(merged, twin)).toHaveLength(3);
    expect(mergeAndDeduplicate(merged, twin).find((row) => row.telegramMessageId === "12")?.text).toBe("new edited");
  });

  it("normalizes worker media preview labels including GIF/Poll/Dice/Voice Message", () => {
    expect(formatMessagePreview(chat({ id: "1", title: "Ada", lastMessagePreview: "🎤 Voice Message", lastMessageDirection: "INBOUND" }))).toBe(
      "Ada: 🎤 Voice Message"
    );
    expect(formatMessagePreview(chat({ id: "1", title: "Ada", lastMessagePreview: "🎞 GIF", lastMessageDirection: "OUTBOUND" }))).toBe(
      "You: 🎞 GIF"
    );
    expect(formatMessagePreview(chat({ id: "1", title: "Ada", lastMessagePreview: "📊 Poll", lastMessageDirection: "INBOUND" }))).toBe(
      "Ada: 📊 Poll"
    );
    expect(formatMessagePreview(chat({ id: "1", title: "Ada", lastMessagePreview: "🎲 Dice", lastMessageDirection: "INBOUND" }))).toBe(
      "Ada: 🎲 Dice"
    );
    expect(formatMessagePreview(chat({ id: "1", title: "Ada", lastMessagePreview: "📷 caption here", lastMessageDirection: "INBOUND" }))).toBe(
      "Ada: 📷 caption here"
    );
  });

  it("computes inbox counts locally without an API round-trip", () => {
    const rows = [
      toInboxConversation(chat({ id: "1", title: "A", crmStatus: "NEW", assignedUserId: null, unreadCount: 1 }), "acc"),
      toInboxConversation(chat({ id: "2", title: "B", crmStatus: "OPEN", assignedUserId: "u1", unreadCount: 0 }), "acc"),
      toInboxConversation(chat({ id: "3", title: "C", crmStatus: "RESOLVED", assignedUserId: "u1", unreadCount: 0 }), "acc")
    ];
    expect(computeInboxCounts(rows, "u1")).toEqual({
      all: 3,
      unassigned: 1,
      mine: 2,
      new: 1,
      open: 1,
      waiting: 0,
      unread: 1,
      resolved: 1
    });
  });
});
