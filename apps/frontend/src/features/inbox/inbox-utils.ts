import type { CrmConversationStatus, CrmInboxCountsDto, CrmInboxFilter, TelegramChatDto, TelegramMessageDto } from "@atlas/shared";
import { contactDisplayTitleQuality, formatTelegramUserFallbackTitle, isPrivateStorageMediaUrl, isTemporaryTelegramUserTitle } from "@atlas/shared";
import { resolveContactIdentity } from "./contact-identity";

export type InboxChatKind = "private" | "group" | "channel" | "bot";

/** CRM-first inbox filters — mirrors the shared `crmInboxFilters` catalog. */
export type InboxFilter = CrmInboxFilter;

/** Compact status labels for CRM status pills. */
export const crmStatusLabels: Record<CrmConversationStatus, string> = {
  NEW: "New",
  OPEN: "Open",
  WAITING: "Waiting",
  RESOLVED: "Resolved",
  CLOSED: "Closed"
};

/** Compact status pill colors, aligned with the Atlas palette. */
export const crmStatusStyles: Record<CrmConversationStatus, string> = {
  NEW: "bg-sky-100 text-sky-700",
  OPEN: "bg-amber-100 text-amber-700",
  WAITING: "bg-violet-100 text-violet-700",
  RESOLVED: "bg-emerald-100 text-emerald-700",
  CLOSED: "bg-muted text-muted-foreground"
};

export interface InboxConversation {
  readonly chat: TelegramChatDto;
  readonly accountLabel: string;
  readonly displayTitle: string;
  readonly kind: InboxChatKind;
  readonly preview: string;
  readonly searchText: string;
}

const RAW_ID_PATTERN = /^-?\d{5,}$/;

const MEDIA_PREVIEW_PATTERNS: ReadonlyArray<{ readonly pattern: RegExp; readonly label: string }> = [
  { pattern: /^(📷|📸)?\s*photo$/i, label: "📷 Photo" },
  { pattern: /^(🎥|🎬|📹)?\s*video( message)?$/i, label: "🎥 Video" },
  { pattern: /^(📄|📎)?\s*(document|file|attachment)$/i, label: "📄 Document" },
  { pattern: /^(🎤|🎙️)?\s*(voice|voice message)$/i, label: "🎤 Voice Message" },
  { pattern: /^(📍|📌)?\s*location$/i, label: "📍 Location" },
  { pattern: /^(🎵|🎧)?\s*(audio|music)$/i, label: "🎵 Audio" },
  { pattern: /^(👤|👥)?\s*contact$/i, label: "👤 Contact" },
  { pattern: /^(🎞️|🖼|🎞)?\s*sticker$/i, label: "🖼 Sticker" },
  { pattern: /^(🎞️|🎞|🖼)?\s*(gif|animation)$/i, label: "🎞 GIF" },
  { pattern: /^(📊)?\s*poll$/i, label: "📊 Poll" },
  { pattern: /^(🎲)?\s*dice$/i, label: "🎲 Dice" },
  { pattern: /^\[photo\]$/i, label: "📷 Photo" },
  { pattern: /^\[video\]$/i, label: "🎥 Video" },
  { pattern: /^\[document\]$/i, label: "📄 Document" },
  { pattern: /^\[voice\]$/i, label: "🎤 Voice Message" },
  { pattern: /^\[location\]$/i, label: "📍 Location" },
  { pattern: /^\[gif\]$/i, label: "🎞 GIF" },
  { pattern: /^\[poll\]$/i, label: "📊 Poll" },
  { pattern: /^\[dice\]$/i, label: "🎲 Dice" }
];

/**
 * Returns whether a value looks like a raw Telegram numeric id.
 */
export function isRawTelegramId(value: string | null | undefined): boolean {
  if (!value) return false;
  return RAW_ID_PATTERN.test(value.trim());
}

/**
 * Resolves a human-readable chat title that never exposes raw Telegram ids.
 * Order: Telegram title → first+last → username → Unknown (phone via CRM identity helper).
 */
export function resolveDisplayTitle(
  chat: Pick<TelegramChatDto, "title" | "chatType" | "firstName" | "lastName"> & {
    readonly username?: string | null;
    readonly telegramChatId?: string | null;
    readonly isBot?: boolean;
    readonly phone?: string | null;
  }
): string {
  return resolveContactIdentity({
    title: chat.title,
    firstName: chat.firstName,
    lastName: chat.lastName,
    username: chat.username ?? null,
    phone: chat.phone ?? null,
    telegramChatId: chat.telegramChatId ?? null,
    chatType: chat.chatType,
    ...(chat.isBot !== undefined ? { isBot: chat.isBot } : {})
  }).displayName;
}

/**
 * Classifies a chat for icons and filters. Bots are inferred from metadata or username convention.
 */
export function resolveChatKind(
  chat: Pick<TelegramChatDto, "chatType"> & { readonly username?: string | null; readonly isBot?: boolean }
): InboxChatKind {
  const username = chat.username?.toLowerCase() ?? "";
  if (chat.isBot || username.endsWith("bot") || username === "botfather") {
    return "bot";
  }
  switch (chat.chatType) {
    case "GROUP":
    case "SUPERGROUP":
      return "group";
    case "CHANNEL":
      return "channel";
    case "PRIVATE":
      return "private";
    default:
      return "private";
  }
}

/**
 * Formats the one-line message preview shown in the conversation list.
 * Prefers worker-stored emoji labels already present in lastMessagePreview.
 */
export function formatMessagePreview(
  chat: Pick<
    TelegramChatDto,
    "lastMessagePreview" | "lastMessageDirection" | "title" | "chatType" | "firstName" | "lastName"
  > & {
    readonly username?: string | null;
    readonly telegramChatId?: string | null;
  }
): string {
  const raw = chat.lastMessagePreview?.trim() ?? "";
  if (!raw) return "No messages yet";

  // Keep captioned media previews (e.g. "📷 hello") and exact media labels as stored by the worker.
  const media = MEDIA_PREVIEW_PATTERNS.find((entry) => entry.pattern.test(raw));
  const body = media?.label ?? raw.replace(/\s+/g, " ");

  if (chat.lastMessageDirection === "OUTBOUND") {
    return `You: ${body}`;
  }

  if (chat.lastMessageDirection === "INBOUND") {
    const kind = resolveChatKind(chat);
    if (kind === "private" || kind === "bot") {
      const name = firstName(resolveDisplayTitle(chat));
      if (name && !name.startsWith("Unknown")) {
        return `${name}: ${body}`;
      }
    }
  }

  return body;
}

/**
 * Formats a compact relative/absolute timestamp for the inbox list.
 */
export function formatInboxTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfDate) / 86_400_000);
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff > 1 && dayDiff < 7) {
    return date.toLocaleDateString([], { weekday: "short" });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

/** Unread visual urgency based only on unread age (not CRM status). */
export type UnreadUrgency = "none" | "fresh" | "waiting" | "urgent";

/** Unread for under 2 minutes. */
export const UNREAD_FRESH_MS = 2 * 60_000;
/** Unread waiting band ends at 10 minutes (then urgent). */
export const UNREAD_WAITING_MS = 10 * 60_000;
/** One-shot arrival pulse window after lastMessageAt. */
export const UNREAD_ARRIVAL_PULSE_MS = 4_000;

/**
 * Resolves unread list urgency from unread count + last message age.
 * Read-only presentation helper — does not change filters or CRM status.
 */
export function resolveUnreadUrgency(
  unreadCount: number,
  lastMessageAt: string | null,
  nowMs: number = Date.now()
): UnreadUrgency {
  if (unreadCount <= 0 || !lastMessageAt) return "none";
  const at = Date.parse(lastMessageAt);
  if (!Number.isFinite(at)) return "none";
  const age = Math.max(0, nowMs - at);
  if (age < UNREAD_FRESH_MS) return "fresh";
  if (age < UNREAD_WAITING_MS) return "waiting";
  return "urgent";
}

/**
 * True while a newly arrived unread message should play the short arrival pulse.
 */
export function isUnreadArrivalPulseActive(lastMessageAt: string | null, nowMs: number = Date.now()): boolean {
  if (!lastMessageAt) return false;
  const at = Date.parse(lastMessageAt);
  if (!Number.isFinite(at)) return false;
  const age = nowMs - at;
  return age >= 0 && age < UNREAD_ARRIVAL_PULSE_MS;
}

/**
 * Builds a stable avatar color from a seed string.
 */
export function avatarColor(seed: string): string {
  const palette = ["#0f766e", "#0369a1", "#7c3aed", "#be123c", "#b45309", "#15803d", "#4338ca", "#0e7490"];
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return palette[hash % palette.length]!;
}

/**
 * Builds initials for avatar fallbacks.
 */
export function avatarInitials(title: string): string {
  const parts = title
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase();
}

/**
 * Maps API chats into inbox conversation view-models.
 */
export function toInboxConversation(chat: TelegramChatDto, accountLabel: string): InboxConversation {
  const displayTitle = resolveDisplayTitle(chat);
  const kind = resolveChatKind(chat);
  const preview = formatMessagePreview(chat);
  // Username/phone only enter searchText when the backend included them (never for Staff).
  const searchText = [
    displayTitle,
    preview,
    accountLabel,
    chat.id,
    chat.username ?? "",
    chat.phone ?? "",
    ...chat.tags.map((tag) => tag.name)
  ]
    .join(" ")
    .toLowerCase();
  return { chat, accountLabel, displayTitle, kind, preview, searchText };
}

/**
 * Derives inbox filter badge counts from the already-loaded conversation list.
 * Avoids polling /api/crm/inbox/counts on every realtime chat update.
 */
export function computeInboxCounts(
  conversations: readonly InboxConversation[],
  currentUserId: string | null
): CrmInboxCountsDto {
  let unassigned = 0;
  let mine = 0;
  let newCount = 0;
  let open = 0;
  let waiting = 0;
  let unread = 0;
  let resolved = 0;

  for (const item of conversations) {
    if (item.chat.assignedUserId === null) unassigned += 1;
    if (currentUserId && item.chat.assignedUserId === currentUserId) mine += 1;
    if (item.chat.crmStatus === "NEW") newCount += 1;
    if (item.chat.crmStatus === "OPEN") open += 1;
    if (item.chat.crmStatus === "WAITING") waiting += 1;
    if (item.chat.unreadCount > 0) unread += 1;
    if (item.chat.crmStatus === "RESOLVED" || item.chat.crmStatus === "CLOSED") resolved += 1;
  }

  return {
    all: conversations.length,
    unassigned,
    mine,
    new: newCount,
    open,
    waiting,
    unread,
    resolved
  };
}

/**
 * Filters and sorts conversations for the active CRM tab + search query.
 * `currentUserId` resolves the "mine" filter and is ignored by other filters.
 */
export function filterConversations(
  conversations: readonly InboxConversation[],
  filter: InboxFilter,
  query: string,
  currentUserId?: string | null
): InboxConversation[] {
  const normalized = query.trim().toLowerCase();
  return sortConversations(
    conversations
      .filter((item) => matchesFilter(item, filter, currentUserId ?? null))
      .filter((item) => (normalized ? item.searchText.includes(normalized) : true))
  );
}

/**
 * Shared inbox comparator (REST flatten + WebSocket merge must agree):
 * pinned first → lastMessageAt desc → updatedAt proxy desc → stable chat id.
 * TelegramChatDto has no updatedAt; claimedAt/assignedAt act as the proxy.
 */
export function compareInboxConversations(left: InboxConversation, right: InboxConversation): number {
  if (left.chat.isPinned !== right.chat.isPinned) {
    return left.chat.isPinned ? -1 : 1;
  }
  const leftAt = left.chat.lastMessageAt ? Date.parse(left.chat.lastMessageAt) : 0;
  const rightAt = right.chat.lastMessageAt ? Date.parse(right.chat.lastMessageAt) : 0;
  if (rightAt !== leftAt) return rightAt - leftAt;
  const leftUpdated = conversationUpdatedAtMs(left);
  const rightUpdated = conversationUpdatedAtMs(right);
  if (rightUpdated !== leftUpdated) return rightUpdated - leftUpdated;
  return left.chat.id.localeCompare(right.chat.id);
}

/**
 * Pins first, then lastMessageAt descending, then updatedAt proxy, then stable id.
 */
export function sortConversations(conversations: readonly InboxConversation[]): InboxConversation[] {
  return conversations.slice().sort(compareInboxConversations);
}

/** Best-effort conversation “updatedAt” when the DTO omits a dedicated field. */
function conversationUpdatedAtMs(item: InboxConversation): number {
  const claimed = item.chat.claimedAt ? Date.parse(item.chat.claimedAt) : 0;
  const assigned = item.chat.assignedAt ? Date.parse(item.chat.assignedAt) : 0;
  return Math.max(claimed, assigned);
}

/**
 * Patches one conversation after a message activity and re-sorts the inbox.
 * Merges by chat id only — never duplicates. Preserves identity fields when partial.
 */
export function applyChatActivity(
  conversations: readonly InboxConversation[],
  input: {
    readonly chatId: string;
    readonly previewText: string;
    readonly sentAt: string;
    readonly direction: "INBOUND" | "OUTBOUND";
    readonly unreadCount?: number;
    readonly bumpUnread?: boolean;
    readonly title?: string;
    readonly firstName?: string | null;
    readonly lastName?: string | null;
    readonly username?: string | null;
    readonly phone?: string | null;
    readonly chatType?: string;
    readonly isBot?: boolean;
    readonly isPinned?: boolean;
    readonly identityResolved?: boolean;
    readonly needsCrmAttention?: boolean;
    readonly telegramChatId?: string;
    readonly accountLabel?: string;
    readonly telegramAccountId?: string;
    readonly crmStatus?: TelegramChatDto["crmStatus"];
    readonly assignedUserId?: string | null;
    readonly assignedUserName?: string | null;
    readonly assignedAt?: string | null;
    readonly claimedAt?: string | null;
  }
): InboxConversation[] {
  let found = false;
  const next = conversations.map((item) => {
    if (item.chat.id !== input.chatId) return item;
    found = true;
    const chat: TelegramChatDto = {
      ...item.chat,
      lastMessagePreview: input.previewText.slice(0, 500),
      lastMessageAt: input.sentAt,
      lastMessageDirection: input.direction,
      unreadCount:
        typeof input.unreadCount === "number"
          ? input.unreadCount
          : input.bumpUnread
            ? item.chat.unreadCount + 1
            : item.chat.unreadCount,
      ...(input.title !== undefined && isBetterTitle(input.title, item.chat.title, item.chat.telegramChatId)
        ? { title: input.title }
        : {}),
      ...(input.firstName !== undefined && input.firstName && !item.chat.firstName ? { firstName: input.firstName } : {}),
      ...(input.lastName !== undefined && input.lastName && !item.chat.lastName ? { lastName: input.lastName } : {}),
      ...(input.username !== undefined && input.username && !item.chat.username ? { username: input.username } : {}),
      ...(input.phone !== undefined && input.phone && !item.chat.phone ? { phone: input.phone } : {}),
      ...(input.chatType !== undefined && input.chatType !== "UNKNOWN" ? { chatType: input.chatType } : {}),
      ...(input.isBot !== undefined ? { isBot: input.isBot } : {}),
      ...(input.isPinned !== undefined ? { isPinned: input.isPinned } : {}),
      ...(input.identityResolved !== undefined ? { identityResolved: input.identityResolved } : {}),
      ...(input.needsCrmAttention !== undefined ? { needsCrmAttention: input.needsCrmAttention } : {}),
      ...(input.telegramChatId !== undefined ? { telegramChatId: input.telegramChatId } : {}),
      ...(input.crmStatus !== undefined ? { crmStatus: input.crmStatus } : {}),
      ...(input.assignedUserId !== undefined ? { assignedUserId: input.assignedUserId } : {}),
      ...(input.assignedUserName !== undefined ? { assignedUserName: input.assignedUserName } : {}),
      ...(input.assignedAt !== undefined ? { assignedAt: input.assignedAt } : {}),
      ...(input.claimedAt !== undefined ? { claimedAt: input.claimedAt } : {})
    };
    return toInboxConversation(chat, item.accountLabel);
  });

  if (!found && (input.accountLabel || input.telegramAccountId)) {
    const peerId = input.telegramChatId ?? "";
    const stubTitle =
      input.title && !isTemporaryTelegramUserTitle(input.title) && !/^-?\d{5,}$/.test(input.title.trim())
        ? input.title
        : peerId
          ? formatTelegramUserFallbackTitle(peerId)
          : input.title ?? "Unknown User";
    const stub: TelegramChatDto = {
      id: input.chatId,
      telegramAccountId: input.telegramAccountId ?? "",
      telegramChatId: input.telegramChatId ?? input.chatId,
      chatType: input.chatType ?? "PRIVATE",
      title: stubTitle,
      username: input.username ?? null,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      phone: input.phone ?? null,
      lastMessagePreview: input.previewText.slice(0, 500),
      lastMessageAt: input.sentAt,
      lastMessageDirection: input.direction,
      unreadCount: typeof input.unreadCount === "number" ? input.unreadCount : input.bumpUnread ? 1 : 0,
      isPinned: input.isPinned ?? false,
      isBot: input.isBot ?? false,
      identityResolved: input.identityResolved ?? false,
      crmStatus: input.crmStatus ?? "NEW",
      assignedUserId: input.assignedUserId ?? null,
      assignedUserName: input.assignedUserName ?? null,
      assignedAt: input.assignedAt ?? null,
      claimedAt: input.claimedAt ?? null,
      needsCrmAttention: input.needsCrmAttention ?? true,
      tags: []
    };
    next.push(toInboxConversation(stub, input.accountLabel ?? "Telegram"));
  }

  return sortConversations(next);
}

function isBetterTitle(incoming: string, existing: string, telegramChatId?: string | null): boolean {
  if (!incoming.trim()) return false;
  return contactDisplayTitleQuality(incoming, telegramChatId) > contactDisplayTitleQuality(existing, telegramChatId);
}

/**
 * Merges a message into an open conversation timeline without duplicates.
 * Dedupes by database id, or telegramAccountId + chatId + telegramMessageId.
 */
export function mergeMessage(
  messages: readonly TelegramMessageDto[],
  incoming: TelegramMessageDto
): TelegramMessageDto[] {
  return mergeAndDeduplicate(messages, incoming);
}

/**
 * Functional realtime merge: keep current messages, upsert incoming, sort by sentAt.
 */
export function mergeAndDeduplicate(
  messages: readonly TelegramMessageDto[],
  incoming: TelegramMessageDto
): TelegramMessageDto[] {
  const matchIndex = messages.findIndex((row) => isSameMessage(row, incoming));
  if (matchIndex >= 0) {
    const copy = messages.slice();
    const existing = copy[matchIndex]!;
    // Keep the existing database id so React keys stay stable across upserts.
    // Preserve Atlas attribution if the echo arrives without sender fields.
    copy[matchIndex] = {
      ...existing,
      ...incoming,
      id: existing.id,
      mediaUrl: pickPlayableMediaUrl(incoming.mediaUrl, existing.mediaUrl),
      thumbnailUrl: pickPlayableMediaUrl(incoming.thumbnailUrl, existing.thumbnailUrl),
      mediaDownloadState:
        incoming.mediaDownloadState && incoming.mediaDownloadState !== "NONE"
          ? incoming.mediaDownloadState
          : existing.mediaDownloadState,
      mediaUploadState:
        incoming.mediaUploadState && incoming.mediaUploadState !== "NONE"
          ? incoming.mediaUploadState
          : existing.mediaUploadState,
      mediaError: incoming.mediaError ?? existing.mediaError,
      internalSenderUserId: incoming.internalSenderUserId ?? existing.internalSenderUserId,
      internalSenderSessionId: incoming.internalSenderSessionId ?? existing.internalSenderSessionId ?? null,
      internalSenderRole: incoming.internalSenderRole ?? existing.internalSenderRole ?? null,
      internalSenderName: incoming.internalSenderName ?? existing.internalSenderName ?? null,
      attributionSource:
        incoming.internalSenderUserId || existing.internalSenderUserId
          ? "ATLAS"
          : incoming.attributionSource ?? existing.attributionSource ?? (incoming.direction === "OUTBOUND" ? "TELEGRAM_EXTERNAL" : null),
      originKind:
        incoming.internalSenderUserId || existing.internalSenderUserId || incoming.originKind === "OUTBOUND_ATLAS" || existing.originKind === "OUTBOUND_ATLAS"
          ? "OUTBOUND_ATLAS"
          : incoming.originKind ??
            existing.originKind ??
            (incoming.direction === "INBOUND" ? "INBOUND_TELEGRAM" : "OUTBOUND_TELEGRAM_SYNCED")
    };
    return sortMessagesChronologically(copy);
  }
  return sortMessagesChronologically([...messages, incoming]);
}

/**
 * Merges many messages while preserving chronological order and uniqueness.
 */
export function mergeMessages(
  messages: readonly TelegramMessageDto[],
  incoming: readonly TelegramMessageDto[]
): TelegramMessageDto[] {
  return incoming.reduce<TelegramMessageDto[]>((current, row) => mergeAndDeduplicate(current, row), messages.slice());
}

function isSameMessage(left: TelegramMessageDto, right: TelegramMessageDto): boolean {
  if (left.id === right.id) return true;
  if (
    left.telegramMessageId &&
    right.telegramMessageId &&
    left.telegramMessageId === right.telegramMessageId &&
    left.telegramAccountId === right.telegramAccountId &&
    left.chatId === right.chatId &&
    !left.telegramMessageId.startsWith("pending:") &&
    !right.telegramMessageId.startsWith("pending:")
  ) {
    return true;
  }
  return (
    Boolean(left.telegramMessageId?.startsWith("pending:")) &&
    right.direction === "OUTBOUND" &&
    left.direction === "OUTBOUND" &&
    left.chatId === right.chatId &&
    left.telegramAccountId === right.telegramAccountId &&
    left.text === right.text
  );
}

function sortMessagesChronologically(messages: readonly TelegramMessageDto[]): TelegramMessageDto[] {
  return messages.slice().sort((left, right) => {
    const leftAt = Date.parse(left.sentAt) || 0;
    const rightAt = Date.parse(right.sentAt) || 0;
    if (leftAt !== rightAt) return leftAt - rightAt;
    return left.id.localeCompare(right.id);
  });
}

function matchesFilter(item: InboxConversation, filter: InboxFilter, currentUserId: string | null): boolean {
  switch (filter) {
    case "all":
      return true;
    case "unassigned":
      return item.chat.assignedUserId === null;
    case "mine":
      return currentUserId !== null && item.chat.assignedUserId === currentUserId;
    case "new":
      return item.chat.crmStatus === "NEW";
    case "open":
      return item.chat.crmStatus === "OPEN";
    case "waiting":
      return item.chat.crmStatus === "WAITING";
    case "unread":
      return item.chat.unreadCount > 0;
    case "resolved":
      return item.chat.crmStatus === "RESOLVED" || item.chat.crmStatus === "CLOSED";
    default:
      return true;
  }
}

function firstName(title: string): string {
  return title.trim().split(/\s+/)[0] ?? title;
}

function unknownTitleForKind(kind: InboxChatKind): string {
  switch (kind) {
    case "bot":
      return "Unknown Bot";
    case "group":
      return "Unknown Group";
    case "channel":
      return "Unknown Channel";
    default:
      return "Unknown User";
  }
}

function isGenericUnknownTitle(title: string): boolean {
  return /^unknown(\s+(chat|user|group|channel|bot))?$/i.test(title.trim());
}

/**
 * Returns whether a conversation still needs Telegram identity backfill.
 */
export function needsIdentityBackfill(chat: TelegramChatDto): boolean {
  if (chat.identityResolved === false) return true;
  const title = resolveDisplayTitle(chat);
  if (!title || isRawTelegramId(title) || title === chat.telegramChatId || isGenericUnknownTitle(title)) {
    return true;
  }
  return false;
}

/**
 * Prefer incoming media URLs unless they are null or private MinIO endpoints.
 */
function pickPlayableMediaUrl(
  incoming: string | null | undefined,
  existing: string | null | undefined
): string | null {
  if (incoming && !isPrivateStorageMediaUrl(incoming)) return incoming;
  if (existing && !isPrivateStorageMediaUrl(existing)) return existing;
  return null;
}
