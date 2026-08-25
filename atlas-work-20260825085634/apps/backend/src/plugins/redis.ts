import fp from "fastify-plugin";
import Redis from "ioredis";
import type { Env } from "../config/env";

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis;
  }
}

/**
 * Registers a Redis connection for shared infrastructure such as queues and presence.
 */
export const redisPlugin = fp<{ env: Env }>(async (app, options) => {
  const redis = new Redis(options.env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true
  });

  app.decorate("redis", redis);
  app.addHook("onClose", async () => {
    await redis.quit();
  });
});
