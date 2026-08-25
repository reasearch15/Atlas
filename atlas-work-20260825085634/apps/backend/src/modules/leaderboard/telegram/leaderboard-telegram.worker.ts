import { Worker, type Job } from "bullmq";
import type { FastifyInstance } from "fastify";
import { LeaderboardTelegramProcessor } from "./leaderboard-telegram.processor";

export type LeaderboardTelegramJob = {
  readonly outboxId: string;
};

/**
 * Consumes BullMQ wake-ups and drives durable leaderboard_telegram_outbox rows.
 */
export function startLeaderboardTelegramWorker(app: FastifyInstance): Worker {
  const connection = app.redis.duplicate();
  const processor = app.leaderboardTelegramProcessor;

  const worker = new Worker<LeaderboardTelegramJob>(
    "leaderboard-telegram",
    async (job: Job<LeaderboardTelegramJob>) => {
      await processor.processJob(job.data.outboxId);
    },
    {
      connection,
      concurrency: 5
    }
  );

  worker.on("failed", (job, error) => {
    app.log.warn(
      { jobId: job?.id, outboxId: job?.data?.outboxId, error: error.message },
      "Leaderboard Telegram wake-up failed"
    );
  });

  app.addHook("onClose", async () => {
    await worker.close();
    await connection.quit();
  });

  return worker;
}
