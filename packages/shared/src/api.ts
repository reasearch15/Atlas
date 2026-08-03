import type { AuthUser, SessionDto } from "./schemas";

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
  };
}

export interface AuthResponse {
  readonly user: AuthUser;
  readonly accessToken: string;
}

export interface AdminLoginChallengeResponse {
  readonly requiresVerification: true;
  readonly challengeId: string;
  readonly maskedEmail: string;
  readonly expiresAt: string;
  readonly resendAvailableAt: string;
}

export type AdminLoginResponse = AuthResponse | AdminLoginChallengeResponse;

export type CoadminLoginResponse = AuthResponse | AdminLoginChallengeResponse;

export interface PasswordChangeRequiredResponse {
  readonly requiresPasswordChange: true;
  readonly changeToken: string;
  readonly user: AuthUser;
}

export type TenantLoginResponse = AuthResponse | PasswordChangeRequiredResponse;

export interface AdminTrustedDeviceDto {
  readonly id: string;
  readonly displayName: string;
  readonly browser: string;
  readonly operatingSystem: string;
  readonly firstIp: string;
  readonly lastIp: string;
  readonly firstTrustedAt: string;
  readonly lastUsedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly isCurrent: boolean;
}

export type CoadminStatus = "ACTIVE" | "INVITED" | "SUSPENDED" | "ARCHIVED" | "DISABLED";
export type TenantUserStatus = "ACTIVE" | "PENDING_PASSWORD_CHANGE" | "SUSPENDED" | "ARCHIVED" | "DISABLED";
export type WorkspaceStatus = "ACTIVE" | "SUSPENDED" | "ARCHIVED";

export interface AdminCoadminListItem {
  readonly id: string;
  readonly name: string;
  readonly username: string;
  readonly contactEmail: string | null;
  readonly status: TenantUserStatus;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceSlug: string;
  readonly workspaceStatus: WorkspaceStatus;
  readonly mustChangePassword: boolean;
  readonly createdAt: string;
}

export interface AdminCoadminDetail extends AdminCoadminListItem {
  readonly lastLoginAt: string | null;
  readonly activeSessions: number;
  readonly trustedDevices: number;
  readonly staffCount: number;
  readonly telegramAccountCount: number;
  readonly developerAppCount: number;
  readonly recentAuditEvents: readonly {
    readonly id: string;
    readonly action: string;
    readonly createdAt: string;
    readonly ipAddress: string | null;
  }[];
  readonly lastTemporaryPasswordIssuedAt: string | null;
  readonly sessions: readonly SessionDto[];
}

export interface StaffListItem {
  readonly id: string;
  readonly name: string;
  readonly username: string;
  readonly contactEmail: string | null;
  readonly status: TenantUserStatus;
  readonly mustChangePassword: boolean;
  readonly createdAt: string;
  readonly lastActiveAt?: string | null;
  readonly internalUnreadCount?: number;
  readonly lastInternalMessagePreview?: string | null;
  readonly lastInternalMessageAt?: string | null;
}

export interface StaffDetail extends StaffListItem {
  readonly activeSessions: number;
  readonly trustedDevices: number;
  readonly lastTemporaryPasswordIssuedAt: string | null;
  readonly sessions: readonly SessionDto[];
}

export interface CoadminDashboardResponse {
  readonly workspace: {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly status: WorkspaceStatus;
  };
  readonly coadmin: {
    readonly id: string;
    readonly name: string;
    readonly username: string;
    readonly contactEmail: string | null;
  };
  readonly counts: {
    readonly staff: number;
    readonly telegramAccounts: number;
    readonly developerApps: number;
    readonly unclaimedConversations: number | null;
    readonly activeSessions: number;
    readonly trustedDevices: number;
  };
}

export type AdminHealthStatus = "HEALTHY" | "DEGRADED" | "UNAVAILABLE";

export interface AdminDashboardResponse {
  readonly counts: {
    readonly coadmins: number;
    readonly workspaces: number;
    readonly staff: number;
    readonly telegramAccounts: number;
    readonly unclaimedConversations: number | null;
  };
  readonly security: {
    readonly activeSessions: number;
    readonly trustedDevices: number;
    readonly lastLoginAt: string | null;
    readonly recentFailedLogins: number;
  };
  readonly health: {
    readonly backend: AdminHealthStatus;
    readonly database: AdminHealthStatus;
    readonly redis: AdminHealthStatus;
    readonly storage: AdminHealthStatus;
    readonly telegramWorker: AdminHealthStatus;
  };
  readonly recentCoadmins: readonly {
    readonly id: string;
    readonly name: string;
    readonly email: string;
    readonly workspaceName: string | null;
    readonly status: string;
    readonly createdAt: string;
  }[];
  readonly recentAuditEvents: readonly {
    readonly id: string;
    readonly action: string;
    readonly actorEmail: string;
    readonly createdAt: string;
    readonly ipAddress: string | null;
    readonly status: string | null;
  }[];
}

export interface MeResponse {
  readonly user: AuthUser;
  readonly sessions: readonly SessionDto[];
}

export interface DashboardStats {
  readonly workspaceCount: number;
  readonly staffCount: number;
  readonly activeSessionCount: number;
  readonly auditEventCount: number;
}

export interface AuditLogDto {
  readonly id: string;
  readonly action: string;
  readonly actorEmail: string;
  readonly workspaceId: string | null;
  readonly createdAt: string;
  readonly metadata: Record<string, unknown>;
}

export interface DeveloperAppDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly provider: "TELEGRAM";
  readonly displayName: string;
  readonly apiId: number;
  readonly status: "ACTIVE" | "DISABLED";
  readonly connectedTelegramAccountCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TelegramAccountDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly developerAppId: string;
  readonly displayName: string;
  /** Workspace account phone — omitted for Staff. */
  readonly maskedPhoneNumber?: string | null;
  /** Workspace account Telegram user id — omitted for Staff. */
  readonly telegramUserId?: string | null;
  /** Workspace account username — omitted for Staff. */
  readonly telegramUsername?: string | null;
  readonly status: string;
  readonly authorizationState: string;
  readonly syncState: string;
  readonly lastConnectedAt: string | null;
  readonly lastUpdateAt: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly createdAt: string;
}

export interface TelegramChatDto {
  readonly id: string;
  readonly telegramAccountId: string;
  /**
   * External Telegram peer id. Omitted entirely for Staff without
   * `customer:external-ids:view`.
   */
  readonly telegramChatId?: string;
  readonly chatType: string;
  readonly title: string;
  /** Omitted for Staff without `customer:telegram-username:view`. */
  readonly username?: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  /** Omitted for Staff without `customer:phone:view`. */
  readonly phone?: string | null;
  readonly lastMessagePreview: string | null;
  readonly lastMessageAt: string | null;
  readonly lastMessageDirection: "INBOUND" | "OUTBOUND" | null;
  readonly unreadCount: number;
  readonly isPinned: boolean;
  readonly isBot: boolean;
  readonly identityResolved: boolean;
  readonly crmStatus: "NEW" | "OPEN" | "WAITING" | "RESOLVED" | "CLOSED";
  readonly assignedUserId: string | null;
  readonly assignedUserName: string | null;
  readonly assignedAt: string | null;
  readonly claimedAt: string | null;
  readonly needsCrmAttention: boolean;
  readonly tags: readonly CrmTagDto[];
  /** Present when direct contact fields were withheld. */
  readonly privacyNotice?: string | null;
  /** Neutral type label for Staff (Customer / Group / Channel). */
  readonly neutralTypeLabel?: string;
}

/** Privileged contact payload for Coadmin / Platform Admin. */
export interface CoadminContactDto {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;
  readonly username: string | null;
  readonly phoneMasked: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly conversationCount: number;
}

/** Privileged contact payload for Platform Admin (same fields as Coadmin today). */
export type AdminContactDto = CoadminContactDto;

/**
 * Staff-safe contact payload — no phone, username, or external identifiers.
 */
export interface StaffContactDto {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly conversationCount: number;
  readonly privacyNotice: string;
}

/**
 * Role-aware CRM contact DTO. Sensitive fields are omitted (not null) for Staff.
 */
export interface CrmContactDto {
  readonly id: string;
  readonly kind: string;
  readonly displayName: string;
  readonly username?: string | null;
  readonly phoneMasked?: string | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly conversationCount: number;
  readonly privacyNotice?: string | null;
}

export interface CrmTagDto {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly archivedAt: string | null;
}

export interface CrmAssigneeDto {
  readonly id: string;
  readonly name: string;
  readonly role: "COADMIN" | "STAFF";
}

export interface CrmNoteDto {
  readonly id: string;
  readonly chatId: string;
  readonly body: string;
  readonly authorUserId: string;
  readonly authorName: string;
  readonly createdAt: string;
  readonly editedAt: string | null;
}

export interface CrmActivityDto {
  readonly id: string;
  readonly chatId: string;
  readonly type: string;
  readonly actorUserId: string | null;
  readonly actorName: string | null;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export interface CrmConversationPanelDto {
  readonly chatId: string;
  readonly contact: CrmContactDto | null;
  readonly telegramAccountLabel: string;
  readonly chatType: string;
  readonly crmStatus: string;
  readonly assignee: CrmAssigneeDto | null;
  readonly tags: readonly CrmTagDto[];
  readonly notes: readonly CrmNoteDto[];
  readonly activities: readonly CrmActivityDto[];
  readonly unreadCount: number;
  readonly needsCrmAttention: boolean;
  readonly lastMessageAt: string | null;
  readonly firstSeenAt: string | null;
  readonly privacyNotice?: string | null;
}

export interface CrmInboxCountsDto {
  readonly all: number;
  readonly unassigned: number;
  readonly mine: number;
  readonly new: number;
  readonly open: number;
  readonly waiting: number;
  readonly unread: number;
  readonly resolved: number;
}

export interface TelegramChatIdentityBackfillResult {
  readonly scanned: number;
  readonly updated: number;
  readonly unresolved: number;
  readonly failed: number;
  readonly accountId: string;
  readonly completedAt: string;
}

export type TelegramMessageContentTypeDto =
  | "TEXT"
  | "PHOTO"
  | "VIDEO"
  | "VIDEO_NOTE"
  | "VOICE"
  | "AUDIO"
  | "DOCUMENT"
  | "ANIMATION"
  | "STICKER"
  | "CONTACT"
  | "LOCATION"
  | "LIVE_LOCATION"
  | "POLL"
  | "DICE"
  | "OTHER";

export type TelegramMessageMediaTypeDto =
  | "TEXT"
  | "PHOTO"
  | "VIDEO"
  | "VIDEO_NOTE"
  | "DOCUMENT"
  | "VOICE"
  | "LOCATION"
  | "AUDIO"
  | "CONTACT"
  | "STICKER"
  | "ANIMATION"
  | "POLL"
  | "DICE";

export type TelegramMediaDownloadStateDto =
  | "NONE"
  | "PENDING"
  | "DOWNLOADING"
  | "STORED"
  | "FAILED"
  | "SKIPPED"
  | "UNAVAILABLE";

export interface TelegramMessageDto {
  readonly id: string;
  readonly telegramAccountId: string;
  readonly chatId: string;
  readonly telegramMessageId: string;
  readonly direction: "INBOUND" | "OUTBOUND";
  readonly contentType: TelegramMessageContentTypeDto;
  readonly mediaType: TelegramMessageMediaTypeDto;
  readonly text: string;
  readonly caption: string | null;
  readonly mimeType: string | null;
  readonly fileName: string | null;
  readonly fileSizeBytes: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSeconds: number | null;
  readonly waveform: number[] | null;
  readonly mediaMetadata: Record<string, unknown> | null;
  readonly mediaUrl: string | null;
  readonly thumbnailUrl: string | null;
  readonly mediaDownloadState: TelegramMediaDownloadStateDto;
  readonly mediaUploadState: TelegramMediaDownloadStateDto;
  readonly mediaError: string | null;
  readonly sentAt: string;
  readonly editedAt: string | null;
  readonly isEdited: boolean;
  readonly isDeleted: boolean;
  readonly senderTelegramUserId?: string | null;
  readonly senderDisplayName: string | null;
  readonly replyToTelegramMessageId: string | null;
  readonly replyPreview: string | null;
  readonly webPreview: { readonly url: string; readonly title: string | null; readonly description: string | null } | null;
  readonly internalSenderUserId: string | null;
  readonly internalSenderSessionId?: string | null;
  readonly internalSenderRole?: "COADMIN" | "STAFF" | "PLATFORM_ADMIN" | null;
  readonly internalSenderName?: string | null;
  /** ATLAS = sent through Atlas; TELEGRAM_EXTERNAL = outbound with no Atlas sender. */
  readonly attributionSource?: "ATLAS" | "TELEGRAM_EXTERNAL" | null;
  readonly sendStatus: string;
}

export interface TelegramMessageCreatedEvent {
  readonly type: "telegram.message.created";
  readonly eventId: string;
  readonly workspaceId: string;
  readonly telegramAccountId: string;
  /** Database chat id (same as message.chatId). */
  readonly chatId: string;
  /** Alias for chatId — conversation pane matches on this. */
  readonly chatDbId: string;
  readonly message: TelegramMessageDto;
}

export interface TelegramMessageUpdatedEvent {
  readonly type: "telegram.message.updated";
  readonly eventId: string;
  readonly workspaceId: string;
  readonly telegramAccountId: string;
  readonly chatId: string;
  readonly chatDbId: string;
  readonly message: TelegramMessageDto;
}

export interface TelegramChatUpdatedEvent {
  readonly type: "telegram.chat.updated";
  readonly eventId: string;
  readonly workspaceId: string;
  readonly telegramAccountId: string;
  readonly chatId: string;
  readonly lastMessagePreview: string | null;
  readonly lastMessageAt: string | null;
  readonly lastMessageDirection: "INBOUND" | "OUTBOUND" | null;
  readonly unreadCount: number;
  /** Optional identity / CRM fields — same shape fragments as REST TelegramChatDto. */
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
}

export interface CrmConversationUpdatedEvent {
  readonly type: "crm.conversation.updated";
  readonly eventId: string;
  readonly workspaceId: string;
  readonly chatId: string;
  readonly crmStatus: "NEW" | "OPEN" | "WAITING" | "RESOLVED" | "CLOSED";
  readonly assignedUserId: string | null;
  readonly assignedUserName: string | null;
  readonly assignedAt: string | null;
  readonly claimedAt: string | null;
  readonly needsCrmAttention: boolean;
  readonly tags: readonly CrmTagDto[];
  readonly reason: string;
}

export type TelegramWorkspaceRealtimeEvent =
  | TelegramMessageCreatedEvent
  | TelegramMessageUpdatedEvent
  | TelegramChatUpdatedEvent
  | CrmConversationUpdatedEvent
  | InternalMessageCreatedEvent
  | InternalMessageReadEvent
  | StaffInternalUnreadCountUpdatedEvent
  | TelegramMessageAttributionUpdatedEvent
  | TelegramAccountDeletionStartedEvent
  | TelegramAccountDeletedEvent
  | ConversationsDeletedEvent;

export interface TelegramAccountDeletionStartedEvent {
  readonly type: "telegram_account.deletion_started";
  readonly eventId: string;
  readonly workspaceId: string;
  readonly telegramAccountId: string;
  readonly safeDisplayName: string;
}

export interface TelegramAccountDeletedEvent {
  readonly type: "telegram_account.deleted";
  readonly eventId: string;
  readonly workspaceId: string;
  readonly telegramAccountId: string;
  readonly safeDisplayName: string;
  readonly conversationCount: number;
  readonly messageCount: number;
  readonly mediaCount: number;
}

export interface ConversationsDeletedEvent {
  readonly type: "conversations.deleted";
  readonly eventId: string;
  readonly workspaceId: string;
  readonly telegramAccountId: string;
  readonly chatIds: readonly string[];
}

export interface TelegramAccountPermanentDeleteResponse {
  readonly telegramAccountId: string;
  readonly safeDisplayName: string;
  readonly conversationCount: number;
  readonly messageCount: number;
  readonly mediaCount: number;
  readonly outcome: "COMPLETED" | "ALREADY_DELETED";
  readonly developerAppId: string;
}

export interface InternalMessageDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly staffUserId: string;
  readonly senderUserId: string;
  readonly senderName: string;
  readonly senderRole: "COADMIN" | "STAFF";
  readonly receiverUserId: string;
  readonly body: string;
  readonly createdAt: string;
  readonly readAt: string | null;
  readonly editedAt: string | null;
  readonly channel: "INTERNAL_TEAM";
  readonly label: "Internal Team Message";
}

export interface InternalMessageThreadDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly staffUserId: string;
  readonly staffName: string;
  readonly staffUsername: string;
  readonly lastMessageAt: string | null;
  readonly lastMessagePreview: string | null;
  readonly unreadCount: number;
  readonly staffLastActiveAt: string | null;
}

export interface InternalMessageCreatedEvent {
  readonly type: "internal_message.created";
  readonly eventId: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly staffUserId: string;
  readonly message: InternalMessageDto;
}

export interface InternalMessageReadEvent {
  readonly type: "internal_message.read";
  readonly eventId: string;
  readonly workspaceId: string;
  readonly threadId: string;
  readonly staffUserId: string;
  readonly messageId: string;
  readonly readAt: string;
  readonly readerUserId: string;
}

export interface StaffInternalUnreadCountUpdatedEvent {
  readonly type: "staff_internal_unread_count.updated";
  readonly eventId: string;
  readonly workspaceId: string;
  readonly staffUserId: string;
  readonly unreadCount: number;
}

export interface TelegramMessageAttributionUpdatedEvent {
  readonly type: "telegram_message.attribution_updated";
  readonly eventId: string;
  readonly workspaceId: string;
  readonly chatId: string;
  readonly message: TelegramMessageDto;
}

export interface TelegramMediaBackfillResult {
  readonly scanned: number;
  readonly downloaded: number;
  readonly uploaded: number;
  readonly skipped: number;
  readonly failed: number;
  readonly accountId: string;
  readonly completedAt: string;
}

export interface TelegramQueueHealthDto {
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly failed: number;
}
