import fp from "fastify-plugin";
import {
  decryptSecret,
  type EncryptedSecret
} from "@atlas/shared/session-encryption";
import { LeaderboardBotUpdateHandler } from "./bot-update-handler";
import { HttpLeaderboardTelegramClient } from "./leaderboard-telegram.client";
import { LeaderboardTelegramIntegrationService } from "./leaderboard-telegram.integration-service";
import { LeaderboardTelegramOutboxService, resumeLeaderboardTelegramOutboxSafely } from "./leaderboard-telegram.outbox";
import { LeaderboardTelegramProcessor } from "./leaderboard-telegram.processor";
import { startLeaderboardTelegramWorker } from "./leaderboard-telegram.worker";

declare module "fastify" {
  interface FastifyInstance {
    leaderboardTelegramOutbox: LeaderboardTelegramOutboxService;
    leaderboardTelegramIntegration: LeaderboardTelegramIntegrationService;
    leaderboardTelegramProcessor: LeaderboardTelegramProcessor;
    leaderboardBotUpdateHandler: LeaderboardBotUpdateHandler;
  }
}

/**
 * Registers durable leaderboard Bot API outbox + integration services and worker.
 */
export const leaderboardTelegramPlugin = fp(async (app) => {
  const client = new HttpLeaderboardTelegramClient();
  const outbox = new LeaderboardTelegramOutboxService(
    app.prisma,
    LeaderboardTelegramOutboxService.createWakeFromQueue(app.queues.leaderboardTelegram)
  );
  const integration = new LeaderboardTelegramIntegrationService({
    prisma: app.prisma,
    encryptionKey: app.env.TELEGRAM_SESSION_ENCRYPTION_KEY,
    outbox,
    client,
    webhookBaseUrl: app.env.LEADERBOARD_BOT_WEBHOOK_BASE_URL ?? null
  });
  const processor = new LeaderboardTelegramProcessor({
    prisma: app.prisma,
    encryptionKey: app.env.TELEGRAM_SESSION_ENCRYPTION_KEY,
    outbox,
    client,
    logger: app.log
  });
  const botUpdateHandler = new LeaderboardBotUpdateHandler({
    prisma: app.prisma,
    client,
    encryptionKey: app.env.TELEGRAM_SESSION_ENCRYPTION_KEY,
    startTokenSecret: app.env.TELEGRAM_SESSION_ENCRYPTION_KEY || app.env.JWT_ACCESS_SECRET,
    outbox
  });

  app.decorate("leaderboardTelegramOutbox", outbox);
  app.decorate("leaderboardTelegramIntegration", integration);
  app.decorate("leaderboardTelegramProcessor", processor);
  app.decorate("leaderboardBotUpdateHandler", botUpdateHandler);

  startLeaderboardTelegramWorker(app);

  setTimeout(() => {
    void resumeLeaderboardTelegramOutboxSafely(outbox, app.log);
  }, 2_500);

  const maintenance = setInterval(() => {
    void resumeLeaderboardTelegramOutboxSafely(outbox, app.log);
  }, 60_000);
  maintenance.unref?.();

  // Local/dev polling only when webhook base URL is unset.
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  if (app.env.LEADERBOARD_BOT_POLLING && !app.env.LEADERBOARD_BOT_WEBHOOK_BASE_URL) {
    const offsets = new Map<string, number>();
    pollTimer = setInterval(() => {
      void (async () => {
        const rows = await app.prisma.leaderboardBotIntegration.findMany({
          where: { disconnectedAt: null },
          take: 20
        });
        for (const row of rows) {
          try {
            const token = decryptSecret(
              row.encryptedBotToken as unknown as EncryptedSecret,
              app.env.TELEGRAM_SESSION_ENCRYPTION_KEY
            );
            if (!client.getUpdates) continue;
            const updates = await client.getUpdates(token, {
              offset: offsets.get(row.id) ?? 0,
              timeout: 0,
              limit: 20
            });
            for (const update of updates) {
              offsets.set(row.id, update.updateId + 1);
              const inserted = await app.prisma.leaderboardTelegramUpdate
                .create({
                  data: {
                    botIntegrationId: row.id,
                    updateId: BigInt(update.updateId),
                    processedAt: new Date()
                  }
                })
                .then(() => true)
                .catch(() => false);
              if (!inserted) continue;
              const inbound = mapPollingUpdate(update);
              await botUpdateHandler.processUpdate(row, inbound);
            }
          } catch (error) {
            app.log.warn({ err: error, integrationId: row.id }, "Leaderboard bot poll failed");
          }
        }
      })();
    }, 5_000);
    pollTimer.unref?.();
    app.log.info("Leaderboard bot polling enabled (dev only)");
  }

  app.addHook("onClose", async () => {
    clearInterval(maintenance);
    if (pollTimer) clearInterval(pollTimer);
  });
});

function mapPollingUpdate(update: {
  readonly updateId: number;
  readonly message?: {
    readonly messageId: number;
    readonly text?: string;
    readonly date: number;
    readonly chat: { readonly id: number; readonly type: string };
    readonly from?: {
      readonly id: number;
      readonly isBot: boolean;
      readonly firstName: string;
      readonly lastName?: string;
      readonly username?: string;
    };
  };
  readonly callbackQuery?: {
    readonly id: string;
    readonly from: {
      readonly id: number;
      readonly isBot: boolean;
      readonly firstName: string;
      readonly lastName?: string;
      readonly username?: string;
    };
    readonly data?: string;
    readonly message?: {
      readonly messageId: number;
      readonly chat: { readonly id: number; readonly type: string };
    };
  };
}): import("./bot-update-handler").InboundTelegramUpdate {
  const mapped: import("./bot-update-handler").InboundTelegramUpdate = {
    update_id: update.updateId
  };

  if (update.message) {
    const msg = update.message;
    const from = msg.from
      ? {
          id: msg.from.id,
          is_bot: msg.from.isBot,
          first_name: msg.from.firstName,
          ...(msg.from.lastName !== undefined ? { last_name: msg.from.lastName } : {}),
          ...(msg.from.username !== undefined ? { username: msg.from.username } : {})
        }
      : undefined;
    return {
      ...mapped,
      message: {
        message_id: msg.messageId,
        date: msg.date,
        chat: { id: msg.chat.id, type: msg.chat.type },
        ...(msg.text !== undefined ? { text: msg.text } : {}),
        ...(from !== undefined ? { from } : {})
      },
      ...(update.callbackQuery
        ? { callback_query: mapPollingCallbackQuery(update.callbackQuery) }
        : {})
    };
  }

  if (update.callbackQuery) {
    return { ...mapped, callback_query: mapPollingCallbackQuery(update.callbackQuery) };
  }

  return mapped;
}

function mapPollingCallbackQuery(cq: {
  readonly id: string;
  readonly from: {
    readonly id: number;
    readonly isBot: boolean;
    readonly firstName: string;
    readonly lastName?: string;
    readonly username?: string;
  };
  readonly data?: string;
  readonly message?: {
    readonly messageId: number;
    readonly chat: { readonly id: number; readonly type: string };
  };
}): NonNullable<import("./bot-update-handler").InboundTelegramUpdate["callback_query"]> {
  const from = {
    id: cq.from.id,
    is_bot: cq.from.isBot,
    first_name: cq.from.firstName,
    ...(cq.from.lastName !== undefined ? { last_name: cq.from.lastName } : {}),
    ...(cq.from.username !== undefined ? { username: cq.from.username } : {})
  };
  return {
    id: cq.id,
    from,
    ...(cq.data !== undefined ? { data: cq.data } : {}),
    ...(cq.message
      ? {
          message: {
            message_id: cq.message.messageId,
            chat: { id: cq.message.chat.id, type: cq.message.chat.type }
          }
        }
      : {})
  };
}
