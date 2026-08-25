import type { FastifyInstance } from "fastify";
import { UserService } from "./user.service";

/**
 * Registers staff and coadmin management routes.
 */
export async function userRoutes(app: FastifyInstance): Promise<void> {
  const service = new UserService(app.prisma);

  app.get("/", { preHandler: [app.authenticate, app.requirePermission("staff:read")] }, async (request) =>
    service.list(request.user!)
  );

  app.post("/", { preHandler: [app.authenticate, app.requirePermission("staff:write")] }, async (request) =>
    service.createStaff(request.user!, request.body, request.ip, request.headers["user-agent"])
  );
}
