import type { PrismaClient } from "@prisma/client";
import {
  isCrmContactIdentityWeak,
  planLinkedCrmContactIdentityRepair,
  telegramChatHasRepairableIdentity,
  type LinkedTelegramChatIdentity
} from "@atlas/shared";

export type CrmContactIdentityRepairChat = {
  readonly workspaceId: string;
  readonly telegramChatId: string;
  readonly chatType: string;
  readonly title: string;
  readonly username: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly isBot: boolean;
  readonly isArchived?: boolean;
  readonly crmContactId: string | null;
  readonly rawMetadataJson?: unknown;
};

type IdentityRepairStore = Pick<PrismaClient, "crmContact">;

function asMeta(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function telegramIdentityFromChatRow(chat: CrmContactIdentityRepairChat): LinkedTelegramChatIdentity {
  const meta = asMeta(chat.rawMetadataJson);
  return {
    workspaceId: chat.workspaceId,
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

/**
 * Cheap in-memory gate, then a primary-key contact read, then UPDATE only changed fields.
 * Safe to call on every inbound message — no write when CRM is already healthy.
 */
export async function healLinkedCrmContactIdentityFromChat(
  prisma: IdentityRepairStore,
  chat: CrmContactIdentityRepairChat
): Promise<boolean> {
  if (!chat.crmContactId) return false;

  const telegram = telegramIdentityFromChatRow(chat);
  if (!telegramChatHasRepairableIdentity(telegram)) return false;

  const contact = await prisma.crmContact.findFirst({
    where: { id: chat.crmContactId, workspaceId: chat.workspaceId },
    select: { id: true, workspaceId: true, displayName: true, username: true }
  });
  if (!contact) return false;
  if (!isCrmContactIdentityWeak(contact.displayName, contact.username, chat.telegramChatId)) {
    return false;
  }

  const plan = planLinkedCrmContactIdentityRepair({
    contact: {
      workspaceId: contact.workspaceId,
      displayName: contact.displayName,
      username: contact.username
    },
    chat: telegram
  });
  if (!plan) return false;

  await prisma.crmContact.update({
    where: { id: contact.id },
    data: {
      ...(plan.displayName !== undefined ? { displayName: plan.displayName } : {}),
      ...(plan.username !== undefined ? { username: plan.username } : {})
    }
  });
  return true;
}

export async function healWeakLinkedCrmIdentitiesForAccount(
  prisma: PrismaClient,
  input: { readonly workspaceId: string; readonly telegramAccountId: string; readonly limit?: number }
): Promise<{ scanned: number; updated: number }> {
  const chats = await prisma.telegramChat.findMany({
    where: {
      workspaceId: input.workspaceId,
      telegramAccountId: input.telegramAccountId,
      crmContactId: { not: null },
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
      crmContactId: true,
      rawMetadataJson: true
    },
    take: input.limit ?? 500
  });

  let updated = 0;
  for (const chat of chats) {
    if (await healLinkedCrmContactIdentityFromChat(prisma, chat)) {
      updated += 1;
    }
  }
  return { scanned: chats.length, updated };
}
