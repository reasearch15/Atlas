import {
  isPlaceholderCrmDisplayName,
  type TelegramCrmChatType
} from "@atlas/shared";
import {
  isWeakPublicLeaderboardCrmName,
  PUBLIC_LEADERBOARD_FALLBACK_NAME,
  resolvePublicLeaderboardDisplayName,
  tryPublicLeaderboardDisplayName,
  type PublicLeaderboardNameSources
} from "./public-display-name";

export const PUBLIC_LEADERBOARD_IDENTITY_CHAT_TAKE = 8;

/** Prisma include used by every public leaderboard surface that resolves names. */
export const PUBLIC_LEADERBOARD_CONTACT_IDENTITY_SELECT = {
  id: true,
  displayName: true,
  username: true,
  chats: {
    where: { isBot: false, isArchived: false },
    select: {
      firstName: true,
      lastName: true,
      username: true,
      title: true,
      chatType: true,
      updatedAt: true
    },
    orderBy: { updatedAt: "desc" as const },
    take: PUBLIC_LEADERBOARD_IDENTITY_CHAT_TAKE
  }
} as const;

export type PublicLeaderboardIdentityChat = {
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly username?: string | null;
  readonly title?: string | null;
  readonly chatType?: TelegramCrmChatType | null;
  readonly updatedAt?: Date | string | null;
  readonly isBot?: boolean | null;
  readonly isArchived?: boolean | null;
};

export type PublicLeaderboardIdentityContact = {
  readonly displayName?: string | null;
  readonly username?: string | null;
  readonly chats?: readonly PublicLeaderboardIdentityChat[] | null;
};

export type PublicLeaderboardIdentityHealStore = {
  readonly crmContact: {
    update: (args: {
      where: { id: string };
      data: { displayName: string };
    }) => Promise<unknown>;
  };
};

export type PublicLeaderboardIdentityLogger = {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
};

function isEligibleIdentityChat(chat: PublicLeaderboardIdentityChat): boolean {
  if (chat.isBot || chat.isArchived) return false;
  const chatType = String(chat.chatType ?? "UNKNOWN").toUpperCase();
  return chatType === "PRIVATE" || chatType === "UNKNOWN";
}

function chatRecency(chat: PublicLeaderboardIdentityChat): number {
  if (!chat.updatedAt) return 0;
  const ms = chat.updatedAt instanceof Date ? chat.updatedAt.getTime() : Date.parse(String(chat.updatedAt));
  return Number.isFinite(ms) ? ms : 0;
}

function sanitizedParts(chat: PublicLeaderboardIdentityChat): string | null {
  return tryPublicLeaderboardDisplayName(
    [chat.firstName, chat.lastName].filter((part) => part && String(part).trim()).join(" ")
  );
}

/**
 * Prefers a PRIVATE/UNKNOWN chat that already has a publishable first+last,
 * then first/last alone, then a publishable private title.
 */
export function pickPublicLeaderboardIdentityChat(
  chats: readonly PublicLeaderboardIdentityChat[] | null | undefined
): PublicLeaderboardIdentityChat | null {
  const eligible = (chats ?? [])
    .filter(isEligibleIdentityChat)
    .sort((a, b) => chatRecency(b) - chatRecency(a));
  if (eligible.length === 0) return null;
  return (
    eligible.find((chat) => sanitizedParts(chat) != null) ??
    eligible.find(
      (chat) =>
        tryPublicLeaderboardDisplayName(chat.firstName) != null ||
        tryPublicLeaderboardDisplayName(chat.lastName) != null
    ) ??
    eligible.find((chat) => tryPublicLeaderboardDisplayName(chat.title) != null) ??
    eligible[0] ??
    null
  );
}

export function publicLeaderboardNameSourcesFromContact(
  contact: PublicLeaderboardIdentityContact
): PublicLeaderboardNameSources {
  const chat = pickPublicLeaderboardIdentityChat(contact.chats);
  return {
    displayName: contact.displayName ?? null,
    firstName: chat?.firstName ?? null,
    lastName: chat?.lastName ?? null,
    title: chat?.title ?? null,
    username: contact.username ?? chat?.username ?? null
  };
}

/**
 * Canonical public leaderboard display-name resolver.
 * Recovers Telegram first/last/title when the CRM label would publish as "Player".
 */
export function resolvePublicLeaderboardNameFromContact(
  contact: PublicLeaderboardIdentityContact
): string {
  return resolvePublicLeaderboardDisplayName(publicLeaderboardNameSourcesFromContact(contact));
}

export function shouldHealCrmPublicDisplayName(
  crmDisplayName: string | null | undefined,
  recoveredPublicName: string
): boolean {
  if (recoveredPublicName === PUBLIC_LEADERBOARD_FALLBACK_NAME) return false;
  if (tryPublicLeaderboardDisplayName(recoveredPublicName) == null) return false;
  if (!isWeakPublicLeaderboardCrmName(crmDisplayName) && !isPlaceholderCrmDisplayName(crmDisplayName)) {
    return false;
  }
  const current = tryPublicLeaderboardDisplayName(crmDisplayName);
  return current !== recoveredPublicName;
}

async function persistHealedCrmDisplayName(input: {
  readonly prisma: PublicLeaderboardIdentityHealStore;
  readonly crmContactId: string;
  readonly fromDisplayName: string | null | undefined;
  readonly toDisplayName: string;
  readonly logger?: PublicLeaderboardIdentityLogger | undefined;
}): Promise<boolean> {
  try {
    await input.prisma.crmContact.update({
      where: { id: input.crmContactId },
      data: { displayName: input.toDisplayName.slice(0, 255) }
    });
    input.logger?.info?.(
      {
        crmContactId: input.crmContactId,
        fromDisplayName: input.fromDisplayName ?? null,
        toDisplayName: input.toDisplayName
      },
      "leaderboard.public_name.healed"
    );
    return true;
  } catch (error) {
    input.logger?.warn?.(
      {
        err: error,
        crmContactId: input.crmContactId,
        fromDisplayName: input.fromDisplayName ?? null,
        toDisplayName: input.toDisplayName
      },
      "leaderboard.public_name.heal_failed"
    );
    return false;
  }
}

/**
 * Resolves the public name and, when the CRM value is a weak placeholder,
 * persists the recovered human name. Publish/render always uses the resolved
 * name even if the optional CRM write fails.
 */
export async function resolveAndHealPublicLeaderboardDisplayName(input: {
  readonly prisma?: PublicLeaderboardIdentityHealStore | null | undefined;
  readonly crmContactId: string;
  readonly contact: PublicLeaderboardIdentityContact;
  readonly logger?: PublicLeaderboardIdentityLogger | undefined;
}): Promise<string> {
  const resolved = resolvePublicLeaderboardNameFromContact(input.contact);
  if (!input.prisma) return resolved;
  if (!shouldHealCrmPublicDisplayName(input.contact.displayName, resolved)) return resolved;
  await persistHealedCrmDisplayName({
    prisma: input.prisma,
    crmContactId: input.crmContactId,
    fromDisplayName: input.contact.displayName,
    toDisplayName: resolved,
    ...(input.logger ? { logger: input.logger } : {})
  });
  return resolved;
}
