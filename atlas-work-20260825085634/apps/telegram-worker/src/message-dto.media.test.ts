import { describe, expect, it } from "vitest";
import { buildTelegramMessageMediaPath, isPrivateStorageMediaUrl } from "@atlas/shared";
import { toTelegramMessageDto } from "./message-dto";

describe("worker message DTO media URLs", () => {
  const messageId = "11111111-1111-4111-8111-111111111111";

  it("emits same-origin proxy paths for stored media of every type", () => {
    const types = ["PHOTO", "VIDEO", "VIDEO_NOTE", "VOICE", "AUDIO", "DOCUMENT", "ANIMATION", "STICKER"] as const;
    for (const contentType of types) {
      const dto = toTelegramMessageDto(
        {
          id: messageId,
          telegramAccountId: "acc",
          telegramChatDbId: "chat",
          telegramMessageId: "1",
          senderTelegramUserId: null,
          direction: "INBOUND",
          contentType,
          textContent: "",
          mediaStorageKey: "workspaces/ws/telegram/a/b/c/file.bin",
          thumbnailStorageKey: "workspaces/ws/telegram/a/b/c/thumb.jpg",
          mediaDownloadState: "STORED",
          mediaUploadState: "STORED",
          mediaError: null,
          replyToTelegramMessageId: null,
          telegramCreatedAt: new Date("2026-01-01T00:00:00.000Z"),
          telegramEditedAt: null,
          internalSenderUserId: null,
          sendStatus: "SENT"
        },
        { chatTitle: "Peer", chatType: "USER", chatUsername: null }
      );
      expect(dto.mediaUrl).toBe(buildTelegramMessageMediaPath(messageId, "media"));
      expect(dto.thumbnailUrl).toBe(buildTelegramMessageMediaPath(messageId, "thumbnail"));
      expect(isPrivateStorageMediaUrl(dto.mediaUrl)).toBe(false);
      expect(dto.mediaUrl).not.toContain("127.0.0.1");
      expect(dto.mediaUrl).not.toContain(":9000");
      expect(dto.mediaUrl).not.toContain("X-Amz-Signature");
    }
  });
});
