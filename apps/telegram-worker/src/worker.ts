import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { loadWorkerEnv } from "./env";
import { createCommandConsumer } from "./command-consumer";
import { startLiveSync, stopLiveSync } from "./live-sync";
import { startWorkerHeartbeat } from "./heartbeat";

/**
 * Starts the Telegram worker process and shuts down gracefully.
 */
async function main(): Promise<void> {
  const env = loadWorkerEnv();
  const prisma = new PrismaClient();
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const worker = createCommandConsumer(prisma, redis, env);
  const liveSync = startLiveSync(prisma, redis, env);
  const heartbeat = startWorkerHeartbeat(redis, env);

  const shutdown = async (): Promise<void> => {
    clearInterval(heartbeat);
    clearInterval(liveSync);
    await stopLiveSync();
    await worker.close();
    await redis.quit();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
