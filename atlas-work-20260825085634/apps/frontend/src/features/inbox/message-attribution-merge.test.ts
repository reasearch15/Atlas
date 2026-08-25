import { describe, expect, it } from "vitest";
import { mergeAndDeduplicate } from "./inbox-utils";
import type { TelegramMessageDto } from "@atlas/shared";

function msg(partial: Partial<TelegramMessageDto> & Pick<TelegramMessageDto, "id" | "telegramMessageId" | "text">): TelegramMessageDto {
  return {
    telegramAccountId: "acc",
    chatId: "chat-1",
    direction: "OUTBOUND",
    contentType: "TEXT",
    mediaType: "TEXT",
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
    sentAt: new Date().toISOString(),
    editedAt: null,
    isEdited: false,
    isDeleted: false,
    senderTelegramUserId: null,
    senderDisplayName: "You",
    replyToTelegramMessageId: null,
    replyPreview: null,
    webPreview: null,
    internalSenderUserId: null,
    sendStatus: "SENT",
    ...partial
  };
}

describe("optimistic merge preserves sender attribution", () => {
  it("keeps internalSender fields when Telegram echo arrives without them", () => {
    const pending = msg({
      id: "db-1",
      telegramMessageId: "pending:key",
      text: "hello",
      sendStatus: "QUEUED",
      internalSenderUserId: "staff-1",
      internalSenderName: "Sarah",
      internalSenderRole: "STAFF",
      attributionSource: "ATLAS"
    });
    const echo = msg({
      id: "db-2",
      telegramMessageId: "99",
      text: "hello",
      sendStatus: "SENT",
      internalSenderUserId: null,
      internalSenderName: null,
      attributionSource: "TELEGRAM_EXTERNAL"
    });
    const merged = mergeAndDeduplicate([pending], echo);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.internalSenderUserId).toBe("staff-1");
    expect(merged[0]?.internalSenderName).toBe("Sarah");
    expect(merged[0]?.attributionSource).toBe("ATLAS");
  });
});
