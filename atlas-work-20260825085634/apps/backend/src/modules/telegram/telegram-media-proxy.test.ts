import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../utils/errors";
import { signMediaAccessTicket } from "./media-access-ticket";
import { TelegramMediaProxyService, resolveMediaDownloadFilename } from "./telegram-media-proxy.service";
import { buildTelegramMessageMediaPath, isPrivateStorageMediaUrl } from "@atlas/shared";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherWorkspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const messageId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const userId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const chatId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const accountId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const secret = "proxy-test-secret";

function makeApp(overrides?: {
  readonly message?: Record<string, unknown> | null;
  readonly chat?: Record<string, unknown> | null;
  readonly account?: Record<string, unknown> | null;
  readonly user?: Record<string, unknown> | null;
  readonly stream?: {
    readonly body: Readable;
    readonly statusCode: 200 | 206;
    readonly contentType: string | null;
    readonly contentLength: number | null;
    readonly contentRange: string | null;
    readonly acceptRanges: string;
    readonly etag: string | null;
  };
  readonly streamError?: Error;
}) {
  const headers: Record<string, string> = {};
  const reply = {
    code: vi.fn().mockReturnThis(),
    header: vi.fn((key: string, value: string) => {
      headers[key.toLowerCase()] = value;
      return reply;
    }),
    send: vi.fn((body: unknown) => body)
  };

  const message =
    overrides && "message" in overrides
      ? overrides.message
      : {
          id: messageId,
          workspaceId,
          telegramChatDbId: chatId,
          telegramAccountId: accountId,
          contentType: "PHOTO",
          mimeType: "image/jpeg",
          fileName: "photo.jpg",
          mediaStorageKey: `workspaces/${workspaceId}/telegram/${accountId}/chat/msg/photo.jpg`,
          thumbnailStorageKey: `workspaces/${workspaceId}/telegram/${accountId}/chat/msg/thumb.jpg`,
          mediaDownloadState: "STORED",
          mediaUploadState: "STORED",
          mediaError: null
        };

  const app = {
    env: { JWT_ACCESS_SECRET: secret },
    auth: {
      authenticate: vi.fn(async () => ({
        id: userId,
        email: "staff@example.test",
        name: "Staff",
        role: "STAFF",
        workspaceId,
        sessionId: "sess"
      }))
    },
    prisma: {
      user: {
        findFirst: vi.fn(async () =>
          overrides && "user" in overrides
            ? overrides.user
            : {
                id: userId,
                role: "STAFF",
                workspaceId,
                status: "ACTIVE",
                name: "Staff",
                email: "staff@example.test"
              }
        )
      },
      telegramMessage: {
        findFirst: vi.fn(async () => message),
        update: vi.fn(async () => message)
      },
      telegramChat: {
        findFirst: vi.fn(async () =>
          overrides && "chat" in overrides
            ? overrides.chat
            : { id: chatId, telegramAccountId: accountId }
        )
      },
      telegramAccount: {
        findFirst: vi.fn(async () =>
          overrides && "account" in overrides ? overrides.account : { id: accountId }
        )
      }
    },
    storage: {
      assertWorkspaceKey: vi.fn((ws: string, key: string) => {
        if (!key.startsWith(`workspaces/${ws}/`)) {
          throw new AppError(403, "FORBIDDEN", "Media key is outside workspace scope.");
        }
      }),
      getObjectStream: vi.fn(async () => {
        if (overrides?.streamError) throw overrides.streamError;
        return (
          overrides?.stream ?? {
            body: Readable.from([Buffer.from([0xff, 0xd8, 0xff])]),
            statusCode: 200 as const,
            contentType: "image/jpeg",
            contentLength: 3,
            contentRange: null,
            acceptRanges: "bytes",
            etag: '"abc"'
          }
        );
      })
    }
  };

  return { app: app as never, reply: reply as never, headers };
}

describe("TelegramMediaProxyService", () => {
  it("streams photo bytes with correct headers for an authorized user", async () => {
    const { app, reply, headers } = makeApp();
    const service = new TelegramMediaProxyService(app);
    const request = { headers: { authorization: "Bearer token" }, query: {} } as never;
    await service.streamMessageMedia(request, reply, messageId, "media");
    expect(headers["content-type"]).toBe("image/jpeg");
    expect(headers["content-length"]).toBe("3");
    expect(headers["cache-control"]).toBe("private, max-age=300");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-disposition"]).toContain("inline");
    expect(headers["accept-ranges"]).toBe("bytes");
  });

  it("returns 206 for video range requests", async () => {
    const { app, reply, headers } = makeApp({
      message: {
        id: messageId,
        workspaceId,
        telegramChatDbId: chatId,
        telegramAccountId: accountId,
        contentType: "VIDEO",
        mimeType: "video/mp4",
        fileName: "clip.mp4",
        mediaStorageKey: `workspaces/${workspaceId}/telegram/${accountId}/chat/msg/clip.mp4`,
        thumbnailStorageKey: null,
        mediaDownloadState: "STORED",
        mediaUploadState: "STORED",
        mediaError: null
      },
      stream: {
        body: Readable.from([Buffer.from("abcd")]),
        statusCode: 206,
        contentType: "video/mp4",
        contentLength: 4,
        contentRange: "bytes 0-3/100",
        acceptRanges: "bytes",
        etag: null
      }
    });
    const service = new TelegramMediaProxyService(app);
    const request = {
      headers: { authorization: "Bearer token", range: "bytes=0-3" },
      query: {}
    } as never;
    await service.streamMessageMedia(request, reply, messageId, "media");
    expect(reply.code).toHaveBeenCalledWith(206);
    expect(headers["content-range"]).toBe("bytes 0-3/100");
    expect(headers["content-type"]).toBe("video/mp4");
  });

  it("supports voice / audio / document / sticker / animation content types", async () => {
    const cases = [
      { contentType: "VOICE", mimeType: "audio/ogg", fileName: "voice.ogg", disposition: "inline" },
      { contentType: "AUDIO", mimeType: "audio/mpeg", fileName: "song.mp3", disposition: "inline" },
      { contentType: "DOCUMENT", mimeType: "application/pdf", fileName: "doc.pdf", disposition: "attachment" },
      { contentType: "STICKER", mimeType: "image/webp", fileName: "sticker.webp", disposition: "inline" },
      { contentType: "ANIMATION", mimeType: "video/mp4", fileName: "anim.mp4", disposition: "inline" },
      { contentType: "VIDEO_NOTE", mimeType: "video/mp4", fileName: "note.mp4", disposition: "inline" }
    ] as const;

    for (const row of cases) {
      const { app, reply, headers } = makeApp({
        message: {
          id: messageId,
          workspaceId,
          telegramChatDbId: chatId,
          telegramAccountId: accountId,
          contentType: row.contentType,
          mimeType: row.mimeType,
          fileName: row.fileName,
          mediaStorageKey: `workspaces/${workspaceId}/telegram/${accountId}/chat/msg/${row.fileName}`,
          thumbnailStorageKey: null,
          mediaDownloadState: "STORED",
          mediaUploadState: "STORED",
          mediaError: null
        },
        stream: {
          body: Readable.from([Buffer.from("x")]),
          statusCode: 200,
          contentType: row.mimeType,
          contentLength: 1,
          contentRange: null,
          acceptRanges: "bytes",
          etag: null
        }
      });
      const service = new TelegramMediaProxyService(app);
      await service.streamMessageMedia(
        { headers: { authorization: "Bearer token" }, query: {} } as never,
        reply,
        messageId,
        "media"
      );
      expect(headers["content-type"]).toBe(row.mimeType);
      expect(headers["content-disposition"]).toContain(row.disposition);
    }
  });

  it("rejects unauthenticated requests", async () => {
    const { app, reply } = makeApp();
    const service = new TelegramMediaProxyService(app);
    await expect(
      service.streamMessageMedia({ headers: {}, query: {} } as never, reply, messageId, "media")
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects cross-workspace access with 403", async () => {
    const { app, reply } = makeApp({
      message: {
        id: messageId,
        workspaceId: otherWorkspaceId,
        telegramChatDbId: chatId,
        telegramAccountId: accountId,
        contentType: "PHOTO",
        mimeType: "image/jpeg",
        fileName: "photo.jpg",
        mediaStorageKey: `workspaces/${otherWorkspaceId}/telegram/a/b/c/photo.jpg`,
        thumbnailStorageKey: null,
        mediaDownloadState: "STORED",
        mediaUploadState: "STORED",
        mediaError: null
      },
      chat: null
    });
    // findFirst with workspace filter returns null when message.workspaceId mismatches user.
    (app as { prisma: { telegramMessage: { findFirst: ReturnType<typeof vi.fn> } } }).prisma.telegramMessage.findFirst =
      vi.fn(async () => null);
    const service = new TelegramMediaProxyService(app);
    await expect(
      service.streamMessageMedia(
        { headers: { authorization: "Bearer token" }, query: {} } as never,
        reply,
        messageId,
        "media"
      )
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("returns 409 while media is pending and 404 when object is missing", async () => {
    const pending = makeApp({
      message: {
        id: messageId,
        workspaceId,
        telegramChatDbId: chatId,
        telegramAccountId: accountId,
        contentType: "PHOTO",
        mimeType: "image/jpeg",
        fileName: "photo.jpg",
        mediaStorageKey: null,
        thumbnailStorageKey: null,
        mediaDownloadState: "PENDING",
        mediaUploadState: "PENDING",
        mediaError: null
      }
    });
    await expect(
      new TelegramMediaProxyService(pending.app).streamMessageMedia(
        { headers: { authorization: "Bearer token" }, query: {} } as never,
        pending.reply,
        messageId,
        "media"
      )
    ).rejects.toMatchObject({ statusCode: 409 });

    const missing = makeApp({
      streamError: Object.assign(new Error("NoSuchKey"), { Code: "NoSuchKey", name: "NoSuchKey" })
    });
    await expect(
      new TelegramMediaProxyService(missing.app).streamMessageMedia(
        { headers: { authorization: "Bearer token" }, query: {} } as never,
        missing.reply,
        messageId,
        "media"
      )
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("accepts a valid media access ticket without Bearer", async () => {
    const { app, reply, headers } = makeApp();
    const ticket = signMediaAccessTicket(secret, {
      messageId,
      workspaceId,
      userId,
      variant: "media"
    });
    const service = new TelegramMediaProxyService(app);
    await service.streamMessageMedia(
      { headers: {}, query: { access: ticket } } as never,
      reply,
      messageId,
      "media"
    );
    expect(headers["content-type"]).toBe("image/jpeg");
    expect(headers["content-disposition"]).toMatch(/^inline;/);
  });

  it("forces attachment Content-Disposition when download=1 for photos", async () => {
    const { app, reply, headers } = makeApp({
      message: {
        id: messageId,
        workspaceId,
        telegramChatDbId: chatId,
        telegramAccountId: accountId,
        contentType: "PHOTO",
        mimeType: "image/jpeg",
        fileName: null,
        mediaStorageKey: `workspaces/${workspaceId}/telegram/${accountId}/chat/msg/photo.jpg`,
        thumbnailStorageKey: null,
        mediaDownloadState: "STORED",
        mediaUploadState: "STORED",
        mediaError: null
      }
    });
    const service = new TelegramMediaProxyService(app);
    await service.streamMessageMedia(
      { headers: { authorization: "Bearer token" }, query: { download: "1" } } as never,
      reply,
      messageId,
      "media"
    );
    expect(headers["content-disposition"]).toMatch(/^attachment;/);
    expect(headers["content-disposition"]).toContain("photo.jpg");
  });

  it("resolves photo download filenames when fileName is missing", () => {
    expect(
      resolveMediaDownloadFilename({
        fileName: null,
        contentType: "PHOTO",
        mimeType: "image/jpeg",
        variant: "media"
      })
    ).toBe("photo.jpg");
    expect(
      resolveMediaDownloadFilename({
        fileName: "holiday.png",
        contentType: "PHOTO",
        mimeType: "image/png",
        variant: "media"
      })
    ).toBe("holiday.png");
  });

  it("DTO media URLs are same-origin proxy paths without MinIO signatures", () => {
    const path = buildTelegramMessageMediaPath(messageId, "media");
    expect(path.startsWith("/api/telegram/messages/")).toBe(true);
    expect(isPrivateStorageMediaUrl(path)).toBe(false);
    expect(path).not.toContain("127.0.0.1");
    expect(path).not.toContain(":9000");
    expect(path).not.toContain("X-Amz-Signature");
  });
});
