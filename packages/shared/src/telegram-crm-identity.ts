/**
 * CRM contact identity + dialog eligibility for Telegram sync.
 * Official service / Saved Messages / archived dialogs must never enter CRM.
 */

/** Well-known Telegram official / notification user ids (private peers). */
export const TELEGRAM_OFFICIAL_SERVICE_USER_IDS: ReadonlySet<string> = new Set([
  "777000", // Telegram service notifications (login codes, security alerts)
  "42777" // Telegram official account
]);

const SERVICE_NOTIFICATION_TITLE_PATTERNS: ReadonlyArray<RegExp> = [
  /^telegram\s+notifications?$/i,
  /^login\s+codes?$/i,
  /^security\s+(alert|code|codes|notification)s?$/i,
  /^two[-\s]?step\s+verification$/i,
  /^2[-\s]?step\s+verification$/i,
  /^verification\s+(code|codes|message|messages)$/i
];

/** Bare "Telegram" alone is NOT enough — real users may use that name. */
const BARE_TELEGRAM_LABEL = /^telegram$/i;

export type TelegramCrmChatType = "PRIVATE" | "GROUP" | "SUPERGROUP" | "CHANNEL" | "UNKNOWN" | string;

export interface TelegramDialogEligibilityInput {
  readonly telegramChatId: string;
  readonly chatType?: TelegramCrmChatType | null;
  readonly title?: string | null;
  readonly username?: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  /** GramJS User.self — Saved Messages. */
  readonly isSelf?: boolean | null;
  /** GramJS User.support — Telegram support. */
  readonly isSupport?: boolean | null;
  /** Dialog archived / archive folder. */
  readonly isArchived?: boolean | null;
  /** Optional authenticated account user id (Saved Messages peer match). */
  readonly selfTelegramUserId?: string | null;
}

export interface ContactDisplayTitleInput {
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly username?: string | null;
  readonly phone?: string | null;
  readonly telegramChatId?: string | null;
  /** Group/channel title, or private entity.title when present. */
  readonly groupTitle?: string | null;
  readonly chatType?: TelegramCrmChatType | null;
  readonly isBot?: boolean | null;
}

/**
 * Strips channel/group marking so private user ids compare as positive decimals.
 */
export function bareTelegramPeerId(telegramChatId: string | null | undefined): string {
  if (!telegramChatId) return "";
  const trimmed = String(telegramChatId).trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("-100") && trimmed.length > 4) {
    return trimmed.slice(4);
  }
  if (trimmed.startsWith("-")) {
    return trimmed.slice(1);
  }
  return trimmed;
}

/**
 * Returns true when this peer is an official Telegram service / notification account.
 */
export function isOfficialTelegramServicePeer(telegramChatId: string | null | undefined): boolean {
  const bare = bareTelegramPeerId(telegramChatId);
  return bare.length > 0 && TELEGRAM_OFFICIAL_SERVICE_USER_IDS.has(bare);
}

/**
 * Returns true when title/username match known official service notification labels.
 * Bare display name "Telegram" alone is insufficient (human contacts may use that name).
 */
export function looksLikeTelegramServiceDialogLabel(
  title: string | null | undefined,
  username?: string | null,
  firstName?: string | null,
  options?: { readonly requireOfficialPeerHint?: boolean }
): boolean {
  const candidates = [title, username, firstName]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
  for (const candidate of candidates) {
    if (SERVICE_NOTIFICATION_TITLE_PATTERNS.some((pattern) => pattern.test(candidate))) {
      return true;
    }
  }
  // Bare "Telegram" only when caller already knows this is support/official.
  if (options?.requireOfficialPeerHint) {
    for (const candidate of candidates) {
      if (BARE_TELEGRAM_LABEL.test(candidate)) return true;
    }
  }
  return false;
}

/**
 * Returns true when a dialog must never create CRM contacts, conversations, activities, or unread.
 */
export function shouldIgnoreTelegramDialog(input: TelegramDialogEligibilityInput): boolean {
  if (input.isArchived) return true;
  if (input.isSelf) return true;
  if (input.isSupport) return true;
  if (isOfficialTelegramServicePeer(input.telegramChatId)) return true;

  const selfId = bareTelegramPeerId(input.selfTelegramUserId);
  const peerId = bareTelegramPeerId(input.telegramChatId);
  if (selfId && peerId && selfId === peerId) return true;

  // Private-only heuristics: service notification labels must not create CRM rows.
  // Do NOT treat a human named "Telegram" as a service peer without official id / support flag.
  const chatType = String(input.chatType ?? "UNKNOWN").toUpperCase();
  if (chatType === "PRIVATE" || chatType === "UNKNOWN" || !input.chatType) {
    if (
      looksLikeTelegramServiceDialogLabel(input.title, input.username, input.firstName, {
        requireOfficialPeerHint: Boolean(input.isSupport)
      })
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Builds a CRM display title with stable priority.
 * Private: first+last → first → last → groupTitle/display_name → username → phone →
 *   "Telegram user <peerId>" → Unknown Bot/User (only when peer id is also missing).
 * Group/channel: title → username → Unknown Group/Channel.
 * Never returns a naked numeric peer id as the title.
 */
export function buildCrmContactDisplayTitle(input: ContactDisplayTitleInput): string {
  const chatType = String(input.chatType ?? "PRIVATE").toUpperCase();
  const groupTitle = cleanDisplayPart(input.groupTitle);
  const firstName = cleanDisplayPart(input.firstName);
  const lastName = cleanDisplayPart(input.lastName);
  const username = cleanDisplayPart(input.username)?.replace(/^@/, "") ?? null;
  const phone = cleanDisplayPart(input.phone);
  const telegramId = cleanDisplayPart(input.telegramChatId);
  const barePeerId = bareTelegramPeerId(telegramId);

  if (chatType === "GROUP" || chatType === "SUPERGROUP" || chatType === "CHANNEL") {
    if (groupTitle && !isRawTelegramId(groupTitle) && !isTemporaryTelegramUserTitle(groupTitle) && !/^unknown(\s|$)/i.test(groupTitle)) {
      return groupTitle.slice(0, 255);
    }
    if (username && !isRawTelegramId(username)) return username.slice(0, 255);
    return chatType === "CHANNEL" ? "Unknown Channel" : "Unknown Group";
  }

  if (firstName && lastName) {
    return `${firstName} ${lastName}`.slice(0, 255);
  }
  if (firstName && !isRawTelegramId(firstName)) {
    return firstName.slice(0, 255);
  }
  if (lastName && !isRawTelegramId(lastName)) {
    return lastName.slice(0, 255);
  }
  if (
    groupTitle &&
    !isRawTelegramId(groupTitle) &&
    !isTemporaryTelegramUserTitle(groupTitle) &&
    !/^unknown(\s|$)/i.test(groupTitle)
  ) {
    return groupTitle.slice(0, 255);
  }
  if (username && !isRawTelegramId(username)) {
    return username.slice(0, 255);
  }
  if (phone) {
    return phone.slice(0, 255);
  }
  if (barePeerId) {
    return formatTelegramUserFallbackTitle(barePeerId);
  }
  if (input.isBot) return "Unknown Bot";
  return "Unknown User";
}

/**
 * Stable temporary title when Telegram entity fields are not yet available.
 */
export function formatTelegramUserFallbackTitle(peerId: string): string {
  const bare = bareTelegramPeerId(peerId) || peerId.trim();
  return `Telegram user ${bare}`.slice(0, 255);
}

/**
 * Returns true for temporary "Telegram user <peerId>" titles (and legacy naked numeric titles).
 */
export function isTemporaryTelegramUserTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  const trimmed = title.trim();
  if (!trimmed) return false;
  if (isRawTelegramId(trimmed)) return true;
  return /^telegram\s+user\s+-?\d+$/i.test(trimmed);
}

/**
 * Ranking used when upgrading an existing conversation title after entity resolution.
 * Higher is better. Unknown / temporary peer titles rank lowest.
 */
export function contactDisplayTitleQuality(
  title: string | null | undefined,
  telegramChatId?: string | null
): number {
  if (!title) return 0;
  const trimmed = title.trim();
  if (!trimmed) return 0;
  if (/^unknown(\s|$)/i.test(trimmed)) return 0;
  if (isTemporaryTelegramUserTitle(trimmed)) return 1;
  if (telegramChatId && trimmed === telegramChatId.trim()) return 1;
  if (isRawTelegramId(trimmed)) return 1;
  if (/^\+?[0-9][\d\s()-]{5,}$/.test(trimmed)) return 2;
  // Single-token usernames / short names
  if (!/\s/.test(trimmed)) return 3;
  return 4;
}

/**
 * Returns true when a stored title is a real human/group label (not Unknown / empty).
 * Temporary "Telegram user <id>" and naked ids count as present but not human-resolved.
 */
export function isResolvedCrmDisplayTitle(
  title: string | null | undefined,
  telegramChatId?: string | null
): boolean {
  if (!title) return false;
  const trimmed = title.trim();
  if (!trimmed) return false;
  if (/^unknown(\s|$)/i.test(trimmed)) return false;
  return true;
}

/**
 * Returns true when the title is a non-placeholder, non-id label (names/usernames/group titles).
 * Used by identity backfill to decide whether entity lookup is still needed.
 */
export function isUsableHumanDisplayTitle(
  title: string | null | undefined,
  telegramChatId?: string | null
): boolean {
  if (!isResolvedCrmDisplayTitle(title, telegramChatId)) return false;
  const trimmed = title!.trim();
  if (isTemporaryTelegramUserTitle(trimmed)) return false;
  if (telegramChatId && trimmed === telegramChatId.trim()) return false;
  if (isRawTelegramId(trimmed)) return false;
  return true;
}

function cleanDisplayPart(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRawTelegramId(value: string): boolean {
  return /^-?\d{5,}$/.test(value.trim());
}
