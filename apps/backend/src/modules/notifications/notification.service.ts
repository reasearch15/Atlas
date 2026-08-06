import {
  buildNotificationDeepLinkPath,
  buildNotificationIdempotencyKey,
  isNotificationPendingStatus,
  notificationPriorityForType,
  truncateNotificationPreview,
  type NotificationAckEvent,
  type NotificationAction,
  type NotificationAnalyticsDto,
  type NotificationReconcileResultDto,
  type NotificationType
} from "@atlas/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { RequestUser } from "../auth/auth.types";
import { AppError, forbidden } from "../../utils/errors";
import { DeviceTokenService, NotificationPreferenceService } from "./device-token.service";
import { getNotificationWebConfig } from "./fcm.config";
import { NotificationLogger } from "./notification.logger";
import type {
  EnqueuePushNotificationInput,
  NotifyAssignmentInput,
  NotifyConversationReopenedInput,
  NotifyFailedMessageInput,
  NotifyIncomingMessageInput,
  NotifyTestInput,
  NotifyUrgentFlagInput
} from "./notification.types";

/**
 * Single entry point for all Atlas push notifications.
 * Integrations must call this service only — never embed FCM logic elsewhere.
 *
 * Reliability model:
 * - Postgres `push_notifications` is the durable source of truth
 * - BullMQ is a wake-up / dispatcher only
 * - Pending rows survive backend restarts and are retried until sent or expired
 */
export class NotificationService {
  private readonly app: FastifyInstance;
  private readonly log: FastifyBaseLogger;
  public readonly devices: DeviceTokenService;
  public readonly preferences: NotificationPreferenceService;
  public readonly deliveryLog: NotificationLogger;

  public constructor(app: FastifyInstance) {
    this.app = app;
    this.log = app.log.child({ module: "notification-service" });
    this.devices = new DeviceTokenService(app);
    this.preferences = new NotificationPreferenceService(app);
    this.deliveryLog = new NotificationLogger(app);
  }

  public webConfig() {
    return getNotificationWebConfig(this.app.env);
  }

  public async notifyIncomingMessage(input: NotifyIncomingMessageInput): Promise<void> {
    try {
      const type: NotificationType = input.isFirstMessage
        ? "NEW_CONVERSATION"
        : input.isUrgent
          ? "URGENT_FLAG"
          : "INCOMING_MESSAGE";

      const recipientIds = await this.resolveMessageRecipients(input.workspaceId, input.chatId);
      if (recipientIds.length === 0) return;

      const customerName = input.customerName.trim() || "Customer";
      const preview = truncateNotificationPreview(input.preview || "New message");
      const title = `New message from ${customerName}`;
      const body = preview;
      const eventKey = input.eventId ?? input.messageId;

      await this.fanOut({
        workspaceId: input.workspaceId,
        userIds: recipientIds,
        type,
        urgent: Boolean(input.isUrgent || input.isFirstMessage),
        title,
        body,
        customerName,
        chatId: input.chatId,
        messageId: input.messageId,
        imageUrl: input.imageUrl ?? null,
        sentAt: input.sentAt,
        eventKey,
        customizeTitle: (prefs) => (prefs.showCustomerNames ? title : "New message"),
        customizeBody: (prefs) => (prefs.previewText ? body : "Open Atlas to view the message")
      });
    } catch (error) {
      this.log.warn({ error, chatId: input.chatId }, "notifyIncomingMessage failed (non-blocking)");
    }
  }

  public async notifyAssignment(input: NotifyAssignmentInput): Promise<void> {
    try {
      if (input.assigneeUserId === input.actorUserId) return;
      const type: NotificationType = input.reassigned ? "CONVERSATION_REASSIGNED" : "CONVERSATION_ASSIGNED";
      const customerName = input.customerName.trim() || "Customer";
      const title = input.reassigned ? "Conversation reassigned to you" : "Conversation assigned to you";
      const body = truncateNotificationPreview(`${customerName} · Open to respond`);
      await this.fanOut({
        workspaceId: input.workspaceId,
        userIds: [input.assigneeUserId],
        type,
        urgent: false,
        title,
        body,
        customerName,
        chatId: input.chatId,
        messageId: null,
        imageUrl: null,
        sentAt: new Date().toISOString(),
        eventKey: input.eventId ?? `${type}:${input.chatId}:${input.assigneeUserId}`
      });
    } catch (error) {
      this.log.warn({ error, chatId: input.chatId }, "notifyAssignment failed (non-blocking)");
    }
  }

  public async notifyConversationReopened(input: NotifyConversationReopenedInput): Promise<void> {
    try {
      const recipients =
        input.recipientUserIds && input.recipientUserIds.length > 0
          ? [...input.recipientUserIds]
          : await this.resolveMessageRecipients(input.workspaceId, input.chatId);
      const customerName = input.customerName.trim() || "Customer";
      await this.fanOut({
        workspaceId: input.workspaceId,
        userIds: recipients,
        type: "CONVERSATION_REOPENED",
        urgent: false,
        title: "Conversation reopened",
        body: truncateNotificationPreview(`${customerName} needs attention again`),
        customerName,
        chatId: input.chatId,
        messageId: null,
        imageUrl: null,
        sentAt: new Date().toISOString(),
        eventKey: input.eventId ?? `reopened:${input.chatId}`
      });
    } catch (error) {
      this.log.warn({ error, chatId: input.chatId }, "notifyConversationReopened failed (non-blocking)");
    }
  }

  public async notifyUrgentFlag(input: NotifyUrgentFlagInput): Promise<void> {
    try {
      const recipients =
        input.recipientUserIds && input.recipientUserIds.length > 0
          ? [...input.recipientUserIds]
          : await this.resolveMessageRecipients(input.workspaceId, input.chatId);
      const customerName = input.customerName.trim() || "Customer";
      await this.fanOut({
        workspaceId: input.workspaceId,
        userIds: recipients,
        type: "URGENT_FLAG",
        urgent: true,
        title: "Urgent conversation",
        body: truncateNotificationPreview(`${customerName} flagged as urgent`),
        customerName,
        chatId: input.chatId,
        messageId: null,
        imageUrl: null,
        sentAt: new Date().toISOString(),
        eventKey: input.eventId ?? `urgent:${input.chatId}`
      });
    } catch (error) {
      this.log.warn({ error, chatId: input.chatId }, "notifyUrgentFlag failed (non-blocking)");
    }
  }

  public async notifyFailedMessage(input: NotifyFailedMessageInput): Promise<void> {
    try {
      await this.fanOut({
        workspaceId: input.workspaceId,
        userIds: [input.recipientUserId],
        type: "FAILED_MESSAGE",
        urgent: true,
        title: "Message failed to send",
        body: truncateNotificationPreview(input.preview || `${input.customerName}: needs manual attention`),
        customerName: input.customerName,
        chatId: input.chatId,
        messageId: input.messageId,
        imageUrl: null,
        sentAt: new Date().toISOString(),
        eventKey: input.eventId ?? `failed:${input.messageId}`
      });
    } catch (error) {
      this.log.warn({ error, messageId: input.messageId }, "notifyFailedMessage failed (non-blocking)");
    }
  }

  public async notifyTest(user: RequestUser, input?: NotifyTestInput): Promise<{ queued: number }> {
    const workspaceId = input?.workspaceId ?? user.workspaceId;
    if (!workspaceId) return { queued: 0 };
    const userId = input?.userId ?? user.id;
    const tokens = await this.devices.activeTokensForUsers(workspaceId, [userId]);
    const filtered = input?.deviceTokenId ? tokens.filter((t) => t.id === input.deviceTokenId) : tokens;
    let queued = 0;
    const inboxPath = user.role === "STAFF" ? "/staff/inbox?from=push&test=1" : "/workspace/inbox?from=push&test=1";
    const eventKey = `test:${Date.now()}`;
    for (const device of filtered) {
      await this.enqueuePersistent({
        workspaceId,
        userId,
        deviceTokenId: device.id,
        type: "TEST",
        priority: notificationPriorityForType("TEST"),
        idempotencyKey: buildNotificationIdempotencyKey({
          type: "TEST",
          eventKey: `${eventKey}:${device.id}`,
          userId,
          deviceTokenId: device.id
        }),
        title: "Atlas test notification",
        body: "Push notifications are working on this device.",
        customerName: null,
        chatId: null,
        messageId: null,
        deepLinkPath: inboxPath,
        imageUrl: null,
        badgeCount: null,
        sound: true,
        vibration: true,
        sentAt: new Date().toISOString()
      });
      queued += 1;
    }
    return { queued };
  }

  public async resolveMessageRecipients(workspaceId: string, chatId: string): Promise<string[]> {
    const chat = await this.app.prisma.telegramChat.findFirst({
      where: { id: chatId, workspaceId },
      select: { assignedUserId: true }
    });
    if (!chat) return [];

    if (chat.assignedUserId) {
      return [chat.assignedUserId];
    }

    const users = await this.app.prisma.user.findMany({
      where: {
        workspaceId,
        role: { in: ["COADMIN", "STAFF"] },
        status: "ACTIVE"
      },
      select: { id: true }
    });
    return users.map((u) => u.id);
  }

  /**
   * When a device registers/reconnects, bind pending device-less notifications
   * and re-wake any retryable rows so offline gaps are closed.
   */
  public async reconcileForUser(user: RequestUser): Promise<NotificationReconcileResultDto> {
    const workspaceId = user.workspaceId;
    if (!workspaceId) {
      return { unreadBadge: 0, pendingNotifications: 0, requeued: 0 };
    }

    const devices = await this.devices.activeTokensForUsers(workspaceId, [user.id]);
    let requeued = 0;

    if (devices.length > 0) {
      const primary = devices[0]!;
      const orphans = await this.app.prisma.pushNotification.findMany({
        where: {
          userId: user.id,
          workspaceId,
          deviceTokenId: null,
          status: { in: ["QUEUED", "RETRY_SCHEDULED", "FAILED"] },
          expiresAt: { gt: new Date() }
        },
        take: 200
      });

      for (const orphan of orphans) {
        await this.app.prisma.pushNotification.update({
          where: { id: orphan.id },
          data: {
            deviceTokenId: primary.id,
            status: "QUEUED",
            nextAttemptAt: new Date(),
            lastErrorCode: null,
            lastErrorMessage: null
          }
        });
        await this.wakeDispatcher(orphan.id, 0);
        requeued += 1;
      }

      const retryable = await this.app.prisma.pushNotification.findMany({
        where: {
          userId: user.id,
          workspaceId,
          status: { in: ["QUEUED", "RETRY_SCHEDULED", "FAILED"] },
          deviceTokenId: { not: null },
          expiresAt: { gt: new Date() }
        },
        take: 200
      });

      for (const row of retryable) {
        if (row.status === "QUEUED" && (!row.nextAttemptAt || row.nextAttemptAt <= new Date())) {
          await this.wakeDispatcher(row.id, 0);
          requeued += 1;
        } else if (row.status === "RETRY_SCHEDULED" || row.status === "FAILED") {
          await this.app.prisma.pushNotification.update({
            where: { id: row.id },
            data: { status: "QUEUED", nextAttemptAt: new Date() }
          });
          await this.wakeDispatcher(row.id, 0);
          requeued += 1;
        }
      }
    }

    const [unreadBadge, pendingNotifications] = await Promise.all([
      this.loadUnreadBadge(workspaceId),
      this.app.prisma.pushNotification.count({
        where: {
          userId: user.id,
          workspaceId,
          status: { in: ["QUEUED", "DISPATCHING", "RETRY_SCHEDULED", "FAILED"] },
          expiresAt: { gt: new Date() }
        }
      })
    ]);

    return { unreadBadge, pendingNotifications, requeued };
  }

  public async acknowledge(user: RequestUser, notificationId: string, event: NotificationAckEvent): Promise<{ ok: true }> {
    const row = await this.requireOwnedNotification(user, notificationId);
    const now = new Date();
    const data =
      event === "delivered"
        ? { status: "DELIVERED" as const, deliveredAt: row.deliveredAt ?? now }
        : event === "opened"
          ? { status: "OPENED" as const, openedAt: row.openedAt ?? now, deliveredAt: row.deliveredAt ?? now }
          : { status: "DISMISSED" as const, dismissedAt: row.dismissedAt ?? now };

    await this.app.prisma.pushNotification.update({ where: { id: row.id }, data });
    await this.deliveryLog.record({
      workspaceId: row.workspaceId,
      userId: row.userId,
      deviceTokenId: row.deviceTokenId,
      notificationId: row.id,
      type: row.type,
      status: data.status,
      dedupeKey: `${row.idempotencyKey}:${event}:${now.getTime()}`,
      title: row.title,
      body: row.body,
      chatId: row.chatId,
      messageId: row.messageId,
      attempt: row.attemptCount
    });
    return { ok: true };
  }

  public async performAction(
    user: RequestUser,
    notificationId: string,
    action: NotificationAction
  ): Promise<{ readonly ok: true; readonly deepLinkPath?: string }> {
    const row = await this.requireOwnedNotification(user, notificationId);

    if (action === "open") {
      await this.acknowledge(user, notificationId, "opened");
      return { ok: true, deepLinkPath: row.deepLinkPath };
    }

    if (!row.chatId) {
      throw new AppError(400, "BAD_REQUEST", "This notification has no conversation target");
    }

    if (action === "mark_read") {
      await this.app.prisma.telegramChat.updateMany({
        where: { id: row.chatId, workspaceId: row.workspaceId },
        data: { unreadCount: 0, lastReadAt: new Date() }
      });
      await this.acknowledge(user, notificationId, "opened");
      return { ok: true, deepLinkPath: row.deepLinkPath };
    }

    // claim
    const chat = await this.app.prisma.telegramChat.findFirst({
      where: { id: row.chatId, workspaceId: row.workspaceId },
      select: { assignedUserId: true }
    });
    if (!chat) throw new AppError(404, "NOT_FOUND", "Conversation not found");
    if (chat.assignedUserId && chat.assignedUserId !== user.id) {
      throw forbidden("Conversation is already assigned to another teammate");
    }
    if (!chat.assignedUserId) {
      const now = new Date();
      const result = await this.app.prisma.telegramChat.updateMany({
        where: { id: row.chatId, workspaceId: row.workspaceId, assignedUserId: null },
        data: {
          assignedUserId: user.id,
          assignedByUserId: user.id,
          assignedAt: now,
          claimedAt: now,
          lastAssignmentChangeAt: now
        }
      });
      if (result.count === 0) {
        throw new AppError(409, "CONFLICT", "Conversation was claimed by another teammate");
      }
    }
    await this.acknowledge(user, notificationId, "opened");
    return { ok: true, deepLinkPath: row.deepLinkPath };
  }

  public async analytics(workspaceId?: string, windowHours = 24): Promise<NotificationAnalyticsDto> {
    const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);
    const whereWorkspace = workspaceId ? { workspaceId } : {};
    const base = { ...whereWorkspace, createdAt: { gte: since } };

    const [created, sent, delivered, opened, failed, retried, expired, sentRows, openedRows, retrySuccess] =
      await Promise.all([
        this.app.prisma.pushNotification.count({ where: base }),
        this.app.prisma.pushNotification.count({ where: { ...base, status: { in: ["SENT", "DELIVERED", "OPENED", "DISMISSED"] } } }),
        this.app.prisma.pushNotification.count({ where: { ...base, deliveredAt: { not: null } } }),
        this.app.prisma.pushNotification.count({ where: { ...base, openedAt: { not: null } } }),
        this.app.prisma.pushNotification.count({
          where: { ...base, status: { in: ["FAILED", "INVALID_TOKEN", "EXPIRED"] } }
        }),
        this.app.prisma.pushNotification.count({ where: { ...base, attemptCount: { gt: 1 } } }),
        this.app.prisma.pushNotification.count({ where: { ...base, status: "EXPIRED" } }),
        this.app.prisma.pushNotification.findMany({
          where: { ...base, sentAt: { not: null } },
          select: { createdAt: true, sentAt: true },
          take: 5_000
        }),
        this.app.prisma.pushNotification.findMany({
          where: { ...base, openedAt: { not: null }, sentAt: { not: null } },
          select: { sentAt: true, openedAt: true },
          take: 5_000
        }),
        this.app.prisma.pushNotification.count({
          where: {
            ...base,
            attemptCount: { gt: 1 },
            status: { in: ["SENT", "DELIVERED", "OPENED", "DISMISSED"] }
          }
        })
      ]);

    const avgDeliveryLatencyMs =
      sentRows.length === 0
        ? null
        : Math.round(
            sentRows.reduce((sum, row) => sum + (row.sentAt!.getTime() - row.createdAt.getTime()), 0) / sentRows.length
          );
    const avgOpenLatencyMs =
      openedRows.length === 0
        ? null
        : Math.round(
            openedRows.reduce((sum, row) => sum + (row.openedAt!.getTime() - row.sentAt!.getTime()), 0) /
              openedRows.length
          );

    return {
      windowHours,
      created,
      sent,
      delivered,
      opened,
      failed,
      retried,
      expired,
      failureRate: created === 0 ? 0 : failed / created,
      openRate: sent === 0 ? 0 : opened / sent,
      retrySuccessRate: retried === 0 ? 0 : retrySuccess / retried,
      avgDeliveryLatencyMs,
      avgOpenLatencyMs
    };
  }

  public async expireDueNotifications(): Promise<number> {
    const now = new Date();
    const due = await this.app.prisma.pushNotification.findMany({
      where: {
        expiresAt: { lte: now },
        status: { in: ["QUEUED", "DISPATCHING", "RETRY_SCHEDULED", "FAILED"] }
      },
      take: 500
    });
    for (const row of due) {
      await this.app.prisma.pushNotification.update({
        where: { id: row.id },
        data: { status: "EXPIRED", failedAt: row.failedAt ?? now }
      });
      await this.deliveryLog.record({
        workspaceId: row.workspaceId,
        userId: row.userId,
        deviceTokenId: row.deviceTokenId,
        notificationId: row.id,
        type: row.type,
        status: "EXPIRED",
        dedupeKey: `${row.idempotencyKey}:expired`,
        title: row.title,
        body: row.body,
        chatId: row.chatId,
        messageId: row.messageId,
        attempt: row.attemptCount
      });
    }
    return due.length;
  }

  /**
   * Re-wake due RETRY_SCHEDULED / QUEUED rows after process restart.
   */
  public async resumePendingNotifications(): Promise<number> {
    const now = new Date();
    const due = await this.app.prisma.pushNotification.findMany({
      where: {
        status: { in: ["QUEUED", "RETRY_SCHEDULED"] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        expiresAt: { gt: now },
        deviceTokenId: { not: null }
      },
      take: 500,
      select: { id: true }
    });
    for (const row of due) {
      await this.wakeDispatcher(row.id, 0);
    }
    return due.length;
  }

  private async fanOut(args: {
    readonly workspaceId: string;
    readonly userIds: readonly string[];
    readonly type: NotificationType;
    readonly urgent: boolean;
    readonly title: string;
    readonly body: string;
    readonly customerName: string | null;
    readonly chatId: string | null;
    readonly messageId: string | null;
    readonly imageUrl: string | null;
    readonly sentAt: string;
    readonly eventKey: string;
    readonly customizeTitle?: (prefs: Awaited<ReturnType<NotificationPreferenceService["get"]>>) => string;
    readonly customizeBody?: (prefs: Awaited<ReturnType<NotificationPreferenceService["get"]>>) => string;
  }): Promise<void> {
    const uniqueUserIds = [...new Set(args.userIds)];
    if (uniqueUserIds.length === 0) return;

    const [prefsMap, devices, badgeByUser, roles] = await Promise.all([
      this.preferences.getMapForUsers(uniqueUserIds),
      this.devices.activeTokensForUsers(args.workspaceId, uniqueUserIds),
      this.loadUnreadBadges(args.workspaceId, uniqueUserIds),
      this.app.prisma.user.findMany({
        where: { id: { in: uniqueUserIds } },
        select: { id: true, role: true }
      })
    ]);

    const roleByUser = new Map(roles.map((r) => [r.id, r.role]));
    const devicesByUser = new Map<string, typeof devices>();
    for (const device of devices) {
      const list = devicesByUser.get(device.userId) ?? [];
      list.push(device);
      devicesByUser.set(device.userId, list);
    }

    for (const userId of uniqueUserIds) {
      const prefs = prefsMap.get(userId)!;
      if (!this.preferences.shouldSend(prefs, args.type, args.urgent)) {
        continue;
      }

      const title = args.customizeTitle ? args.customizeTitle(prefs) : args.title;
      const body = args.customizeBody ? args.customizeBody(prefs) : args.body;
      const role = roleByUser.get(userId);
      const rolePath = role === "STAFF" ? "staff" : "workspace";
      const userDevices = devicesByUser.get(userId) ?? [];

      // No registered device yet — keep a durable pending row until reconnect.
      if (userDevices.length === 0) {
        const deepLinkPath = args.chatId
          ? buildNotificationDeepLinkPath({
              workspaceId: args.workspaceId,
              chatId: args.chatId,
              messageId: args.messageId,
              rolePath,
              highlightUnread: true
            })
          : rolePath === "staff"
            ? "/staff/inbox?from=push"
            : "/workspace/inbox?from=push";

        await this.enqueuePersistent({
          workspaceId: args.workspaceId,
          userId,
          deviceTokenId: null,
          type: args.type,
          priority: notificationPriorityForType(args.type),
          idempotencyKey: buildNotificationIdempotencyKey({
            type: args.type,
            eventKey: args.eventKey,
            userId,
            deviceTokenId: null
          }),
          title,
          body,
          customerName: args.customerName,
          chatId: args.chatId,
          messageId: args.messageId,
          deepLinkPath,
          imageUrl: args.imageUrl,
          badgeCount: badgeByUser.get(userId) ?? null,
          sound: prefs.sound,
          vibration: prefs.vibration,
          sentAt: args.sentAt
        });
        continue;
      }

      // Multi-device: every device gets an independent notification.
      for (const device of userDevices) {
        const notificationIdPlaceholder = crypto.randomUUID();
        const deepLinkPath = args.chatId
          ? buildNotificationDeepLinkPath({
              workspaceId: args.workspaceId,
              chatId: args.chatId,
              messageId: args.messageId,
              notificationId: notificationIdPlaceholder,
              rolePath,
              highlightUnread: true
            })
          : rolePath === "staff"
            ? "/staff/inbox?from=push"
            : "/workspace/inbox?from=push";

        await this.enqueuePersistent({
          workspaceId: args.workspaceId,
          userId,
          deviceTokenId: device.id,
          type: args.type,
          priority: notificationPriorityForType(args.type),
          idempotencyKey: buildNotificationIdempotencyKey({
            type: args.type,
            eventKey: args.eventKey,
            userId,
            deviceTokenId: device.id
          }),
          title,
          body,
          customerName: args.customerName,
          chatId: args.chatId,
          messageId: args.messageId,
          deepLinkPath,
          imageUrl: args.imageUrl,
          badgeCount: badgeByUser.get(userId) ?? null,
          sound: prefs.sound,
          vibration: prefs.vibration,
          sentAt: args.sentAt
        }, notificationIdPlaceholder);
      }
    }
  }

  private async enqueuePersistent(
    input: EnqueuePushNotificationInput,
    preferredId?: string
  ): Promise<string | null> {
    const expiresAt = new Date(Date.now() + this.app.env.NOTIFICATION_TTL_HOURS * 60 * 60 * 1000);
    const id = preferredId ?? crypto.randomUUID();

    try {
      const created = await this.app.prisma.pushNotification.create({
        data: {
          id,
          workspaceId: input.workspaceId,
          userId: input.userId,
          deviceTokenId: input.deviceTokenId,
          type: input.type,
          status: "QUEUED",
          priority: input.priority,
          idempotencyKey: input.idempotencyKey,
          title: input.title.slice(0, 200),
          body: input.body.slice(0, 280),
          customerName: input.customerName,
          chatId: input.chatId,
          messageId: input.messageId,
          deepLinkPath: input.deepLinkPath.includes("notificationId=")
            ? input.deepLinkPath
            : input.deepLinkPath.includes("?")
              ? `${input.deepLinkPath}&notificationId=${id}`
              : `${input.deepLinkPath}?notificationId=${id}`,
          imageUrl: input.imageUrl,
          badgeCount: input.badgeCount,
          sound: input.sound,
          vibration: input.vibration,
          attemptCount: 0,
          nextAttemptAt: new Date(),
          expiresAt
        }
      });

      await this.deliveryLog.record({
        workspaceId: created.workspaceId,
        userId: created.userId,
        deviceTokenId: created.deviceTokenId,
        notificationId: created.id,
        type: created.type,
        status: "QUEUED",
        dedupeKey: `${created.idempotencyKey}:queued`,
        title: created.title,
        body: created.body,
        chatId: created.chatId,
        messageId: created.messageId,
        attempt: 0
      });

      if (created.deviceTokenId) {
        await this.wakeDispatcher(created.id, 0);
      }
      return created.id;
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === "P2002") {
        this.log.debug({ idempotencyKey: input.idempotencyKey }, "Duplicate notification suppressed");
        return null;
      }
      this.log.warn({ error, idempotencyKey: input.idempotencyKey }, "Failed to enqueue durable notification");
      return null;
    }
  }

  public async wakeDispatcher(notificationId: string, delayMs: number): Promise<void> {
    try {
      await this.app.queues.pushNotifications.add(
        "deliver",
        { notificationId },
        {
          jobId: `push:${notificationId}:${delayMs > 0 ? Math.floor(Date.now() / 1000) : "now"}`.slice(0, 120),
          delay: Math.max(0, delayMs),
          attempts: 1,
          removeOnComplete: 5_000,
          removeOnFail: 5_000
        }
      );
    } catch (error) {
      const message = (error as { message?: string } | null)?.message ?? "";
      if (/already exists|JobId/i.test(message)) {
        return;
      }
      this.log.warn({ error, notificationId }, "Failed to wake push dispatcher");
    }
  }

  private async loadUnreadBadges(workspaceId: string, userIds: readonly string[]): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    const total = await this.loadUnreadBadge(workspaceId);
    for (const id of userIds) map.set(id, total);
    return map;
  }

  private async loadUnreadBadge(workspaceId: string): Promise<number> {
    const unread = await this.app.prisma.telegramChat.aggregate({
      where: { workspaceId, unreadCount: { gt: 0 }, isArchived: false },
      _sum: { unreadCount: true }
    });
    return unread._sum.unreadCount ?? 0;
  }

  private requireWorkspace(user: RequestUser): string {
    if (!user.workspaceId) {
      throw new AppError(400, "BAD_REQUEST", "Workspace-scoped session required");
    }
    return user.workspaceId;
  }

  private async requireOwnedNotification(user: RequestUser, notificationId: string) {
    const workspaceId = this.requireWorkspace(user);
    const row = await this.app.prisma.pushNotification.findFirst({
      where: { id: notificationId, userId: user.id, workspaceId }
    });
    if (!row) throw new AppError(404, "NOT_FOUND", "Notification not found");
    return row;
  }

  public async adminStats(workspaceId?: string) {
    const analytics = await this.analytics(workspaceId, 24);
    const whereWorkspace = workspaceId ? { workspaceId } : {};
    const [devices, recentFailures] = await Promise.all([
      this.app.prisma.pushDeviceToken.count({ where: { ...whereWorkspace, revokedAt: null } }),
      this.app.prisma.pushNotification.findMany({
        where: { ...whereWorkspace, status: { in: ["FAILED", "INVALID_TOKEN", "EXPIRED"] } },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: {
          id: true,
          type: true,
          status: true,
          lastErrorCode: true,
          lastErrorMessage: true,
          createdAt: true,
          userId: true
        }
      })
    ]);

    return {
      devices,
      sent24h: analytics.sent,
      failed24h: analytics.failed,
      queued24h: analytics.created - analytics.sent - analytics.failed,
      analytics,
      recentFailures: recentFailures.map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        errorCode: row.lastErrorCode,
        errorMessage: row.lastErrorMessage,
        createdAt: row.createdAt.toISOString(),
        userId: row.userId
      }))
    };
  }
}

export { isNotificationPendingStatus };
