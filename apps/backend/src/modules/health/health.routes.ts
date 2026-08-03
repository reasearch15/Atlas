import type { FastifyInstance } from "fastify";

/**
 * Registers operational health checks for load balancers and uptime monitors.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    await app.prisma.$queryRaw`SELECT 1`;
    await app.redis.ping();
    await app.storage.assertReady();
    return { status: "ok", timestamp: new Date().toISOString() };
  });
}
