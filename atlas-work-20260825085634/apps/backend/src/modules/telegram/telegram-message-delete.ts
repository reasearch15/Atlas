import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import {
  buildMessageTombstoneFields,
  isOfficialTelegramServicePeer,
  type TelegramMessageDeletedEvent
} from "@atlas/shared";
import { formatTelegramMediaPreview } from "@atlas/shared";

export type DeletionScope = "EVERYONE" | "ATLAS_ONLY";

/**
 * Soft-deletes a message row (tombstone content) and returns media keys to scrub from MinIO.
 */
export async function softDeleteMessageRow(
  prisma: PrismaClient,
  input: {
    readonly messageId: string;
    readonly deletedAt: Date;
    readonly deletedByUserId: string | null;
    readonly deletionScope: DeletionScope;
    readonly originalContentType: string;
    readonly priorMediaStorageKey: string | null;
    readonly priorThumbnailStorageKey: string | null;
  }
): Promise<{ readonly mediaKeys: string[] }> {
  const tombstone = buildMessageTombstoneFields({
    deletedAt: input.deletedAt,
    deletionScope: input.deletionScope,
    originalContentType: input.originalContentType
  });

  await prisma.telegramMessage.update({
    where: { id: input.messageId },
    data: {
      deletedAt: input.deletedAt,
      deletedByUserId: input.deletedByUserId,
      deletionScope: input.deletionScope,
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

  const mediaKeys = [input.priorMediaStorageKey, input.priorThumbnailStorageKey].filter(
    (key): key is string => Boolean(key)
  );
  return { mediaKeys };
}

/**
 * Rebuilds chat last-message preview from the newest non-deleted message.
 */
export async function refreshChatPreviewAfterDeletion(
  prisma: PrismaClient,
  chatDbId: string
): Promise<{
  readonly lastMessagePreview: string | null;
  readonly lastMessageAt: Date | null;
  readonly lastMessageDirection: "INBOUND" | "OUTBOUND" | null;
  readonly lastMessageId: string | null;
}> {
  const latest = await prisma.telegramMessage.findFirst({
    where: { telegramChatDbId: chatDbId, deletedAt: null },
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
    where: { id: chatDbId },
    data: {
      lastMessageId: latest?.telegramMessageId ?? null,
      lastMessagePreview: preview,
      lastMessageAt: latest?.telegramCreatedAt ?? null
    }
  });

  return {
    lastMessagePreview: preview,
    lastMessageAt: latest?.telegramCreatedAt ?? null,
    lastMessageDirection: latest?.direction ?? null,
    lastMessageId: latest?.telegramMessageId ?? null
  };
}

/**
 * Deletes MinIO objects only when no other message still references the key.
 */
export async function deleteUnreferencedMediaKeys(
  prisma: PrismaClient,
  deleteObject: (key: string) => Promise<void>,
  keys: readonly string[]
): Promise<number> {
  let deleted = 0;
  for (const key of keys) {
    const stillUsed = await prisma.telegramMessage.count({
      where: {
        OR: [{ mediaStorageKey: key }, { thumbnailStorageKey: key }]
      }
    });
    if (stillUsed > 0) continue;
    try {
      await deleteObject(key);
      deleted += 1;
    } catch {
      // Best-effort cleanup — soft-delete already succeeded.
    }
  }
  return deleted;
}

export function buildMessageDeletedEvent(input: {
  readonly workspaceId: string;
  readonly telegramAccountId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly telegramMessageId: string;
  readonly scope: DeletionScope;
  readonly deletedAt: Date;
  readonly deletedBy: { readonly id: string | null; readonly name: string | null };
  readonly lastMessagePreview?: string | null;
  readonly lastMessageAt?: Date | null;
  readonly lastMessageDirection?: "INBOUND" | "OUTBOUND" | null;
}): TelegramMessageDeletedEvent {
  return {
    type: "telegram.message.deleted",
    eventId: crypto.randomUUID(),
    workspaceId: input.workspaceId,
    telegramAccountId: input.telegramAccountId,
    chatId: input.chatId,
    chatDbId: input.chatId,
    messageId: input.messageId,
    telegramMessageId: input.telegramMessageId,
    scope: input.scope,
    deletedAt: input.deletedAt.toISOString(),
    deletedBy: input.deletedBy,
    ...(input.lastMessagePreview !== undefined ? { lastMessagePreview: input.lastMessagePreview } : {}),
    ...(input.lastMessageAt !== undefined
      ? { lastMessageAt: input.lastMessageAt ? input.lastMessageAt.toISOString() : null }
      : {}),
    ...(input.lastMessageDirection !== undefined ? { lastMessageDirection: input.lastMessageDirection } : {})
  };
}

/**
 * Rejects deleting official Telegram service/system peers incorrectly.
 */
export function assertDeletableTelegramMessage(input: {
  readonly isDevelopmentFixture: boolean;
  readonly telegramChatId: string;
  readonly telegramMessageId: string;
}): void {
  if (input.isDevelopmentFixture) {
    throw Object.assign(new Error("Development fixture messages cannot be deleted via this path."), {
      statusCode: 400,
      code: "TELEGRAM_FIXTURE_MESSAGE"
    });
  }
  if (isOfficialTelegramServicePeer(input.telegramChatId)) {
    throw Object.assign(new Error("Official Telegram service conversations cannot be deleted this way."), {
      statusCode: 400,
      code: "TELEGRAM_SERVICE_MESSAGE"
    });
  }
  if (
    input.telegramMessageId.startsWith("pending:") ||
    input.telegramMessageId.startsWith("upload:")
  ) {
    // Pending Atlas sends that never reached Telegram — Atlas-only path is fine;
    // EVERYONE should be rejected by the caller when there is no remote id.
  }
}
