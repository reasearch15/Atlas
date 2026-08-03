import type {
  CrmContactDto,
  StaffContactDto,
  TelegramAccountDto,
  TelegramChatDto,
  TelegramMessageDto,
  TelegramWorkspaceRealtimeEvent
} from "@atlas/shared";
import {
  CUSTOMER_PRIVACY_NOTICE,
  classifyMessageOrigin,
  customerPrivacyCapabilities,
  formatTelegramUserFallbackTitle,
  looksLikeExternalIdentifier,
  neutralContactKindLabel,
  neutralCustomerTypeLabel,
  redactMediaMetadataForPrivacy,
  redactWebPreview,
  stripForbiddenCustomerIdentifierKeys,
  type CustomerPrivacyCapabilities
} from "@atlas/shared";
import type { Role } from "@atlas/shared";

/**
 * Builds a safe display title that never falls back to phone, username, or raw peer id
 * when the viewer lacks the matching permission.
 */
export function composePrivacySafeTitle(input: {
  readonly title: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly username: string | null;
  readonly chatType: string;
  readonly isBot: boolean;
  readonly telegramChatId: string;
  readonly phone?: string | null;
  readonly caps: CustomerPrivacyCapabilities;
}): string {
  const usable = (value: string | null | undefined): string | null => {
    if (!value) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed === input.telegramChatId) return null;
    if (/^-?\d{5,}$/.test(trimmed)) return null;
    if (/^telegram\s+user\s+-?\d+$/i.test(trimmed)) return null;
    if (/^unknown(\s|$)/i.test(trimmed)) return null;
    if (!input.caps.canViewCustomerPhone && looksLikeExternalIdentifier(trimmed)) return null;
    return trimmed;
  };

  if (input.chatType === "GROUP" || input.chatType === "SUPERGROUP" || input.chatType === "CHANNEL") {
    const title = usable(input.title);
    if (title) return title;
    if (input.caps.canViewTelegramUsername && input.username) return input.username;
    return input.chatType === "CHANNEL" ? "Unknown Channel" : "Unknown Group";
  }

  // Private priority: first+last → first → last → username → phone → Telegram user <id> → Unknown
  if (input.firstName && input.lastName) return `${input.firstName} ${input.lastName}`.trim();
  if (input.firstName) return input.firstName;
  if (input.lastName) return input.lastName;
  const title = usable(input.title);
  if (title) return title;
  if (input.caps.canViewTelegramUsername && input.username) return input.username;
  if (input.caps.canViewCustomerPhone && input.phone?.trim()) return input.phone.trim();
  if (input.caps.canViewExternalContactIds && input.telegramChatId?.trim()) {
    return formatTelegramUserFallbackTitle(input.telegramChatId);
  }
  if (input.isBot) return "Unknown Bot";
  return "Unknown User";
}

/**
 * Applies role-based privacy to a fully-built chat DTO (omit, never mask-as-empty).
 */
export function applyChatPrivacy(dto: TelegramChatDto, role: Role): TelegramChatDto {
  const caps = customerPrivacyCapabilities(role);
  const title = composePrivacySafeTitle({
    title: dto.title,
    firstName: dto.firstName,
    lastName: dto.lastName,
    username: dto.username ?? null,
    chatType: dto.chatType,
    isBot: dto.isBot,
    telegramChatId: dto.telegramChatId ?? "",
    phone: dto.phone ?? null,
    caps
  });

  const base: TelegramChatDto = {
    id: dto.id,
    telegramAccountId: dto.telegramAccountId,
    chatType: dto.chatType,
    title,
    firstName: dto.firstName,
    lastName: dto.lastName,
    lastMessagePreview: dto.lastMessagePreview,
    lastMessageAt: dto.lastMessageAt,
    lastMessageDirection: dto.lastMessageDirection,
    unreadCount: dto.unreadCount,
    isPinned: dto.isPinned,
    isBot: dto.isBot,
    identityResolved: Boolean(title && !/^unknown(\s|$)/i.test(title)),
    crmStatus: dto.crmStatus,
    assignedUserId: dto.assignedUserId,
    assignedUserName: dto.assignedUserName,
    assignedAt: dto.assignedAt,
    claimedAt: dto.claimedAt,
    needsCrmAttention: dto.needsCrmAttention,
    tags: dto.tags,
    neutralTypeLabel: neutralCustomerTypeLabel(dto.chatType, dto.isBot)
  };

  const withOptional: TelegramChatDto = {
    ...base,
    ...(caps.canViewExternalContactIds && dto.telegramChatId ? { telegramChatId: dto.telegramChatId } : {}),
    ...(caps.canViewTelegramUsername ? { username: dto.username ?? null } : {}),
    ...(caps.canViewCustomerPhone ? { phone: dto.phone ?? null } : {}),
    ...(!canViewAnyDirectContact(caps) ? { privacyNotice: CUSTOMER_PRIVACY_NOTICE } : {})
  };

  return withOptional;
}

/**
 * Applies role-based privacy to a message DTO.
 */
export function applyMessagePrivacy(dto: TelegramMessageDto, role: Role): TelegramMessageDto {
  const caps = customerPrivacyCapabilities(role);
  const webPreview = redactWebPreview(dto.webPreview, caps);
  const mediaMetadata = redactMediaMetadataForPrivacy(dto.mediaMetadata, caps);

  return {
    id: dto.id,
    telegramAccountId: dto.telegramAccountId,
    chatId: dto.chatId,
    telegramMessageId: dto.telegramMessageId,
    direction: dto.direction,
    contentType: dto.contentType,
    mediaType: dto.mediaType,
    text: dto.text,
    caption: dto.caption,
    mimeType: dto.mimeType,
    fileName: dto.fileName,
    fileSizeBytes: dto.fileSizeBytes,
    width: dto.width,
    height: dto.height,
    durationSeconds: dto.durationSeconds,
    waveform: dto.waveform,
    mediaMetadata,
    mediaUrl: dto.mediaUrl,
    thumbnailUrl: dto.thumbnailUrl,
    mediaDownloadState: dto.mediaDownloadState,
    mediaUploadState: dto.mediaUploadState,
    mediaError: dto.mediaError,
    sentAt: dto.sentAt,
    editedAt: dto.editedAt,
    isEdited: dto.isEdited,
    isDeleted: dto.isDeleted,
    deletedAt: dto.deletedAt ?? null,
    deletionScope: dto.deletionScope ?? null,
    telegramDeleteStatus: dto.telegramDeleteStatus ?? null,
    ...(caps.canViewExternalContactIds ? { senderTelegramUserId: dto.senderTelegramUserId ?? null } : {}),
    senderDisplayName: dto.senderDisplayName,
    replyToTelegramMessageId: dto.replyToTelegramMessageId,
    replyPreview: dto.replyPreview,
    webPreview,
    internalSenderUserId: dto.internalSenderUserId,
    internalSenderSessionId: dto.internalSenderSessionId ?? null,
    internalSenderRole: dto.internalSenderRole ?? null,
    internalSenderName: dto.internalSenderName ?? null,
    attributionSource:
      dto.attributionSource ??
      (dto.direction === "OUTBOUND" ? (dto.internalSenderUserId ? "ATLAS" : "TELEGRAM_EXTERNAL") : null),
    originKind:
      dto.originKind ??
      classifyMessageOrigin({
        direction: dto.direction,
        internalSenderUserId: dto.internalSenderUserId,
        ...(dto.attributionSource !== undefined ? { attributionSource: dto.attributionSource } : {}),
        telegramMessageId: dto.telegramMessageId
      }),
    sendStatus: dto.sendStatus
  };
}

/**
 * Applies role-based privacy to a CRM contact DTO.
 */
export function applyContactPrivacy(dto: CrmContactDto, role: Role): CrmContactDto | StaffContactDto {
  const caps = customerPrivacyCapabilities(role);
  const displayName =
    !caps.canViewCustomerPhone && looksLikeExternalIdentifier(dto.displayName)
      ? "Customer"
      : dto.displayName;

  if (!canViewAnyDirectContact(caps)) {
    const staff: StaffContactDto = {
      id: dto.id,
      kind: neutralContactKindLabel(dto.kind),
      displayName,
      firstSeenAt: dto.firstSeenAt,
      lastSeenAt: dto.lastSeenAt,
      conversationCount: dto.conversationCount,
      privacyNotice: CUSTOMER_PRIVACY_NOTICE
    };
    return staff;
  }

  return {
    id: dto.id,
    kind: dto.kind,
    displayName,
    ...(caps.canViewTelegramUsername ? { username: dto.username ?? null } : {}),
    ...(caps.canViewCustomerPhone ? { phoneMasked: dto.phoneMasked ?? null } : {}),
    firstSeenAt: dto.firstSeenAt,
    lastSeenAt: dto.lastSeenAt,
    conversationCount: dto.conversationCount
  };
}

/**
 * Applies role-based privacy to a workspace Telegram account DTO.
 */
export function applyAccountPrivacy(dto: TelegramAccountDto, role: Role): TelegramAccountDto {
  const caps = customerPrivacyCapabilities(role);
  return {
    id: dto.id,
    workspaceId: dto.workspaceId,
    developerAppId: dto.developerAppId,
    displayName: dto.displayName,
    ...(caps.canViewCustomerPhone ? { maskedPhoneNumber: dto.maskedPhoneNumber ?? null } : {}),
    ...(caps.canViewExternalContactIds ? { telegramUserId: dto.telegramUserId ?? null } : {}),
    ...(caps.canViewTelegramUsername ? { telegramUsername: dto.telegramUsername ?? null } : {}),
    status: dto.status,
    authorizationState: dto.authorizationState,
    syncState: dto.syncState,
    lastConnectedAt: dto.lastConnectedAt,
    lastUpdateAt: dto.lastUpdateAt,
    lastErrorCode: dto.lastErrorCode,
    lastErrorMessage: dto.lastErrorMessage,
    createdAt: dto.createdAt
  };
}

/**
 * Redacts CRM activity payloads for the viewer role.
 */
export function applyActivityPayloadPrivacy(
  payload: Record<string, unknown>,
  role: Role
): Record<string, unknown> {
  const caps = customerPrivacyCapabilities(role);
  if (canViewAnyDirectContact(caps)) return payload;
  return stripForbiddenCustomerIdentifierKeys(payload);
}

/**
 * Applies role privacy to a workspace realtime event before fan-out to a socket.
 */
export function applyRealtimeEventPrivacy(
  event: TelegramWorkspaceRealtimeEvent,
  role: Role
): TelegramWorkspaceRealtimeEvent {
  if (event.type === "telegram.message.created" || event.type === "telegram.message.updated") {
    return {
      ...event,
      message: applyMessagePrivacy(event.message, role)
    };
  }
  if (event.type === "telegram.message.deleted") {
    // Deletion payloads carry no message body — pass through as-is.
    return event;
  }
  if (event.type === "telegram_message.attribution_updated") {
    return {
      ...event,
      message: applyMessagePrivacy(event.message, role)
    };
  }
  if (event.type === "telegram.chat.updated") {
    const caps = customerPrivacyCapabilities(role);
    if (canViewAnyDirectContact(caps)) return event;
    const { username: _u, phone: _p, telegramChatId: peerId, ...rest } = event;
    return {
      ...rest,
      username: null,
      phone: null,
      ...(caps.canViewExternalContactIds && peerId ? { telegramChatId: peerId } : {}),
      title: composePrivacySafeTitle({
        title: event.title ?? "Unknown User",
        username: event.username ?? null,
        phone: event.phone ?? null,
        telegramChatId: event.telegramChatId ?? "",
        firstName: event.firstName ?? null,
        lastName: event.lastName ?? null,
        chatType: event.chatType ?? "PRIVATE",
        isBot: event.isBot ?? false,
        caps
      })
    };
  }
  // Internal team messages contain operator names only — no customer identifiers.
  return event;
}

function canViewAnyDirectContact(caps: CustomerPrivacyCapabilities): boolean {
  return (
    caps.canViewCustomerPhone ||
    caps.canViewTelegramUsername ||
    caps.canViewExternalContactIds ||
    caps.canViewCustomerEmail
  );
}
