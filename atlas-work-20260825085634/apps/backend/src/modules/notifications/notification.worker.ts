import { Worker, type Job } from "bullmq";
import type { FastifyInstance } from "fastify";
import { NotificationDispatcher } from "./notification.dispatcher";
import type { PushNotificationJob } from "./notification.types";

/**
 * Consumes BullMQ wake-ups and drives durable `push_notifications` rows through FCM.
 * Retry schedule + expiry live in Postgres so restarts never lose pending work.
 */
export function startPushNotificationWorker(app: FastifyInstance): Worker {
  const connection = app.redis.duplicate();
  const dispatcher = new NotificationDispatcher(app.env, app.log);

  const worker = new Worker<PushNotificationJob>(
    "push-notifications",
    async (job: Job<PushNotificationJob>) => {
      await processNotification(app, dispatcher, job.data.notificationId);
    },
    {
      connection,
      concurrency: 20
    }
  );

  worker.on("failed", (job, error) => {
    app.log.warn(
      { jobId: job?.id, notificationId: job?.data?.notificationId, error: error.message },
      "Push notification wake-up failed"
    );
  });

  app.addHook("onClose", async () => {
    await worker.close();
    await connection.quit();
  });

  return worker;
}

async function processNotification(
  app: FastifyInstance,
  dispatcher: NotificationDispatcher,
  notificationId: string
): Promise<void> {
  const row = await app.prisma.pushNotification.findUnique({ where: { id: notificationId } });
  if (!row) return;

  if (row.expiresAt.getTime() <= Date.now()) {
    await app.prisma.pushNotification.update({
      where: { id: row.id },
      data: { status: "EXPIRED", failedAt: row.failedAt ?? new Date() }
    });
    await app.notifications.deliveryLog.record({
      workspaceId: row.workspaceId,
      userId: row.userId,
      deviceTokenId: row.deviceTokenId,
      notificationId: row.id,
      type: row.type,
      status: "EXPIRED",
      dedupeKey: `${row.idempotencyKey}:expired:${Date.now()}`,
      title: row.title,
      body: row.body,
      chatId: row.chatId,
      messageId: row.messageId,
      attempt: row.attemptCount
    });
    return;
  }

  if (["SENT", "DELIVERED", "OPENED", "DISMISSED", "CANCELLED", "EXPIRED", "SKIPPED", "INVALID_TOKEN"].includes(row.status)) {
    return;
  }

  if (!row.deviceTokenId) {
    // Waiting for device registration / reconcile.
    return;
  }

  const device = await app.prisma.pushDeviceToken.findFirst({
    where: { id: row.deviceTokenId, revokedAt: null },
    select: { id: true, token: true }
  });

  if (!device) {
    await app.prisma.pushNotification.update({
      where: { id: row.id },
      data: {
        status: "RETRY_SCHEDULED",
        deviceTokenId: null,
        nextAttemptAt: null,
        lastErrorCode: "DEVICE_REVOKED",
        lastErrorMessage: "Device token missing or revoked — waiting for re-registration"
      }
    });
    await app.notifications.deliveryLog.record({
      workspaceId: row.workspaceId,
      userId: row.userId,
      deviceTokenId: row.deviceTokenId,
      notificationId: row.id,
      type: row.type,
      status: "RETRY_SCHEDULED",
      dedupeKey: `${row.idempotencyKey}:device-revoked:${Date.now()}`,
      title: row.title,
      body: row.body,
      chatId: row.chatId,
      messageId: row.messageId,
      errorCode: "DEVICE_REVOKED",
      errorMessage: "Device token missing or revoked",
      attempt: row.attemptCount
    });
    return;
  }

  const attempt = row.attemptCount + 1;
  await app.prisma.pushNotification.update({
    where: { id: row.id },
    data: { status: "DISPATCHING", attemptCount: attempt }
  });
  await app.notifications.deliveryLog.record({
    workspaceId: row.workspaceId,
    userId: row.userId,
    deviceTokenId: device.id,
    notificationId: row.id,
    type: row.type,
    status: "DISPATCHING",
    dedupeKey: `${row.idempotencyKey}:dispatching:${attempt}`,
    title: row.title,
    body: row.body,
    chatId: row.chatId,
    messageId: row.messageId,
    attempt
  });

  const result = await dispatcher.send(
    {
      id: row.id,
      type: row.type,
      priority: row.priority,
      title: row.title,
      body: row.body,
      workspaceId: row.workspaceId,
      chatId: row.chatId,
      messageId: row.messageId,
      deepLinkPath: row.deepLinkPath,
      imageUrl: row.imageUrl,
      badgeCount: row.badgeCount,
      sound: row.sound,
      vibration: row.vibration,
      createdAt: row.createdAt
    },
    device.token
  );

  if (result.ok) {
    const now = new Date();
    await Promise.all([
      app.notifications.devices.markDelivery(device.id, true),
      app.prisma.pushNotification.update({
        where: { id: row.id },
        data: {
          status: "SENT",
          fcmMessageId: result.messageId,
          sentAt: now,
          lastErrorCode: null,
          lastErrorMessage: null,
          nextAttemptAt: null
        }
      }),
      app.notifications.deliveryLog.record({
        workspaceId: row.workspaceId,
        userId: row.userId,
        deviceTokenId: device.id,
        notificationId: row.id,
        type: row.type,
        status: "SENT",
        dedupeKey: `${row.idempotencyKey}:sent:${attempt}`,
        title: row.title,
        body: row.body,
        chatId: row.chatId,
        messageId: row.messageId,
        fcmMessageId: result.messageId,
        attempt
      })
    ]);
    return;
  }

  if (result.invalidToken) {
    await app.notifications.devices.revokeInvalidToken(device.token);
    await app.prisma.pushNotification.update({
      where: { id: row.id },
      data: {
        status: "INVALID_TOKEN",
        failedAt: new Date(),
        lastErrorCode: result.code,
        lastErrorMessage: result.message,
        deviceTokenId: null,
        nextAttemptAt: null
      }
    });
    await app.notifications.deliveryLog.record({
      workspaceId: row.workspaceId,
      userId: row.userId,
      deviceTokenId: device.id,
      notificationId: row.id,
      type: row.type,
      status: "INVALID_TOKEN",
      dedupeKey: `${row.idempotencyKey}:invalid:${attempt}`,
      title: row.title,
      body: row.body,
      chatId: row.chatId,
      messageId: row.messageId,
      errorCode: result.code,
      errorMessage: result.message,
      attempt
    });
    return;
  }

  await app.notifications.devices.markDelivery(device.id, false);

  if (result.retryable) {
    const nextAttemptAt = dispatcher.nextRetryAt(attempt);
    if (nextAttemptAt.getTime() >= row.expiresAt.getTime()) {
      await app.prisma.pushNotification.update({
        where: { id: row.id },
        data: {
          status: "EXPIRED",
          failedAt: new Date(),
          lastErrorCode: result.code,
          lastErrorMessage: result.message,
          nextAttemptAt: null
        }
      });
      await app.notifications.deliveryLog.record({
        workspaceId: row.workspaceId,
        userId: row.userId,
        deviceTokenId: device.id,
        notificationId: row.id,
        type: row.type,
        status: "EXPIRED",
        dedupeKey: `${row.idempotencyKey}:expired-retry:${attempt}`,
        title: row.title,
        body: row.body,
        chatId: row.chatId,
        messageId: row.messageId,
        errorCode: result.code,
        errorMessage: result.message,
        attempt
      });
      return;
    }

    const delayMs = Math.max(0, nextAttemptAt.getTime() - Date.now());
    await app.prisma.pushNotification.update({
      where: { id: row.id },
      data: {
        status: "RETRY_SCHEDULED",
        failedAt: new Date(),
        lastErrorCode: result.code,
        lastErrorMessage: result.message,
        nextAttemptAt
      }
    });
    await app.notifications.deliveryLog.record({
      workspaceId: row.workspaceId,
      userId: row.userId,
      deviceTokenId: device.id,
      notificationId: row.id,
      type: row.type,
      status: "RETRY_SCHEDULED",
      dedupeKey: `${row.idempotencyKey}:retry:${attempt}`,
      title: row.title,
      body: row.body,
      chatId: row.chatId,
      messageId: row.messageId,
      errorCode: result.code,
      errorMessage: result.message,
      attempt
    });
    await app.notifications.wakeDispatcher(row.id, delayMs);
    return;
  }

  await app.prisma.pushNotification.update({
    where: { id: row.id },
    data: {
      status: "FAILED",
      failedAt: new Date(),
      lastErrorCode: result.code,
      lastErrorMessage: result.message,
      nextAttemptAt: null
    }
  });
  await app.notifications.deliveryLog.record({
    workspaceId: row.workspaceId,
    userId: row.userId,
    deviceTokenId: device.id,
    notificationId: row.id,
    type: row.type,
    status: "FAILED",
    dedupeKey: `${row.idempotencyKey}:fail:${attempt}`,
    title: row.title,
    body: row.body,
    chatId: row.chatId,
    messageId: row.messageId,
    errorCode: result.code,
    errorMessage: result.message,
    attempt
  });
}
