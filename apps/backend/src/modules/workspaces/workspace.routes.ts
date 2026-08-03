import type { FastifyInstance } from "fastify";
import { WorkspaceService } from "./workspace.service";

/**
 * Registers workspace management routes.
 */
export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  const service = new WorkspaceService(app.prisma);

  app.get("/", { preHandler: [app.authenticate, app.requirePermission("workspace:read")] }, async (request) =>
    service.list(request.user!)
  );

  app.post("/", { preHandler: [app.authenticate, app.requireRole(["PLATFORM_ADMIN"])] }, async (request) =>
    service.create(request.user!, request.body)
  );
}
