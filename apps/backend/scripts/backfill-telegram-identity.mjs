/**
 * Dry-run (default) backfill for telegram_chats whose title is still a naked numeric peer id,
 * "Unknown User", or "Telegram user <peerId>".
 *
 * Reports counts only. Does not create duplicate conversations.
 *
 * Usage:
 *   pnpm --filter @atlas/backend identity:backfill
 *   CONFIRM_APPLY=YES pnpm --filter @atlas/backend identity:backfill
 */

import { PrismaClient } from "@prisma/client";
import {
  buildCrmContactDisplayTitle,
  formatTelegramUserFallbackTitle,
  isTemporaryTelegramUserTitle,
  isUsableHumanDisplayTitle,
  shouldIgnoreTelegramDialog
} from "@atlas/shared";

const prisma = new PrismaClient();
const apply = process.env.CONFIRM_APPLY === "YES";

function isCandidateTitle(title, telegramChatId) {
  const trimmed = title.trim();
  if (!trimmed) return true;
  if (/^unknown(\s|$)/i.test(trimmed)) return true;
  if (isTemporaryTelegramUserTitle(trimmed)) return true;
  if (trimmed === telegramChatId.trim()) return true;
  return false;
}

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
      peerPhone: true,
      isBot: true,
      accessHash: true,
      peerType: true,
      crmContactId: true,
      rawMetadataJson: true
    },
    take: 10_000
  });

  let scanned = 0;
  let candidates = 0;
  let normalizedFallback = 0;
  let upgradedFromFields = 0;
  let skippedService = 0;
  let skippedGroup = 0;
  let incompleteAccessHash = 0;
  let incompletePeerType = 0;

  for (const chat of chats) {
    scanned += 1;
    const meta =
      chat.rawMetadataJson && typeof chat.rawMetadataJson === "object" && !Array.isArray(chat.rawMetadataJson)
        ? chat.rawMetadataJson
        : {};
    if (
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
      skippedService += 1;
      continue;
    }

    const isPrivate =
      String(chat.chatType ?? "").toUpperCase() === "PRIVATE" ||
      !String(chat.telegramChatId).startsWith("-");
    if (isPrivate && !chat.accessHash) incompleteAccessHash += 1;
    if (isPrivate && !chat.peerType) incompletePeerType += 1;

    if (!isCandidateTitle(chat.title, chat.telegramChatId)) {
      continue;
    }
    candidates += 1;

    const type = String(chat.chatType ?? "PRIVATE").toUpperCase();
    if (type === "GROUP" || type === "SUPERGROUP" || type === "CHANNEL") {
      skippedGroup += 1;
      // Groups/channels: only normalize Unknown placeholders if title fields exist in DB.
      const next = buildCrmContactDisplayTitle({
        groupTitle: chat.title,
        username: chat.username,
        telegramChatId: chat.telegramChatId,
        chatType: chat.chatType,
        isBot: chat.isBot
      });
      if (next !== chat.title && apply) {
        await prisma.telegramChat.update({ where: { id: chat.id }, data: { title: next } });
      }
      continue;
    }

    const nextTitle = buildCrmContactDisplayTitle({
      firstName: chat.firstName,
      lastName: chat.lastName,
      username: chat.username,
      phone: chat.peerPhone,
      telegramChatId: chat.telegramChatId,
      chatType: chat.chatType || "PRIVATE",
      isBot: chat.isBot
    });

    if (isUsableHumanDisplayTitle(nextTitle, chat.telegramChatId)) {
      upgradedFromFields += 1;
      if (apply) {
        await prisma.telegramChat.update({
          where: { id: chat.id },
          data: { title: nextTitle }
        });
        if (chat.crmContactId) {
          await prisma.crmContact
            .updateMany({
              where: {
                id: chat.crmContactId,
                OR: [
                  { displayName: { startsWith: "Unknown", mode: "insensitive" } },
                  { displayName: { startsWith: "Telegram user ", mode: "insensitive" } },
                  { displayName: chat.telegramChatId }
                ]
              },
              data: { displayName: nextTitle }
            })
            .catch(() => undefined);
        }
      }
      continue;
    }

    const fallback = formatTelegramUserFallbackTitle(chat.telegramChatId);
    if (fallback !== chat.title) {
      normalizedFallback += 1;
      if (apply) {
        await prisma.telegramChat.update({
          where: { id: chat.id },
          data: { title: fallback }
        });
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        mode: apply ? "APPLY" : "DRY_RUN",
        scanned,
        candidates,
        upgradedFromFields,
        normalizedFallback,
        incompletePrivateMissingAccessHash: incompleteAccessHash,
        incompletePrivateMissingPeerType: incompletePeerType,
        skippedService,
        skippedGroupHint: skippedGroup,
        hint: apply
          ? "Applied DB title normalization. Trigger chat-metadata-backfill / INITIAL_SYNC for live Telegram entity resolve. Access hashes only resolve from live inbound or worker entity backfill."
          : "Dry-run only. Set CONFIRM_APPLY=YES to write titles. Entity/access_hash resolve still requires worker live inbound or metadata backfill."
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
