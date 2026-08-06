import { Queue } from "bullmq";
import fp from "fastify-plugin";

declare module "fastify" {
  interface FastifyInstance {
    queues: {
      auditEvents: Queue;
      telegramOutbound: Queue;
      pushNotifications: Queue;
    };
  }
}

/**
 * Registers BullMQ queues on the shared Redis connection for asynchronous platform work.
 */
export const queuesPlugin = fp(async (app) => {
  const connection = app.redis.duplicate();
  const auditEvents = new Queue("audit-events", { connection });
  const telegramOutbound = new Queue("telegram-outbound", { connection });
  const pushNotifications = new Queue("push-notifications", { connection });

  app.decorate("queues", { auditEvents, telegramOutbound, pushNotifications });
  app.addHook("onClose", async () => {
    await auditEvents.close();
    await telegramOutbound.close();
    await pushNotifications.close();
    await connection.quit();
  });
});
