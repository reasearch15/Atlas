import { z } from "zod";

/** Supported push platforms (extensible for iOS / desktop browsers). */
export const pushPlatforms = ["ANDROID", "WEB", "IOS"] as const;
export type PushPlatform = (typeof pushPlatforms)[number];

/** Notification event kinds handled by the platform notification service. */
export const notificationTypes = [
  "INCOMING_MESSAGE",
  "NEW_CONVERSATION",
  "CONVERSATION_ASSIGNED",
  "CONVERSATION_REASSIGNED",
  "MENTION",
  "CONVERSATION_REOPENED",
  "URGENT_FLAG",
  "SLA_WARNING",
  "FAILED_MESSAGE",
  "TEST"
] as const;
export type NotificationType = (typeof notificationTypes)[number];

export const notificationPriorities = ["HIGH", "DEFAULT", "LOW"] as const;
export type NotificationPriority = (typeof notificationPriorities)[number];

/**
 * Durable delivery lifecycle. Source of truth lives in Postgres so backend
 * restarts never lose pending customer-message notifications.
 */
export const notificationDeliveryStatuses = [
  "QUEUED",
  "DISPATCHING",
  "SENT",
  "DELIVERED",
  "OPENED",
  "DISMISSED",
  "FAILED",
  "RETRY_SCHEDULED",
  "EXPIRED",
  "CANCELLED",
  "SKIPPED",
  "INVALID_TOKEN"
] as const;
export type NotificationDeliveryStatus = (typeof notificationDeliveryStatuses)[number];

export const notificationAckEvents = ["delivered", "opened", "dismissed"] as const;
export type NotificationAckEvent = (typeof notificationAckEvents)[number];

export const notificationActions = ["open", "mark_read", "claim"] as const;
export type NotificationAction = (typeof notificationActions)[number];

/** Exponential backoff: 30s → 2m → 5m → 15m → 30m → 1h (then hold at 1h until expiry). */
export const NOTIFICATION_RETRY_DELAYS_MS = [
  30_000,
  120_000,
  300_000,
  900_000,
  1_800_000,
  3_600_000
] as const;

/**
 * Delay before the next retry attempt (1-based attempt count after a failure).
 */
export function nextNotificationRetryDelayMs(attemptAfterFailure: number): number {
  const index = Math.max(0, Math.min(attemptAfterFailure - 1, NOTIFICATION_RETRY_DELAYS_MS.length - 1));
  return NOTIFICATION_RETRY_DELAYS_MS[index]!;
}

/**
 * Builds a globally unique Android/Web notification tag that never collapses.
 */
export function buildUniqueNotificationTag(notificationId: string): string {
  return `atlas-n-${notificationId}`;
}

/**
 * Idempotency key for one device delivery of one domain event.
 */
export function buildNotificationIdempotencyKey(input: {
  readonly type: NotificationType;
  readonly eventKey: string;
  readonly userId: string;
  readonly deviceTokenId: string | null;
}): string {
  return `${input.type}:${input.eventKey}:${input.userId}:${input.deviceTokenId ?? "pending-device"}`;
}

export const registerPushDeviceSchema = z.object({
  token: z.string().min(20).max(4096),
  platform: z.enum(pushPlatforms),
  deviceName: z.string().trim().min(1).max(160).optional(),
  appVersion: z.string().trim().max(64).optional()
});
export type RegisterPushDeviceInput = z.infer<typeof registerPushDeviceSchema>;

export const refreshPushDeviceSchema = z.object({
  previousToken: z.string().min(20).max(4096).optional(),
  token: z.string().min(20).max(4096),
  platform: z.enum(pushPlatforms),
  deviceName: z.string().trim().min(1).max(160).optional(),
  appVersion: z.string().trim().max(64).optional()
});
export type RefreshPushDeviceInput = z.infer<typeof refreshPushDeviceSchema>;

export const deletePushDeviceSchema = z.object({
  token: z.string().min(20).max(4096)
});
export type DeletePushDeviceInput = z.infer<typeof deletePushDeviceSchema>;

export const notificationPreferencesSchema = z.object({
  enabled: z.boolean(),
  customerMessages: z.boolean(),
  assignments: z.boolean(),
  mentions: z.boolean(),
  urgentOnly: z.boolean(),
  sound: z.boolean(),
  vibration: z.boolean(),
  previewText: z.boolean(),
  showCustomerNames: z.boolean(),
  muteAll: z.boolean(),
  doNotDisturb: z
    .object({
      enabled: z.boolean().default(false),
      timezone: z.string().max(64).optional(),
      windows: z
        .array(
          z.object({
            days: z.array(z.number().int().min(0).max(6)).min(1),
            start: z.string().regex(/^\d{2}:\d{2}$/),
            end: z.string().regex(/^\d{2}:\d{2}$/)
          })
        )
        .max(14)
        .optional()
    })
    .nullable()
    .optional()
});
export type NotificationPreferencesInput = z.infer<typeof notificationPreferencesSchema>;

export type NotificationPreferencesDto = {
  readonly enabled: boolean;
  readonly customerMessages: boolean;
  readonly assignments: boolean;
  readonly mentions: boolean;
  readonly urgentOnly: boolean;
  readonly sound: boolean;
  readonly vibration: boolean;
  readonly previewText: boolean;
  readonly showCustomerNames: boolean;
  readonly muteAll: boolean;
  readonly doNotDisturb: NotificationPreferencesInput["doNotDisturb"] | null;
};

export type PushDeviceDto = {
  readonly id: string;
  readonly platform: PushPlatform;
  readonly deviceName: string | null;
  readonly appVersion: string | null;
  readonly lastSeenAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSuccessfulDeliveryAt: string | null;
  readonly lastFailedDeliveryAt: string | null;
};

export type NotificationWebConfigDto = {
  readonly enabled: boolean;
  readonly apiKey: string | null;
  readonly authDomain: string | null;
  readonly projectId: string | null;
  readonly messagingSenderId: string | null;
  readonly appId: string | null;
  readonly vapidKey: string | null;
};

export type NotificationHistoryItemDto = {
  readonly id: string;
  readonly type: NotificationType;
  readonly status: NotificationDeliveryStatus;
  readonly title: string;
  readonly body: string;
  readonly customerName: string | null;
  readonly chatId: string | null;
  readonly messageId: string | null;
  readonly workspaceId: string;
  readonly deepLinkPath: string;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly sentAt: string | null;
  readonly deliveredAt: string | null;
  readonly openedAt: string | null;
  readonly dismissedAt: string | null;
  readonly failedAt: string | null;
  readonly expiresAt: string;
  readonly lastErrorCode: string | null;
};

export type NotificationReconcileResultDto = {
  readonly unreadBadge: number;
  readonly pendingNotifications: number;
  readonly requeued: number;
  readonly historyUnread: number;
};

export type NotificationAnalyticsDto = {
  readonly windowHours: number;
  readonly created: number;
  readonly sent: number;
  readonly delivered: number;
  readonly opened: number;
  readonly failed: number;
  readonly retried: number;
  readonly expired: number;
  readonly failureRate: number;
  readonly openRate: number;
  readonly retrySuccessRate: number;
  readonly avgDeliveryLatencyMs: number | null;
  readonly avgOpenLatencyMs: number | null;
};

export const notificationAckSchema = z.object({
  event: z.enum(notificationAckEvents)
});
export type NotificationAckInput = z.infer<typeof notificationAckSchema>;

export const notificationActionSchema = z.object({
  action: z.enum(notificationActions)
});
export type NotificationActionInput = z.infer<typeof notificationActionSchema>;

export const notificationHistoryQuerySchema = z.object({
  status: z.enum(["unread", "read", "dismissed", "failed", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional()
});

export type NotificationDeepLinkPayload = {
  readonly workspaceId: string;
  readonly chatId: string;
  readonly messageId?: string | null;
  readonly notificationId?: string | null;
  readonly rolePath: "staff" | "workspace";
  readonly highlightUnread?: boolean;
};

/**
 * Builds the in-app deep link path for a conversation notification.
 * Never lands on dashboard — always opens Inbox → exact conversation.
 */
export function buildNotificationDeepLinkPath(payload: NotificationDeepLinkPayload): string {
  const base = payload.rolePath === "staff" ? "/staff/inbox" : "/workspace/inbox";
  const params = new URLSearchParams({ from: "push" });
  if (payload.messageId) params.set("messageId", payload.messageId);
  if (payload.notificationId) params.set("notificationId", payload.notificationId);
  if (payload.highlightUnread !== false) params.set("highlight", "1");
  return `${base}/${payload.chatId}?${params.toString()}`;
}

/**
 * Truncates preview text to maxLen without cutting mid-word when possible.
 */
export function truncateNotificationPreview(text: string, maxLen = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  const slice = normalized.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace >= Math.floor(maxLen * 0.6)) {
    return `${slice.slice(0, lastSpace).trimEnd()}…`;
  }
  return `${slice.trimEnd()}…`;
}

/**
 * Default FCM / Android priority for a notification type.
 */
export function notificationPriorityForType(type: NotificationType): NotificationPriority {
  switch (type) {
    case "INCOMING_MESSAGE":
    case "NEW_CONVERSATION":
    case "URGENT_FLAG":
    case "FAILED_MESSAGE":
    case "MENTION":
      return "HIGH";
    case "CONVERSATION_ASSIGNED":
    case "CONVERSATION_REASSIGNED":
    case "CONVERSATION_REOPENED":
    case "TEST":
      return "DEFAULT";
    case "SLA_WARNING":
      return "LOW";
    default:
      return "DEFAULT";
  }
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferencesDto = {
  enabled: true,
  customerMessages: true,
  assignments: true,
  mentions: true,
  urgentOnly: false,
  sound: true,
  vibration: true,
  previewText: true,
  showCustomerNames: true,
  muteAll: false,
  doNotDisturb: null
};

/** Terminal statuses that should not be retried. */
export const NOTIFICATION_TERMINAL_STATUSES: readonly NotificationDeliveryStatus[] = [
  "SENT",
  "DELIVERED",
  "OPENED",
  "DISMISSED",
  "EXPIRED",
  "CANCELLED",
  "SKIPPED",
  "INVALID_TOKEN"
];

export function isNotificationPendingStatus(status: NotificationDeliveryStatus): boolean {
  return status === "QUEUED" || status === "DISPATCHING" || status === "RETRY_SCHEDULED" || status === "FAILED";
}
