import {
  buildUniqueNotificationTag,
  nextNotificationRetryDelayMs,
  type NotificationPriority
} from "@atlas/shared";
import type { FastifyBaseLogger } from "fastify";
import type { Env } from "../../config/env";
import { isFcmConfigured } from "./fcm.config";
import { getFirebaseMessaging } from "./firebase-admin.client";

export type FcmSendResult =
  | { readonly ok: true; readonly messageId: string }
  | { readonly ok: false; readonly invalidToken: boolean; readonly retryable: boolean; readonly code: string; readonly message: string };

export type DispatchableNotification = {
  readonly id: string;
  readonly type: string;
  readonly priority: NotificationPriority | string;
  readonly title: string;
  readonly body: string;
  readonly workspaceId: string;
  readonly chatId: string | null;
  readonly messageId: string | null;
  readonly deepLinkPath: string;
  readonly imageUrl: string | null;
  readonly badgeCount: number | null;
  readonly sound: boolean;
  readonly vibration: boolean;
  readonly createdAt: Date;
};

/**
 * Thin Firebase Cloud Messaging sender. Lazily initializes firebase-admin.
 * Never groups/collapses notifications — each job is an independent delivery.
 */
export class NotificationDispatcher {
  private readonly env: Env;
  private readonly log: FastifyBaseLogger;

  public constructor(env: Env, log: FastifyBaseLogger) {
    this.env = env;
    this.log = log.child({ module: "notification-dispatcher" });
  }

  public isReady(): boolean {
    return isFcmConfigured(this.env);
  }

  public async send(notification: DispatchableNotification, token: string): Promise<FcmSendResult> {
    const messagingResult = await getFirebaseMessaging(this.env);
    if (messagingResult.status === "not_configured") {
      return {
        ok: false,
        invalidToken: false,
        retryable: true,
        code: "FCM_NOT_CONFIGURED",
        message: "FCM is not configured — will retry until enabled or expired"
      };
    }
    if (messagingResult.status === "init_failed") {
      const message =
        messagingResult.error instanceof Error
          ? messagingResult.error.message
          : String(messagingResult.error);
      this.log.error({ error: messagingResult.error }, "Failed to initialize Firebase Admin");
      return {
        ok: false,
        invalidToken: false,
        retryable: true,
        code: "FCM_INIT_FAILED",
        message: message.slice(0, 500)
      };
    }
    const messaging = messagingResult.messaging;

    const androidPriority = notification.priority === "HIGH" ? "high" : "normal";
    const urgency = notification.priority === "HIGH" ? "high" : notification.priority === "LOW" ? "low" : "normal";
    const uniqueTag = buildUniqueNotificationTag(notification.id);
    const ttlSeconds = Math.max(
      60,
      Math.floor((this.env.NOTIFICATION_TTL_HOURS * 3600) - (Date.now() - notification.createdAt.getTime()) / 1000)
    );

    const message: Record<string, unknown> = {
      token,
      notification: {
        title: notification.title,
        body: notification.body,
        ...(notification.imageUrl ? { imageUrl: notification.imageUrl } : {})
      },
      data: {
        type: notification.type,
        workspaceId: notification.workspaceId,
        chatId: notification.chatId ?? "",
        messageId: notification.messageId ?? "",
        deepLinkPath: notification.deepLinkPath,
        notificationId: notification.id,
        sentAt: notification.createdAt.toISOString(),
        sound: notification.sound ? "1" : "0",
        vibration: notification.vibration ? "1" : "0",
        actions: "open,mark_read,claim",
        ...(notification.badgeCount !== null ? { badge: String(notification.badgeCount) } : {})
      },
      android: {
        priority: androidPriority,
        ttl: ttlSeconds * 1000,
        notification: {
          channelId:
            notification.type === "INCOMING_MESSAGE" || notification.type === "NEW_CONVERSATION"
              ? "atlas_messages"
              : "atlas_system",
          tag: uniqueTag,
          notificationCount: notification.badgeCount ?? undefined,
          visibility: "PRIVATE",
          defaultSound: notification.sound,
          defaultVibrateTimings: notification.vibration,
          // Sticky until user interacts — no auto-dismiss / no collapseKey.
          sticky: true,
          ...(notification.imageUrl ? { imageUrl: notification.imageUrl } : {})
        }
      },
      webpush: {
        headers: {
          Urgency: urgency,
          TTL: String(ttlSeconds)
        },
        notification: {
          title: notification.title,
          body: notification.body,
          tag: uniqueTag,
          renotify: true,
          requireInteraction: true,
          silent: !notification.sound,
          ...(notification.imageUrl ? { image: notification.imageUrl } : {}),
          ...(notification.badgeCount !== null ? { badge: "/icons/icon-192.png" } : {}),
          actions: [
            { action: "open", title: "Open" },
            { action: "mark_read", title: "Mark read" },
            { action: "claim", title: "Claim" }
          ],
          data: {
            deepLinkPath: notification.deepLinkPath,
            chatId: notification.chatId,
            messageId: notification.messageId,
            type: notification.type,
            workspaceId: notification.workspaceId,
            notificationId: notification.id
          }
        },
        fcmOptions: {
          link: `${this.env.FRONTEND_ORIGIN}${notification.deepLinkPath}`
        }
      }
    };

    try {
      const messageId = await messaging.send(message);
      return { ok: true, messageId };
    } catch (error) {
      return this.mapError(error);
    }
  }

  public nextRetryAt(attemptAfterFailure: number): Date {
    return new Date(Date.now() + nextNotificationRetryDelayMs(attemptAfterFailure));
  }

  private mapError(error: unknown): FcmSendResult {
    const code = String(
      (error as { code?: string; errorInfo?: { code?: string } } | null)?.code ??
        (error as { errorInfo?: { code?: string } } | null)?.errorInfo?.code ??
        "UNKNOWN"
    );
    const message = error instanceof Error ? error.message : String(error);
    const invalidToken =
      /registration-token-not-registered|invalid-registration-token|invalid-argument/i.test(code) ||
      /not a valid FCM registration token/i.test(message);
    const retryable =
      !invalidToken &&
      (/unavailable|internal|resource-exhausted|deadline-exceeded|quota|FCM_NOT_CONFIGURED|FCM_INIT_FAILED/i.test(code) ||
        /UNAVAILABLE|INTERNAL|RESOURCE_EXHAUSTED/i.test(message));

    this.log.warn({ code, message, invalidToken, retryable }, "FCM send failed");
    return { ok: false, invalidToken, retryable, code, message: message.slice(0, 500) };
  }
}
