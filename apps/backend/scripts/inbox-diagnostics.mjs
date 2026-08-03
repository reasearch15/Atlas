/**
 * Production-safe diagnostics for inbox sync / media / identity issues.
 * Reports counts only — never secrets or object bytes.
 *
 * Usage (from repo root after pnpm install):
 *   pnpm --filter @atlas/backend inbox:diagnostics
 */

import { PrismaClient } from "@prisma/client";
import { HeadObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { isOfficialTelegramServicePeer, shouldIgnoreTelegramDialog } from "@atlas/shared";

const prisma = new PrismaClient();

async function main() {
  const s3 = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || ""
    }
  });
  const bucket = process.env.S3_BUCKET || "";

  const mediaMessages = await prisma.telegramMessage.count({
    where: { contentType: { in: ["PHOTO", "VIDEO", "VOICE", "AUDIO", "DOCUMENT", "ANIMATION", "STICKER", "VIDEO_NOTE"] } }
  });
  const withKey = await prisma.telegramMessage.count({
    where: { mediaStorageKey: { not: null } }
  });
  const unavailable = await prisma.telegramMessage.count({
    where: { OR: [{ mediaDownloadState: "UNAVAILABLE" }, { mediaError: "OBJECT_MISSING" }] }
  });
  const failedOutbound = await prisma.telegramOutboundCommand.count({
    where: { operation: "SEND_MEDIA_MESSAGE", status: { in: ["FAILED_RETRYABLE", "FAILED_PERMANENT"] } }
  });
  const unknownTitle = await prisma.telegramChat.count({
    where: { isArchived: false, title: { startsWith: "Unknown", mode: "insensitive" } }
  });
  const unread = await prisma.telegramChat.count({
    where: { isArchived: false, unreadCount: { gt: 0 } }
  });

  const chats = await prisma.telegramChat.findMany({
    where: { isArchived: false },
    select: {
      id: true,
      telegramAccountId: true,
      telegramChatId: true,
      chatType: true,
      title: true,
      username: true,
      firstName: true,
      lastName: true,
      accessHash: true,
      peerType: true,
      rawMetadataJson: true,
      _count: { select: { messages: true } }
    },
    take: 5000
  });

  let serviceCandidates = 0;
  let incompletePrivatePeers = 0;
  let nakedNumericTitles = 0;
  for (const chat of chats) {
    const meta =
      chat.rawMetadataJson && typeof chat.rawMetadataJson === "object" && !Array.isArray(chat.rawMetadataJson)
        ? chat.rawMetadataJson
        : {};
    if (
      isOfficialTelegramServicePeer(chat.telegramChatId) ||
      shouldIgnoreTelegramDialog({
        telegramChatId: chat.telegramChatId,
        chatType: chat.chatType,
        title: chat.title,
        username: chat.username,
        firstName: chat.firstName,
        lastName: chat.lastName,
        isSelf: Boolean(meta.self),
        isSupport: Boolean(meta.support)
      })
    ) {
      serviceCandidates += 1;
      continue;
    }
    const isPrivate =
      chat.chatType === "PRIVATE" ||
      chat.peerType === "USER" ||
      (!String(chat.telegramChatId).startsWith("-") && chat.chatType !== "GROUP" && chat.chatType !== "CHANNEL");
    if (isPrivate && chat._count.messages > 0 && (!chat.accessHash || !chat.peerType)) {
      incompletePrivatePeers += 1;
    }
    if (/^-?\d{5,}$/.test(String(chat.title).trim())) {
      nakedNumericTitles += 1;
    }
  }

  const duplicateGroups = await prisma.$queryRawUnsafe(
    `SELECT telegram_account_id, telegram_chat_id, COUNT(*)::int AS cnt
     FROM telegram_chats
     GROUP BY telegram_account_id, telegram_chat_id
     HAVING COUNT(*) > 1`
  );

  let keysFound = 0;
  let keysMissing = 0;
  const sampleKeys = await prisma.telegramMessage.findMany({
    where: { mediaStorageKey: { not: null } },
    select: { id: true, mediaStorageKey: true },
    take: 200,
    orderBy: { updatedAt: "desc" }
  });
  for (const row of sampleKeys) {
    if (!row.mediaStorageKey || !bucket) continue;
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: row.mediaStorageKey }));
      keysFound += 1;
    } catch {
      keysMissing += 1;
    }
  }

  let objectCount = null;
  try {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
    objectCount = listed.KeyCount ?? 0;
  } catch {
    objectCount = "unreachable";
  }

  console.log(
    JSON.stringify(
      {
        totalTelegramMediaMessages: mediaMessages,
        messagesWithMediaStorageKey: withKey,
        mediaSampleKeysChecked: sampleKeys.length,
        mediaKeysFoundInMinioSample: keysFound,
        mediaKeysMissingInMinioSample: keysMissing,
        unavailableMediaRows: unavailable,
        outgoingMediaJobsFailed: failedOutbound,
        duplicateConversationsByAccountPeer: Array.isArray(duplicateGroups) ? duplicateGroups.length : 0,
        contactsOrChatsTitledUnknown: unknownTitle,
        conversationsWithUnread: unread,
        officialOrServiceConversationCandidates: serviceCandidates,
        incompletePrivatePeersMissingAccessHashOrPeerType: incompletePrivatePeers,
        nakedNumericChatTitles: nakedNumericTitles,
        minioBucketProbe: objectCount,
        sqlNotes: {
          mediaWithKey: `SELECT COUNT(*) FROM telegram_messages WHERE media_storage_key IS NOT NULL;`,
          unread: `SELECT COUNT(*) FROM telegram_chats WHERE is_archived = false AND unread_count > 0;`,
          unknown: `SELECT COUNT(*) FROM telegram_chats WHERE is_archived = false AND title ILIKE 'Unknown%';`,
          incompletePrivate: `SELECT COUNT(*) FROM telegram_chats c WHERE c.is_archived = false AND (c.chat_type = 'PRIVATE' OR c.peer_type = 'USER') AND (c.access_hash IS NULL OR c.peer_type IS NULL) AND EXISTS (SELECT 1 FROM telegram_messages m WHERE m.telegram_chat_db_id = c.id);`,
          servicePeers: `SELECT id, telegram_chat_id, title FROM telegram_chats WHERE telegram_chat_id IN ('777000','42777');`
        }
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
