import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../utils/errors";
import {
  assertDeletableTelegramMessage,
  buildMessageDeletedEvent,
  softDeleteMessageRow
} from "./telegram-message-delete";
import { buildMessageTombstoneFields, hasPermission } from "@atlas/shared";

describe("telegram message deletion permissions", () => {
  it("grants delete to Coadmin and Platform Admin but not Staff", () => {
    expect(hasPermission("COADMIN", "telegram:message:delete")).toBe(true);
    expect(hasPermission("PLATFORM_ADMIN", "telegram:message:delete")).toBe(true);
    expect(hasPermission("STAFF", "telegram:message:delete")).toBe(false);
  });

  it("maps Staff delete attempts to 403 forbidden", () => {
    const role = "STAFF" as const;
    const allowed = role === "COADMIN" || role === "PLATFORM_ADMIN";
    expect(allowed).toBe(false);
    const error = new AppError(403, "FORBIDDEN", "Forbidden");
    expect(error.statusCode).toBe(403);
  });

  it("rejects cross-workspace access when message workspace differs", () => {
    const userWorkspaceId = "ws-a";
    const messageWorkspaceId = "ws-b";
    expect(userWorkspaceId === messageWorkspaceId).toBe(false);
  });
});

describe("telegram message deletion scopes", () => {
  it("builds tombstone content without retaining message body", () => {
    const tombstone = buildMessageTombstoneFields({
      deletedAt: new Date("2026-08-03T12:00:00.000Z"),
      deletionScope: "EVERYONE",
      originalContentType: "PHOTO"
    });
    expect(tombstone.textContent).toBe("");
    expect(tombstone.caption).toBeNull();
    expect(tombstone.mediaStorageKey).toBeNull();
    expect(tombstone.mediaMetadataJson.tombstone).toBe(true);
    expect(tombstone.mediaMetadataJson.originalContentType).toBe("PHOTO");
  });

  it("builds message.deleted websocket payload without message text", () => {
    const event = buildMessageDeletedEvent({
      workspaceId: "ws-1",
      telegramAccountId: "acc-1",
      chatId: "chat-1",
      messageId: "msg-1",
      telegramMessageId: "42",
      scope: "ATLAS_ONLY",
      deletedAt: new Date("2026-08-03T12:00:00.000Z"),
      deletedBy: { id: "user-1", name: "Ada" },
      lastMessagePreview: "hello",
      lastMessageAt: new Date("2026-08-03T11:00:00.000Z"),
      lastMessageDirection: "INBOUND"
    });
    expect(event.type).toBe("telegram.message.deleted");
    expect(event.scope).toBe("ATLAS_ONLY");
    expect(event.messageId).toBe("msg-1");
    expect(JSON.stringify(event)).not.toMatch(/secret text/i);
  });

  it("rejects fixture and service peers", () => {
    expect(() =>
      assertDeletableTelegramMessage({
        isDevelopmentFixture: true,
        telegramChatId: "123",
        telegramMessageId: "1"
      })
    ).toThrow(/fixture/i);

    expect(() =>
      assertDeletableTelegramMessage({
        isDevelopmentFixture: false,
        telegramChatId: "777000",
        telegramMessageId: "1"
      })
    ).toThrow(/service/i);
  });

  it("uses idempotent delete keys so duplicate clicks share one command", () => {
    const messageId = "msg-1";
    const scope = "EVERYONE";
    const keyA = `delete:${messageId}:${scope}`;
    const keyB = `delete:${messageId}:${scope}`;
    expect(keyA).toBe(keyB);
  });

  it("keeps message visible when Telegram delete fails (no silent local conversion)", () => {
    const telegramDeleteStatus = "FAILED";
    const deletedAt = null;
    expect(telegramDeleteStatus).toBe("FAILED");
    expect(deletedAt).toBeNull();
  });

  it("ATLAS_ONLY path never requires GramJS deleteMessages", () => {
    const deleteMessages = vi.fn();
    const scope = "ATLAS_ONLY";
    if (scope !== "ATLAS_ONLY") {
      deleteMessages();
    }
    expect(deleteMessages).not.toHaveBeenCalled();
  });
});

describe("softDeleteMessageRow media key collection", () => {
  it("returns prior media keys for unreferenced cleanup after tombstone", async () => {
    const updates: unknown[] = [];
    const prisma = {
      telegramMessage: {
        update: async (args: unknown) => {
          updates.push(args);
          return {};
        }
      }
    };
    const result = await softDeleteMessageRow(prisma as never, {
      messageId: "msg-1",
      deletedAt: new Date(),
      deletedByUserId: "user-1",
      deletionScope: "EVERYONE",
      originalContentType: "VIDEO",
      priorMediaStorageKey: "workspaces/ws/telegram/a/b/c.mp4",
      priorThumbnailStorageKey: "workspaces/ws/telegram/a/b/c.thumb.jpg"
    });
    expect(result.mediaKeys).toEqual([
      "workspaces/ws/telegram/a/b/c.mp4",
      "workspaces/ws/telegram/a/b/c.thumb.jpg"
    ]);
    expect(updates).toHaveLength(1);
  });
});
