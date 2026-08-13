import type {
  NotificationPriority,
  NotificationType,
  PushPlatform
} from "@atlas/shared";

/**
 * BullMQ wake-up payload. Durable state lives in `push_notifications`.
 */
export type PushNotificationJob = {
  readonly notificationId: string;
};

/**
 * High-level notify request used by integrations (Telegram today, future channels later).
 */
export type NotifyIncomingMessageInput = {
  readonly workspaceId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly customerName: string;
  readonly preview: string;
  readonly sentAt: string;
  readonly imageUrl?: string | null;
  readonly isFirstMessage?: boolean;
  readonly isUrgent?: boolean;
  /** Event id from Redis/webhook for dedupe across duplicate deliveries. */
  readonly eventId?: string;
  readonly channel?: string;
};

export type NotifyAssignmentInput = {
  readonly workspaceId: string;
  readonly chatId: string;
  readonly assigneeUserId: string;
  readonly actorUserId: string;
  readonly customerName: string;
  readonly reassigned: boolean;
  readonly eventId?: string;
};

export type NotifyConversationReopenedInput = {
  readonly workspaceId: string;
  readonly chatId: string;
  readonly customerName: string;
  readonly recipientUserIds?: readonly string[];
  readonly eventId?: string;
};

export type NotifyFailedMessageInput = {
  readonly workspaceId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly recipientUserId: string;
  readonly customerName: string;
  readonly preview: string;
  readonly eventId?: string;
};

export type NotifyUrgentFlagInput = {
  readonly workspaceId: string;
  readonly chatId: string;
  readonly customerName: string;
  readonly recipientUserIds?: readonly string[];
  readonly eventId?: string;
};

export type NotifyIncomingCallInput = {
  readonly workspaceId: string;
  readonly telegramAccountId: string;
  readonly callId: string;
  readonly callerTelegramUserId: string;
  readonly callerName: string | null;
  readonly callerUsername: string | null;
  readonly video: boolean;
  readonly timestamp: string;
  readonly chatId?: string | null;
  /** Stable dedupe key — typically `call:{telegramAccountId}:{callId}`. */
  readonly eventId: string;
};

export type NotifyTestInput = {
  readonly workspaceId: string;
  readonly userId: string;
  readonly deviceTokenId?: string;
};

export type DeviceTokenRecord = {
  readonly id: string;
  readonly userId: string;
  readonly workspaceId: string;
  readonly platform: PushPlatform;
  readonly token: string;
};

export type EnqueuePushNotificationInput = {
  readonly workspaceId: string;
  readonly userId: string;
  readonly deviceTokenId: string | null;
  readonly type: NotificationType;
  readonly priority: NotificationPriority;
  readonly idempotencyKey: string;
  readonly title: string;
  readonly body: string;
  readonly customerName: string | null;
  readonly chatId: string | null;
  readonly messageId: string | null;
  readonly deepLinkPath: string;
  readonly imageUrl: string | null;
  readonly badgeCount: number | null;
  readonly sound: boolean;
  readonly vibration: boolean;
  readonly sentAt: string;
};
