import type { PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import { MEDIA_ERROR_OBJECT_MISSING, type TelegramMessageDto } from "@atlas/shared";
import type { TelegramClientAdapter, TelegramRuntime, NormalizedTextMessage } from "./telegram-client";
import type { MediaObjectStore } from "./media-storage";
import { toTelegramMessageDto } from "./message-dto";
import { messageUpdatedEvent } from "./update-normalizer";

const MAX_CONCURRENT_DOWNLOADS = 3;
let activeDownloads = 0;
const queue: Array<() => void> = [];

/**
 * Downloads Telegram media in the background, uploads to object storage, and publishes an update.
 */
export async function enqueueMediaDownload(input: {
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  readonly adapter: TelegramClientAdapter;
  readonly runtime: TelegramRuntime;
  readonly store: MediaObjectStore;
  readonly workspaceId: string;
  readonly messageId: string;
  readonly telegramMessage: NormalizedTextMessage;
}): Promise<void> {
  await withDownloadSlot(async () => {
    const { prisma, redis, adapter, runtime, store, workspaceId, messageId, telegramMessage } = input;
    const row = await prisma.telegramMessage.findUnique({ where: { id: messageId } });
    if (
      !row ||
      !row.mediaDownloadState ||
      row.mediaDownloadState === "NONE" ||
      row.mediaDownloadState === "SKIPPED" ||
      row.mediaDownloadState === "UNAVAILABLE"
    ) {
      return;
    }
    // STORED with a key still re-checked by backfill when HeadObject fails; normal path skips.
    if (row.mediaDownloadState === "STORED" && row.mediaStorageKey) {
      return;
    }
    if (!telegramMessage.needsBinaryDownload) {
      await prisma.telegramMessage.update({
        where: { id: messageId },
        data: { mediaDownloadState: "SKIPPED", mediaUploadState: "SKIPPED" }
      });
      return;
    }

    await prisma.telegramMessage.update({
      where: { id: messageId },
      data: { mediaDownloadState: "DOWNLOADING", mediaError: null }
    });

    try {
      const chat = await prisma.telegramChat.findUnique({
        where: {
          telegramAccountId_telegramChatId: {
            telegramAccountId: row.telegramAccountId,
            telegramChatId: row.telegramChatId
          }
        },
        select: {
          chatType: true,
          username: true,
          accessHash: true,
          peerType: true,
          peerPhone: true,
          firstName: true,
          lastName: true
        }
      });
      const downloaded = await adapter.downloadMessageMedia(runtime, telegramMessage, chat
        ? {
            chatType: chat.chatType,
            username: chat.username,
            accessHash: chat.accessHash,
            peerType: chat.peerType,
            phone: chat.peerPhone,
            firstName: chat.firstName,
            lastName: chat.lastName
          }
        : undefined);
      if (!downloaded) {
        const skipped = await prisma.telegramMessage.update({
          where: { id: messageId },
          data: { mediaDownloadState: "SKIPPED", mediaUploadState: "SKIPPED", mediaError: "No downloadable media" }
        });
        const dto = toTelegramMessageDto(skipped, {
          direction: skipped.direction === "OUTBOUND" ? "OUTBOUND" : "INBOUND",
          chatTitle: null,
          chatType: "UNKNOWN",
          chatUsername: null
        });
        await redis.publish("atlas.workspace-events", JSON.stringify(messageUpdatedEvent(workspaceId, dto)));
        return;
      }

      const fileName =
        telegramMessage.fileName ||
        `${telegramMessage.contentType.toLowerCase()}.${extensionForMime(downloaded.mimeType, telegramMessage.contentType)}`;
      const key = store.buildObjectKey({
        workspaceId,
        telegramAccountId: row.telegramAccountId,
        telegramChatId: row.telegramChatId,
        telegramMessageId: row.telegramMessageId,
        fileName
      });

      await prisma.telegramMessage.update({
        where: { id: messageId },
        data: { mediaUploadState: "DOWNLOADING" }
      });

      await store.putObject({
        key,
        body: downloaded.buffer,
        contentType: downloaded.mimeType || telegramMessage.mimeType || "application/octet-stream"
      });

      let thumbnailKey: string | null = null;
      if (downloaded.thumbnail && (telegramMessage.contentType === "PHOTO" || telegramMessage.contentType === "VIDEO" || telegramMessage.contentType === "ANIMATION" || telegramMessage.contentType === "STICKER" || telegramMessage.contentType === "DOCUMENT")) {
        thumbnailKey = store.buildObjectKey({
          workspaceId,
          telegramAccountId: row.telegramAccountId,
          telegramChatId: row.telegramChatId,
          telegramMessageId: row.telegramMessageId,
          fileName: `thumb-${fileName}.jpg`
        });
        await store.putObject({
          key: thumbnailKey,
          body: downloaded.thumbnail,
          contentType: "image/jpeg"
        });
      }

      const updated = await prisma.telegramMessage.update({
        where: { id: messageId },
        data: {
          mediaStorageKey: key,
          thumbnailStorageKey: thumbnailKey,
          mimeType: downloaded.mimeType || row.mimeType,
          fileName: fileName,
          fileSizeBytes: downloaded.buffer.byteLength,
          mediaDownloadState: "STORED",
          mediaUploadState: "STORED",
          mediaError: null
        }
      });

      const dto = toTelegramMessageDto(updated, {
        direction: updated.direction === "OUTBOUND" ? "OUTBOUND" : "INBOUND",
        chatTitle: null,
        chatType: "UNKNOWN",
        chatUsername: null
      });

      await redis.publish("atlas.workspace-events", JSON.stringify(messageUpdatedEvent(workspaceId, dto)));
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "Media download failed";
      const failed = await prisma.telegramMessage.update({
        where: { id: messageId },
        data: { mediaDownloadState: "FAILED", mediaUploadState: "FAILED", mediaError: message }
      });
      const dto = toTelegramMessageDto(failed, {
        direction: failed.direction === "OUTBOUND" ? "OUTBOUND" : "INBOUND",
        chatTitle: null,
        chatType: "UNKNOWN",
        chatUsername: null
      });
      await redis.publish("atlas.workspace-events", JSON.stringify(messageUpdatedEvent(workspaceId, dto)));
    }
  });
}

/**
 * Bounded media backfill for messages missing object storage.
 */
export async function runMediaBackfill(input: {
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  readonly adapter: TelegramClientAdapter;
  readonly runtime: TelegramRuntime;
  readonly store: MediaObjectStore;
  readonly workspaceId: string;
  readonly telegramAccountId: string;
  readonly limit?: number;
}): Promise<{ scanned: number; downloaded: number; uploaded: number; skipped: number; failed: number }> {
  const limit = input.limit ?? 25;
  const pending = await input.prisma.telegramMessage.findMany({
    where: {
      telegramAccountId: input.telegramAccountId,
      mediaDownloadState: { in: ["PENDING", "FAILED"] },
      contentType: { in: ["PHOTO", "VIDEO", "VIDEO_NOTE", "VOICE", "AUDIO", "DOCUMENT", "ANIMATION", "STICKER"] }
    },
    orderBy: { telegramCreatedAt: "desc" },
    take: limit
  });

  // Heal STORED rows whose objects were not migrated to production MinIO.
  const storedOrphans = await input.prisma.telegramMessage.findMany({
    where: {
      telegramAccountId: input.telegramAccountId,
      mediaDownloadState: "STORED",
      mediaStorageKey: { not: null },
      contentType: { in: ["PHOTO", "VIDEO", "VIDEO_NOTE", "VOICE", "AUDIO", "DOCUMENT", "ANIMATION", "STICKER"] }
    },
    orderBy: { telegramCreatedAt: "desc" },
    take: Math.max(5, Math.floor(limit / 2))
  });
  for (const row of storedOrphans) {
    if (!row.mediaStorageKey) continue;
    const exists = await input.store.objectExists(row.mediaStorageKey);
    if (exists) continue;
    await input.prisma.telegramMessage.update({
      where: { id: row.id },
      data: {
        mediaDownloadState: "UNAVAILABLE",
        mediaUploadState: "UNAVAILABLE",
        mediaError: MEDIA_ERROR_OBJECT_MISSING
      }
    });
    // Reset to PENDING so Telegram re-download can heal when the peer is still available.
    await input.prisma.telegramMessage.update({
      where: { id: row.id },
      data: {
        mediaDownloadState: "PENDING",
        mediaUploadState: "PENDING",
        mediaStorageKey: null,
        thumbnailStorageKey: null,
        mediaError: MEDIA_ERROR_OBJECT_MISSING
      }
    });
    pending.push(row);
  }

  let downloaded = 0;
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of pending) {
    try {
      const before = row.mediaDownloadState;
      await enqueueMediaDownload({
        prisma: input.prisma,
        redis: input.redis,
        adapter: input.adapter,
        runtime: input.runtime,
        store: input.store,
        workspaceId: input.workspaceId,
        messageId: row.id,
        telegramMessage: {
          telegramChatId: row.telegramChatId,
          telegramMessageId: row.telegramMessageId,
          senderTelegramUserId: row.senderTelegramUserId,
          text: row.textContent,
          caption: row.caption,
          contentType: row.contentType as NormalizedTextMessage["contentType"],
          mimeType: row.mimeType,
          fileName: row.fileName,
          fileSizeBytes: row.fileSizeBytes ? Number(row.fileSizeBytes) : null,
          width: row.width,
          height: row.height,
          durationSeconds: row.durationSeconds,
          waveform: Array.isArray(row.waveformJson) ? (row.waveformJson as number[]) : null,
          mediaMetadata: (row.mediaMetadataJson as Record<string, unknown> | null) ?? {},
          needsBinaryDownload: true,
          previewText: row.textContent,
          sentAt: row.telegramCreatedAt,
          editedAt: row.telegramEditedAt,
          replyToTelegramMessageId: row.replyToTelegramMessageId,
          isOutgoing: row.direction === "OUTBOUND",
          raw: {},
          gramJsMessage: null
        }
      });
      const after = await input.prisma.telegramMessage.findUnique({ where: { id: row.id } });
      if (after?.mediaDownloadState === "STORED") {
        downloaded += 1;
        uploaded += 1;
      } else if (after?.mediaDownloadState === "SKIPPED") {
        skipped += 1;
      } else if (after?.mediaDownloadState === "FAILED" || before === "FAILED") {
        failed += 1;
      } else {
        skipped += 1;
      }
    } catch {
      failed += 1;
    }
  }

  return { scanned: pending.length, downloaded, uploaded, skipped, failed };
}

async function withDownloadSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    await new Promise<void>((resolve) => queue.push(resolve));
  }
  activeDownloads += 1;
  try {
    return await fn();
  } finally {
    activeDownloads -= 1;
    const next = queue.shift();
    if (next) next();
  }
}

function extensionForMime(mimeType: string | null | undefined, contentType: string): string {
  if (mimeType?.includes("jpeg") || mimeType?.includes("jpg")) return "jpg";
  if (mimeType?.includes("png")) return "png";
  if (mimeType?.includes("webp")) return "webp";
  if (mimeType?.includes("gif")) return "gif";
  if (mimeType?.includes("mp4")) return "mp4";
  if (mimeType?.includes("ogg")) return "ogg";
  if (mimeType?.includes("mpeg") || mimeType?.includes("mp3")) return "mp3";
  if (mimeType?.includes("webm")) return "webm";
  switch (contentType) {
    case "PHOTO":
      return "jpg";
    case "VIDEO":
    case "VIDEO_NOTE":
    case "ANIMATION":
      return "mp4";
    case "VOICE":
      return "ogg";
    case "AUDIO":
      return "mp3";
    case "STICKER":
      return "webp";
    default:
      return "bin";
  }
}

export type { TelegramMessageDto };
