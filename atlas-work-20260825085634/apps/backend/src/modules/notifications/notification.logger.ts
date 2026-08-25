import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { NotificationDeliveryStatus, NotificationType } from "@atlas/shared";

/**
 * Persists every lifecycle transition for ops, admin stats, and debugging.
 * Never throws to callers — logging failures must not affect conversations.
 */
export class NotificationLogger {
  private readonly app: FastifyInstance;
  private readonly log: FastifyBaseLogger;

  public constructor(app: FastifyInstance) {
    this.app = app;
    this.log = app.log.child({ module: "notification-logger" });
  }

  public async record(input: {
    readonly workspaceId: string;
    readonly userId: string;
    readonly deviceTokenId: string | null;
    readonly notificationId?: string | null;
    readonly type: NotificationType;
    readonly status: NotificationDeliveryStatus;
    readonly dedupeKey: string;
    readonly title: string;
    readonly body: string;
    readonly chatId?: string | null;
    readonly messageId?: string | null;
    readonly fcmMessageId?: string | null;
    readonly errorCode?: string | null;
    readonly errorMessage?: string | null;
    readonly payload?: Record<string, unknown> | null;
    readonly attempt?: number;
  }): Promise<void> {
    try {
      await this.app.prisma.notificationDeliveryLog.create({
        data: {
          id: crypto.randomUUID(),
          workspaceId: input.workspaceId,
          userId: input.userId,
          deviceTokenId: input.deviceTokenId,
          notificationId: input.notificationId ?? null,
          type: input.type,
          status: input.status,
          dedupeKey: input.dedupeKey,
          title: input.title.slice(0, 200),
          body: input.body.slice(0, 280),
          chatId: input.chatId ?? null,
          messageId: input.messageId ?? null,
          fcmMessageId: input.fcmMessageId ?? null,
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage?.slice(0, 500) ?? null,
          ...(input.payload ? { payload: input.payload as object } : {}),
          attempt: input.attempt ?? 1
        }
      });
      this.log.info(
        {
          notificationId: input.notificationId,
          status: input.status,
          type: input.type,
          userId: input.userId,
          attempt: input.attempt ?? 1,
          errorCode: input.errorCode ?? undefined
        },
        `notification.${input.status.toLowerCase()}`
      );
    } catch (error) {
      this.log.warn({ error, dedupeKey: input.dedupeKey }, "Failed to write notification delivery log");
    }
  }
}
