import type { CrmContactDto, TelegramChatDto } from "@atlas/shared";
import { CUSTOMER_PRIVACY_NOTICE } from "@atlas/shared";

export interface ContactIdentityInput {
  readonly title?: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly username?: string | null;
  readonly phone?: string | null;
  readonly telegramChatId?: string | null;
  readonly chatType?: string | null;
  readonly isBot?: boolean;
  readonly contactDisplayName?: string | null;
  readonly contactUsername?: string | null;
  readonly contactPhone?: string | null;
  readonly lastSeenAt?: string | null;
  readonly privacyNotice?: string | null;
  /** When false, never surface phone/username even if present in local cache. */
  readonly allowDirectContact?: boolean;
}

export interface ContactIdentity {
  readonly displayName: string;
  readonly subtitle: string | null;
  readonly username: string | null;
  readonly phone: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly presenceLabel: string | null;
  readonly isUnknown: boolean;
  readonly privacyNotice: string | null;
}

/**
 * Resolves a single contact identity shared by chat header, list row, and CRM panel.
 * Fallback: CRM contact → Telegram title → first+last → (username/phone only when permitted) → Unknown.
 */
export function resolveContactIdentity(input: ContactIdentityInput): ContactIdentity {
  const allowDirect = input.allowDirectContact !== false;
  const firstName = clean(input.firstName);
  const lastName = clean(input.lastName);
  const username = allowDirect ? cleanUsername(input.contactUsername ?? input.username) : null;
  const phone = allowDirect ? clean(input.contactPhone ?? input.phone) : null;
  const telegramChatId = allowDirect ? clean(input.telegramChatId) : null;
  const kind = resolveKind(input.chatType, username, input.isBot);

  const crmName = usableName(input.contactDisplayName, telegramChatId);
  const title = usableName(input.title, telegramChatId);
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim() || null;

  const displayName =
    crmName ||
    fullName ||
    title ||
    (username ? username.replace(/^@/, "") : null) ||
    phone ||
    telegramChatId ||
    unknownForKind(kind);

  const isUnknown = /^unknown(\s|$)/i.test(displayName);

  const privacyNotice = input.privacyNotice ?? (!allowDirect ? CUSTOMER_PRIVACY_NOTICE : null);

  const subtitle = username
    ? `@${username.replace(/^@/, "")}`
    : phone && phone !== displayName
      ? phone
      : !allowDirect
        ? privacyNotice
        : fullName && fullName !== displayName
          ? fullName
          : null;

  return {
    displayName,
    subtitle,
    username: username ? username.replace(/^@/, "") : null,
    phone,
    firstName,
    lastName,
    presenceLabel: formatPresence(input.lastSeenAt),
    isUnknown,
    privacyNotice
  };
}

/**
 * Builds identity from an inbox chat row plus optional CRM contact panel data.
 */
export function identityFromChatAndContact(
  chat: Pick<
    TelegramChatDto,
    "title" | "firstName" | "lastName" | "chatType" | "isBot"
  > & {
    readonly username?: string | null;
    readonly telegramChatId?: string | null;
    readonly phone?: string | null;
    readonly privacyNotice?: string | null;
  },
  contact?: Pick<CrmContactDto, "displayName" | "lastSeenAt"> & {
    readonly username?: string | null;
    readonly phoneMasked?: string | null;
    readonly privacyNotice?: string | null;
  } | null,
  options?: { readonly allowDirectContact?: boolean }
): ContactIdentity {
  const allowDirect =
    options?.allowDirectContact ??
    Boolean(chat.username || chat.phone || chat.telegramChatId || contact?.username || contact?.phoneMasked);

  return resolveContactIdentity({
    title: chat.title,
    firstName: chat.firstName,
    lastName: chat.lastName,
    username: chat.username ?? null,
    phone: chat.phone ?? null,
    telegramChatId: chat.telegramChatId ?? null,
    chatType: chat.chatType,
    isBot: chat.isBot,
    contactDisplayName: contact?.displayName ?? null,
    contactUsername: contact?.username ?? null,
    contactPhone: contact?.phoneMasked ?? null,
    lastSeenAt: contact?.lastSeenAt ?? null,
    privacyNotice: chat.privacyNotice ?? contact?.privacyNotice ?? null,
    allowDirectContact: allowDirect
  });
}

function usableName(value: string | null | undefined, telegramChatId: string | null): string | null {
  const text = clean(value);
  if (!text) return null;
  if (telegramChatId && text === telegramChatId) return null;
  if (/^-?\d{5,}$/.test(text)) return null;
  if (/^unknown(\s|$)/i.test(text)) return null;
  return text;
}

function clean(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cleanUsername(value: string | null | undefined): string | null {
  const text = clean(value);
  if (!text || /^-?\d{5,}$/.test(text)) return null;
  return text.replace(/^@/, "");
}

function resolveKind(chatType: string | null | undefined, username: string | null, isBot?: boolean): string {
  const user = (username ?? "").toLowerCase();
  if (isBot || user.endsWith("bot") || user === "botfather") return "bot";
  if (chatType === "GROUP" || chatType === "SUPERGROUP") return "group";
  if (chatType === "CHANNEL") return "channel";
  return "private";
}

function unknownForKind(kind: string): string {
  if (kind === "bot") return "Unknown Bot";
  if (kind === "group") return "Unknown Group";
  if (kind === "channel") return "Unknown Channel";
  return "Unknown User";
}

function formatPresence(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const deltaMs = Date.now() - date.getTime();
  if (deltaMs < 2 * 60_000) return "Online";
  if (deltaMs < 60 * 60_000) {
    const mins = Math.max(1, Math.round(deltaMs / 60_000));
    return `Last seen ${mins}m ago`;
  }
  if (deltaMs < 24 * 60 * 60_000) {
    const hours = Math.max(1, Math.round(deltaMs / (60 * 60_000)));
    return `Last seen ${hours}h ago`;
  }
  return `Last seen ${date.toLocaleDateString([], { month: "short", day: "numeric" })}`;
}
