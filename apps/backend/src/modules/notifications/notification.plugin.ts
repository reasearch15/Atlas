import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import type {
  TelegramCallIncomingEvent,
  TelegramMessageCreatedEvent,
  TelegramMessageUpdatedEvent
} from "@atlas/shared";
import { isFcmConfigured } from "./fcm.config";
import { getFirebaseMessaging } from "./firebase-admin.client";
import { NotificationService } from "./notification.service";
import { startPushNotificationWorker } from "./notification.worker";

declare module "fastify" {
  interface FastifyInstance {
    notifications: NotificationService;
  }
}

/**
 * Registers the platform notification service and bridges inbound workspace
 * events into asynchronous FCM dispatch without blocking message processing.
 */
export const notificationPlugin = fp(async (app) => {
  const notifications = new NotificationService(app);
  app.decorate("notifications", notifications);
  startPushNotificationWorker(app);

  if (isFcmConfigured(app.env)) {
    void getFirebaseMessaging(app.env).then((result) => {
      if (result.status === "ready") {
        app.log.info("Firebase Admin messaging initialized at startup");
        return;
      }
      if (result.status === "init_failed") {
        app.log.error({ error: result.error }, "Firebase Admin messaging failed at startup");
      }
    });
  }

  // Resume durable queue after crash/restart; expire overdue rows periodically.
  setTimeout(() => {
    void notifications.resumePendingNotifications().then((count) => {
      if (count > 0) app.log.info({ count }, "Resumed pending push notifications after startup");
    });
    void notifications.expireDueNotifications();
  }, 2_000);

  const maintenance = setInterval(() => {
    void notifications.expireDueNotifications();
    void notifications.resumePendingNotifications();
  }, 60_000);
  maintenance.unref?.();

  const subscriber = app.redis.duplicate();
  await subscriber.subscribe("atlas.workspace-events");

  subscriber.on("message", (_channel, payload) => {
    void handleWorkspaceEvent(app, payload);
  });

  app.addHook("onClose", async () => {
    clearInterval(maintenance);
    await subscriber.unsubscribe("atlas.workspace-events");
    await subscriber.quit();
  });
});

async function handleWorkspaceEvent(app: FastifyInstance, payload: string): Promise<void> {
  try {
    const event = JSON.parse(payload) as { type?: string };
    if (event.type === "telegram.message.created") {
      await handleInboundMessage(app, event as TelegramMessageCreatedEvent);
      return;
    }
    if (event.type === "telegram.message.updated") {
      await handleFailedOutbound(app, event as TelegramMessageUpdatedEvent);
      return;
    }
    if (event.type === "telegram.call.incoming") {
      await handleIncomingCall(app, event as TelegramCallIncomingEvent);
    }
  } catch (error) {
    app.log.warn({ error }, "Notification bridge failed to handle workspace event");
  }
}

async function handleInboundMessage(
  app: FastifyInstance,
  event: TelegramMessageCreatedEvent
): Promise<void> {
  const message = event.message;
  if (!message || message.direction !== "INBOUND") {
    return;
  }

  const meta = message.mediaMetadata as { atlasImport?: boolean; bulkSync?: boolean } | null;
  if (meta?.atlasImport || meta?.bulkSync) {
    return;
  }

  const chat = await app.prisma.telegramChat.findFirst({
    where: { id: message.chatId, workspaceId: event.workspaceId },
    select: {
      title: true,
      firstName: true,
      lastName: true,
      needsCrmAttention: true,
      crmStatus: true
    }
  });

  const customerName =
    [chat?.firstName, chat?.lastName].filter(Boolean).join(" ").trim() ||
    chat?.title ||
    message.senderDisplayName ||
    "Customer";

  const preview =
    message.text?.trim() ||
    message.caption?.trim() ||
    (message.contentType !== "TEXT" ? `[${message.contentType.toLowerCase()}]` : "New message");

  const inboundCount = await app.prisma.telegramMessage.count({
    where: { telegramChatDbId: message.chatId, direction: "INBOUND" }
  });

  await app.notifications.notifyIncomingMessage({
    workspaceId: event.workspaceId,
    chatId: message.chatId,
    messageId: message.id,
    customerName,
    preview,
    sentAt: message.sentAt,
    imageUrl: message.thumbnailUrl ?? null,
    isFirstMessage: inboundCount <= 1 || chat?.crmStatus === "NEW",
    isUrgent: Boolean(chat?.needsCrmAttention && chat.crmStatus === "NEW"),
    eventId: event.eventId,
    channel: "telegram"
  });
}

async function handleFailedOutbound(
  app: FastifyInstance,
  event: TelegramMessageUpdatedEvent
): Promise<void> {
  const message = event.message;
  if (!message || message.direction !== "OUTBOUND") return;
  if (message.sendStatus !== "FAILED_PERMANENT") return;
  if (!message.internalSenderUserId) return;

  const chat = await app.prisma.telegramChat.findFirst({
    where: { id: message.chatId, workspaceId: event.workspaceId },
    select: { title: true, firstName: true, lastName: true }
  });
  const customerName =
    [chat?.firstName, chat?.lastName].filter(Boolean).join(" ").trim() || chat?.title || "Customer";

  await app.notifications.notifyFailedMessage({
    workspaceId: event.workspaceId,
    chatId: message.chatId,
    messageId: message.id,
    recipientUserId: message.internalSenderUserId,
    customerName,
    preview: message.text || message.caption || "Outbound message failed",
    eventId: event.eventId
  });
}

async function handleIncomingCall(app: FastifyInstance, event: TelegramCallIncomingEvent): Promise<void> {
  if (event.workspaceId.trim().length === 0 || event.telegramAccountId.trim().length === 0) {
    return;
  }
  if (event.callId.trim().length === 0 || event.callerTelegramUserId.trim().length === 0) {
    return;
  }

  await app.notifications.notifyIncomingCall({
    workspaceId: event.workspaceId,
    telegramAccountId: event.telegramAccountId,
    callId: event.callId,
    callerTelegramUserId: event.callerTelegramUserId,
    callerName: event.callerName,
    callerUsername: event.callerUsername,
    video: Boolean(event.video),
    timestamp: event.timestamp,
    chatId: event.chatId ?? null,
    eventId: event.eventId
  });
}
