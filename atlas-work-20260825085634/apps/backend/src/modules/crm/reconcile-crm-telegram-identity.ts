import type { PrismaClient } from "@prisma/client";
import {
  isCrmContactIdentityWeak,
  isOfficialTelegramServicePeer,
  planLinkedCrmContactIdentityRepair,
  shouldIgnoreTelegramDialog,
  telegramChatHasRepairableIdentity,
  type LinkedTelegramChatIdentity
} from "@atlas/shared";

export interface ReconcileCrmTelegramIdentityInput {
  readonly workspaceId?: string;
  readonly dryRun?: boolean;
  readonly limit?: number;
}

export interface ReconcileCrmTelegramIdentityCounts {
  scanned: number;
  eligible: number;
  updated: number;
  skippedUnchanged: number;
  skippedService: number;
  skippedCrossWorkspace: number;
  dryRun: boolean;
}

type ReconcileChat = {
  workspaceId: string;
  telegramChatId: string;
  chatType: string;
  title: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  isBot: boolean;
  isArchived: boolean;
  rawMetadataJson: unknown;
};

function asMeta(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function telegramIdentityFromChat(chat: ReconcileChat, contactWorkspaceId: string): LinkedTelegramChatIdentity {
  const meta = asMeta(chat.rawMetadataJson);
  return {
    workspaceId: contactWorkspaceId,
    telegramChatId: chat.telegramChatId,
    chatType: chat.chatType,
    title: chat.title,
    username: chat.username,
    firstName: chat.firstName,
    lastName: chat.lastName,
    isBot: chat.isBot,
    isSelf: Boolean(meta.self || meta.isSelf),
    isSupport: Boolean(meta.support || meta.isSupport),
    isArchived: Boolean(chat.isArchived || meta.archived || meta.isArchived)
  };
}

function pickRepairChat(chats: readonly ReconcileChat[], contactWorkspaceId: string): ReconcileChat | null {
  for (const chat of chats) {
    if (chat.workspaceId !== contactWorkspaceId) continue;
    const identity = telegramIdentityFromChat(chat, contactWorkspaceId);
    if (telegramChatHasRepairableIdentity(identity)) return chat;
  }
  return null;
}

/**
 * Repairs existing CRM contacts whose stored identity is still a placeholder
 * while a linked PRIVATE telegram_chats row already has a better name/username.
 * Never changes crm_contact_id links, leaderboard ownership, or referral ownership.
 */
export async function reconcileCrmTelegramIdentities(
  prisma: PrismaClient,
  input: ReconcileCrmTelegramIdentityInput = {}
): Promise<ReconcileCrmTelegramIdentityCounts> {
  const dryRun = input.dryRun !== false;
  const counts: ReconcileCrmTelegramIdentityCounts = {
    scanned: 0,
    eligible: 0,
    updated: 0,
    skippedUnchanged: 0,
    skippedService: 0,
    skippedCrossWorkspace: 0,
    dryRun
  };

  const contacts = await prisma.crmContact.findMany({
    where: {
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      OR: [
        { displayName: { startsWith: "Unknown", mode: "insensitive" } },
        { displayName: { startsWith: "Telegram user ", mode: "insensitive" } },
        { displayName: "" },
        {
          AND: [
            { OR: [{ username: null }, { username: "" }] },
            {
              chats: {
                some: {
                  isArchived: false,
                  isBot: false,
                  chatType: { in: ["PRIVATE", "UNKNOWN"] },
                  username: { not: null }
                }
              }
            }
          ]
        }
      ]
    },
    select: {
      id: true,
      workspaceId: true,
      displayName: true,
      username: true,
      chats: {
        where: {
          isArchived: false,
          isBot: false,
          chatType: { in: ["PRIVATE", "UNKNOWN"] }
        },
        select: {
          workspaceId: true,
          telegramChatId: true,
          chatType: true,
          title: true,
          username: true,
          firstName: true,
          lastName: true,
          isBot: true,
          isArchived: true,
          rawMetadataJson: true
        },
        orderBy: { updatedAt: "desc" },
        take: 5
      }
    },
    orderBy: { updatedAt: "asc" },
    ...(input.limit != null ? { take: input.limit } : {})
  });

  for (const contact of contacts) {
    counts.scanned += 1;
    if (!isCrmContactIdentityWeak(contact.displayName, contact.username)) {
      counts.skippedUnchanged += 1;
      continue;
    }

    const sameWorkspaceChats = contact.chats.filter((chat) => chat.workspaceId === contact.workspaceId);
    if (contact.chats.length > 0 && sameWorkspaceChats.length === 0) {
      counts.skippedCrossWorkspace += 1;
      continue;
    }

    const chat = pickRepairChat(sameWorkspaceChats, contact.workspaceId);
    if (!chat) {
      const ignored = sameWorkspaceChats.some((row) => {
        const identity = telegramIdentityFromChat(row, contact.workspaceId);
        return isOfficialTelegramServicePeer(identity.telegramChatId) || shouldIgnoreTelegramDialog(identity);
      });
      if (ignored) counts.skippedService += 1;
      else counts.skippedUnchanged += 1;
      continue;
    }

    const plan = planLinkedCrmContactIdentityRepair({
      contact: {
        workspaceId: contact.workspaceId,
        displayName: contact.displayName,
        username: contact.username
      },
      chat: telegramIdentityFromChat(chat, contact.workspaceId)
    });
    if (!plan) {
      counts.skippedUnchanged += 1;
      continue;
    }

    counts.eligible += 1;
    if (dryRun) continue;

    await prisma.crmContact.update({
      where: { id: contact.id },
      data: {
        ...(plan.displayName !== undefined ? { displayName: plan.displayName } : {}),
        ...(plan.username !== undefined ? { username: plan.username } : {})
      }
    });
    counts.updated += 1;
  }

  return counts;
}
