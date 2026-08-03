import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import Redis from "ioredis";
import { buildMessageTombstoneFields, type TelegramMessageDeletedEvent } from "@atlas/shared";
import { formatTelegramMediaPreview } from "@atlas/shared";
import type { MediaObjectStore } from "./media-storage";
import { chatUpdatedEvent, chatUpdatedFieldsFromRow } from "./update-normalizer";

/**
 * Soft-deletes a message after Telegram acknowledgement (or native delete sync).
 */
export async function applySoftDeletedMessage(
  prisma: PrismaClient,
  redis: Redis,
  store: MediaObjectStore,
  input: {
    readonly messageId: string;
    readonly workspaceId: string;
    readonly telegramAccountId: string;
    readonly chatDbId: string;
    readonly telegramMessageId: string;
    readonly scope: "EVERYONE" | "ATLAS_ONLY";
    readonly deletedByUserId: string | null;
    readonly deletedByName: string | null;
    readonly originalContentType: string;
    readonly priorMediaStorageKey: string | null;
    readonly priorThumbnailStorageKey: string | null;
  }
): Promise<TelegramMessageDeletedEvent> {
  const deletedAt = new Date();
  const tombstone = buildMessageTombstoneFields({
    deletedAt,
    deletionScope: input.scope,
    originalContentType: input.originalContentType
  });

  await prisma.telegramMessage.update({
    where: { id: input.messageId },
    data: {
      deletedAt,
      deletedByUserId: input.deletedByUserId,
      deletionScope: input.scope,
      telegramDeleteStatus: "DELETED",
      telegramDeleteError: null,
      textContent: tombstone.textContent,
      caption: tombstone.caption,
      mediaStorageKey: tombstone.mediaStorageKey,
      thumbnailStorageKey: tombstone.thumbnailStorageKey,
      mediaDownloadState: tombstone.mediaDownloadState,
      mediaUploadState: tombstone.mediaUploadState,
      mediaError: tombstone.mediaError,
      waveformJson: Prisma.DbNull,
      mediaMetadataJson: tombstone.mediaMetadataJson
    }
  });

  const latest = await prisma.telegramMessage.findFirst({
    where: { telegramChatDbId: input.chatDbId, deletedAt: null },
    orderBy: { telegramCreatedAt: "desc" },
    select: {
      telegramMessageId: true,
      textContent: true,
      caption: true,
      contentType: true,
      telegramCreatedAt: true,
      direction: true
    }
  });
  const preview = latest
    ? formatTelegramMediaPreview(latest.contentType as never, {
        text: latest.textContent,
        caption: latest.caption
      }).slice(0, 500)
    : null;

  await prisma.telegramChat.update({
    where: { id: input.chatDbId },
    data: {
      lastMessageId: latest?.telegramMessageId ?? null,
      lastMessagePreview: preview,
      lastMessageAt: latest?.telegramCreatedAt ?? null
    }
  });

  for (const key of [input.priorMediaStorageKey, input.priorThumbnailStorageKey]) {
    if (!key) continue;
    const stillUsed = await prisma.telegramMessage.count({
      where: { OR: [{ mediaStorageKey: key }, { thumbnailStorageKey: key }] }
    });
    if (stillUsed > 0) continue;
    try {
      await store.deleteObject(key);
    } catch {
      // best-effort
    }
  }

  const event: TelegramMessageDeletedEvent = {
    type: "telegram.message.deleted",
    eventId: crypto.randomUUID(),
    workspaceId: input.workspaceId,
    telegramAccountId: input.telegramAccountId,
    chatId: input.chatDbId,
    chatDbId: input.chatDbId,
    messageId: input.messageId,
    telegramMessageId: input.telegramMessageId,
    scope: input.scope,
    deletedAt: deletedAt.toISOString(),
    deletedBy: { id: input.deletedByUserId, name: input.deletedByName },
    lastMessagePreview: preview,
    lastMessageAt: latest?.telegramCreatedAt?.toISOString() ?? null,
    lastMessageDirection: latest?.direction ?? null
  };

  await redis.publish("atlas.workspace-events", JSON.stringify(event));
  const chat = await prisma.telegramChat.findUnique({ where: { id: input.chatDbId } });
  if (chat) {
    await redis.publish(
      "atlas.workspace-events",
      JSON.stringify(
        chatUpdatedEvent(
          input.workspaceId,
          chatUpdatedFieldsFromRow({
            ...chat,
            lastMessageDirection: latest?.direction ?? null
          })
        )
      )
    );
  }
  return event;
}
