import type { FastifyInstance } from "fastify";
import { AdminDashboardService } from "./admin-dashboard.service";

/**
 * Registers Platform Admin dashboard endpoints.
 */
export async function adminDashboardRoutes(app: FastifyInstance): Promise<void> {
  const service = new AdminDashboardService(app.prisma, app.redis, app.storage);

  app.get("/", { preHandler: [app.authenticate, app.requireRole(["PLATFORM_ADMIN"])] }, async (request) =>
    service.getDashboard(request.user!.id)
  );
}
