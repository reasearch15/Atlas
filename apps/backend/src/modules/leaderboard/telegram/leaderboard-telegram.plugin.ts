import fp from "fastify-plugin";
import { LeaderboardTelegramIntegrationService } from "./leaderboard-telegram.integration-service";
import { LeaderboardTelegramOutboxService } from "./leaderboard-telegram.outbox";
import { LeaderboardTelegramProcessor } from "./leaderboard-telegram.processor";
import { startLeaderboardTelegramWorker } from "./leaderboard-telegram.worker";

declare module "fastify" {
  interface FastifyInstance {
    leaderboardTelegramOutbox: LeaderboardTelegramOutboxService;
    leaderboardTelegramIntegration: LeaderboardTelegramIntegrationService;
    leaderboardTelegramProcessor: LeaderboardTelegramProcessor;
  }
}

/**
 * Registers durable leaderboard Bot API outbox + integration services and worker.
 */
export const leaderboardTelegramPlugin = fp(async (app) => {
  const outbox = new LeaderboardTelegramOutboxService(
    app.prisma,
    LeaderboardTelegramOutboxService.createWakeFromQueue(app.queues.leaderboardTelegram)
  );
  const integration = new LeaderboardTelegramIntegrationService({
    prisma: app.prisma,
    encryptionKey: app.env.TELEGRAM_SESSION_ENCRYPTION_KEY,
    outbox
  });
  const processor = new LeaderboardTelegramProcessor({
    prisma: app.prisma,
    encryptionKey: app.env.TELEGRAM_SESSION_ENCRYPTION_KEY,
    outbox,
    logger: app.log
  });

  app.decorate("leaderboardTelegramOutbox", outbox);
  app.decorate("leaderboardTelegramIntegration", integration);
  app.decorate("leaderboardTelegramProcessor", processor);

  startLeaderboardTelegramWorker(app);

  setTimeout(() => {
    void outbox.resumePending().then((count) => {
      if (count > 0) app.log.info({ count }, "Resumed pending leaderboard Telegram outbox jobs");
    });
  }, 2_500);

  const maintenance = setInterval(() => {
    void outbox.resumePending();
  }, 60_000);
  maintenance.unref?.();

  app.addHook("onClose", async () => {
    clearInterval(maintenance);
  });
});
