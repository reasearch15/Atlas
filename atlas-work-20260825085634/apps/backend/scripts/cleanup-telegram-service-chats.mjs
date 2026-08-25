/**
 * One-time safe cleanup for official Telegram service / Saved Messages conversations.
 * Soft-archives matching chats (does not delete message history).
 *
 * Dry-run (default):
 *   pnpm --filter @atlas/backend cleanup:telegram
 *
 * Apply:
 *   CONFIRM_CLEANUP=YES pnpm --filter @atlas/backend cleanup:telegram
 *
 * Match tiers:
 *   A (safe): peer ids 777000/42777, meta.self, meta.support
 *   B (notification titles): Login code / Security alerts / etc. — never bare "Telegram" alone
 */

import { PrismaClient } from "@prisma/client";
import {
  isOfficialTelegramServicePeer,
  looksLikeTelegramServiceDialogLabel,
  shouldIgnoreTelegramDialog
} from "@atlas/shared";

const prisma = new PrismaClient();
const apply = process.env.CONFIRM_CLEANUP === "YES";

async function main() {
  const chats = await prisma.telegramChat.findMany({
    where: { isArchived: false },
    select: {
      id: true,
      workspaceId: true,
      telegramAccountId: true,
      telegramChatId: true,
      chatType: true,
      title: true,
      username: true,
      firstName: true,
      lastName: true,
      unreadCount: true,
      rawMetadataJson: true
    }
  });

  const matches = [];
  for (const chat of chats) {
    const meta =
      chat.rawMetadataJson && typeof chat.rawMetadataJson === "object" && !Array.isArray(chat.rawMetadataJson)
        ? chat.rawMetadataJson
        : {};
    const tierA =
      isOfficialTelegramServicePeer(chat.telegramChatId) || Boolean(meta.self) || Boolean(meta.support);
    const tierB = looksLikeTelegramServiceDialogLabel(chat.title, chat.username, chat.firstName);
    const ignore = shouldIgnoreTelegramDialog({
      telegramChatId: chat.telegramChatId,
      chatType: chat.chatType,
      title: chat.title,
      username: chat.username,
      firstName: chat.firstName,
      lastName: chat.lastName,
      isSelf: Boolean(meta.self),
      isSupport: Boolean(meta.support)
    });

    // Never quarantine a human named "Telegram" via title alone (no lastName + not tierA).
    if (!ignore && !tierA && !tierB) continue;
    if (!tierA && /^telegram$/i.test((chat.title || chat.firstName || "").trim()) && chat.lastName) {
      continue;
    }
    if (!ignore) continue;

    matches.push({
      id: chat.id,
      telegramAccountId: chat.telegramAccountId,
      telegramChatId: chat.telegramChatId,
      title: chat.title,
      unreadCount: chat.unreadCount,
      tier: tierA ? "A" : "B"
    });
  }

  console.log(JSON.stringify({ apply, matchCount: matches.length, matches: matches.slice(0, 100) }, null, 2));

  if (!apply) {
    console.log("Dry-run only. Re-run with CONFIRM_CLEANUP=YES to archive matches.");
    return;
  }

  for (const match of matches) {
    await prisma.telegramChat.update({
      where: { id: match.id },
      data: {
        isArchived: true,
        unreadCount: 0,
        needsCrmAttention: false,
        isPinned: false
      }
    });
  }
  console.log(JSON.stringify({ archived: matches.length }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
