import type { Prisma } from "@prisma/client";
import type { NormalizedDialog } from "./telegram-client";
import { isUsableDisplayTitle } from "./telegram-client";

export interface IdentityBackfillCounts {
  readonly scanned: number;
  readonly updated: number;
  readonly unresolved: number;
  readonly failed: number;
}

/**
 * Builds a Prisma update that only fills missing identity fields.
 * Always refreshes accessHash/peerType when Telegram provides them.
 */
export function buildIdentityFillUpdate(
  existing: {
    title: string;
    telegramChatId: string;
    username: string | null;
    firstName?: string | null;
    lastName?: string | null;
    chatType: string;
    isBot?: boolean;
    photoMetadata?: unknown;
    rawMetadataJson?: unknown;
    accessHash?: string | null | undefined;
    peerType?: string | null | undefined;
    peerPhone?: string | null | undefined;
  },
  identity: NormalizedDialog
): Prisma.TelegramChatUncheckedUpdateInput {
  const data: Prisma.TelegramChatUncheckedUpdateInput = {};

  if (!isUsableDisplayTitle(existing.title, existing.telegramChatId) && isUsableDisplayTitle(identity.title, identity.telegramChatId)) {
    data.title = identity.title;
  }
  if (!existing.username && identity.username) {
    data.username = identity.username;
  }
  if (!existing.firstName && identity.firstName) {
    data.firstName = identity.firstName;
  }
  if (!existing.lastName && identity.lastName) {
    data.lastName = identity.lastName;
  }
  if (existing.chatType === "UNKNOWN" && identity.chatType !== "UNKNOWN") {
    data.chatType = identity.chatType;
  }
  if (!existing.isBot && identity.isBot) {
    data.isBot = true;
  }

  if (identity.accessHash) {
    data.accessHash = identity.accessHash;
  }
  if (identity.peerType) {
    data.peerType = identity.peerType;
  }
  if (identity.phone) {
    data.peerPhone = identity.phone;
  }

  const photo = extractPhotoMetadata(identity.raw);
  if (!existing.photoMetadata && photo) {
    data.photoMetadata = photo as Prisma.InputJsonValue;
  }

  data.rawMetadataJson = mergeIdentityMetadata(existing.rawMetadataJson, {
    ...identity.raw,
    firstName: identity.firstName,
    lastName: identity.lastName,
    bot: identity.isBot,
    accessHash: identity.accessHash,
    peerType: identity.peerType,
    phone: identity.phone,
    identityResolvedAt: new Date().toISOString(),
    identityResolved: isUsableDisplayTitle(identity.title, identity.telegramChatId)
  });

  return data;
}

/**
 * Returns whether an identity update actually improved usable fields.
 */
export function identityUpdateImproves(
  existing: { title: string; telegramChatId: string; username: string | null; firstName?: string | null; lastName?: string | null },
  data: Prisma.TelegramChatUpdateInput
): "updated" | "unresolved" {
  const nextTitle = typeof data.title === "string" ? data.title : existing.title;
  if (isUsableDisplayTitle(nextTitle, existing.telegramChatId)) {
    return "updated";
  }
  if (data.username || data.firstName || data.lastName) {
    return "updated";
  }
  return "unresolved";
}

export function needsIdentityBackfillRow(chat: {
  title: string;
  telegramChatId: string;
  username: string | null;
  firstName?: string | null;
  lastName?: string | null;
  chatType: string;
  accessHash?: string | null;
}): boolean {
  if (!isUsableDisplayTitle(chat.title, chat.telegramChatId)) return true;
  if (chat.chatType === "UNKNOWN") return true;
  // Private/channel peers need a durable access hash for InputPeer reconstruction.
  if ((chat.chatType === "PRIVATE" || chat.chatType === "CHANNEL" || chat.chatType === "SUPERGROUP") && !chat.accessHash) {
    return true;
  }
  // Private rows should carry name parts or a username when Telegram provides them.
  if (chat.chatType === "PRIVATE" && !chat.firstName && !chat.lastName && !chat.username) {
    return true;
  }
  return false;
}

export function mergeIdentityMetadata(existing: unknown, incoming: Record<string, unknown>): Prisma.InputJsonObject {
  const current = existing && typeof existing === "object" && !Array.isArray(existing) ? (existing as Record<string, unknown>) : {};
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null || value === undefined || value === "") continue;
    const currentValue = merged[key];
    if (currentValue === null || currentValue === undefined || currentValue === "") {
      merged[key] = value;
      continue;
    }
    // Allow refreshing resolution status flags and peer reconstruction fields.
    if (
      key === "identityResolved" ||
      key === "identityResolvedAt" ||
      key === "bot" ||
      key === "accessHash" ||
      key === "peerType" ||
      key === "phone"
    ) {
      merged[key] = value;
    }
  }
  return merged as Prisma.InputJsonObject;
}

function extractPhotoMetadata(raw: Record<string, unknown>): Record<string, unknown> | null {
  if (raw.photo && typeof raw.photo === "object") {
    return { hasPhoto: true };
  }
  return null;
}
