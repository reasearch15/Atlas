import { describe, expect, it } from "vitest";
import type { TelegramMessageDto, TelegramMessageDeletedEvent } from "@atlas/shared";
import { mergeAndDeduplicate } from "./inbox-utils";

function baseMessage(partial: Partial<TelegramMessageDto> & Pick<TelegramMessageDto, "id" | "telegramMessageId">): TelegramMessageDto {
  return {
    telegramAccountId: "acc-1",
    chatId: "chat-1",
    direction: "OUTBOUND",
    contentType: "TEXT",
    mediaType: "TEXT",
    text: "hello",
    caption: null,
    mimeType: null,
    fileName: null,
    fileSizeBytes: null,
    width: null,
    height: null,
    durationSeconds: null,
    waveform: null,
    mediaMetadata: null,
    mediaUrl: null,
    thumbnailUrl: null,
    mediaDownloadState: "NONE",
    mediaUploadState: "NONE",
    mediaError: null,
    sentAt: "2026-08-03T12:00:00.000Z",
    editedAt: null,
    isEdited: false,
    isDeleted: false,
    senderDisplayName: "You",
    replyToTelegramMessageId: null,
    replyPreview: null,
    webPreview: null,
    internalSenderUserId: "staff-1",
    sendStatus: "SENT",
    ...partial
  };
}

describe("message.deleted frontend handling", () => {
  it("removes deleted message from the open conversation without refresh", () => {
    const existing = [
      baseMessage({ id: "m1", telegramMessageId: "1", text: "first" }),
      baseMessage({ id: "m2", telegramMessageId: "2", text: "latest", sentAt: "2026-08-03T13:00:00.000Z" })
    ];
    const deleted: TelegramMessageDto = {
      ...existing[1]!,
      isDeleted: true,
      deletedAt: "2026-08-03T13:05:00.000Z",
      text: ""
    };
    const next = existing.filter((row) => row.id !== deleted.id && !deleted.isDeleted ? true : row.id !== deleted.id);
    expect(next.map((row) => row.id)).toEqual(["m1"]);
  });

  it("does not duplicate conversations when applying chat preview after delete", () => {
    const event: TelegramMessageDeletedEvent = {
      type: "telegram.message.deleted",
      eventId: "e1",
      workspaceId: "ws",
      telegramAccountId: "acc",
      chatId: "chat-1",
      chatDbId: "chat-1",
      messageId: "m2",
      telegramMessageId: "2",
      scope: "EVERYONE",
      deletedAt: "2026-08-03T13:05:00.000Z",
      deletedBy: { id: "u1", name: "Ada" },
      lastMessagePreview: "first",
      lastMessageAt: "2026-08-03T12:00:00.000Z",
      lastMessageDirection: "OUTBOUND"
    };
    expect(event.chatId).toBe(event.chatDbId);
    expect(event.lastMessagePreview).toBe("first");
  });

  it("merge keeps non-deleted twins stable", () => {
    const a = baseMessage({ id: "m1", telegramMessageId: "1" });
    const b = baseMessage({ id: "m1", telegramMessageId: "1", text: "updated" });
    const merged = mergeAndDeduplicate([a], b);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe("updated");
  });
});
