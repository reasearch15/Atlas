import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { StaffManagementService } from "./staff-management.service";

const paramsSchema = z.object({ staffId: z.string().uuid() });
const sessionParamsSchema = z.object({ staffId: z.string().uuid(), sessionId: z.string().uuid() });

/**
 * Registers Coadmin-only Staff management endpoints.
 */
export async function staffManagementRoutes(app: FastifyInstance): Promise<void> {
  const service = new StaffManagementService(app.prisma);
  const guards = [app.authenticate, app.requireRole(["COADMIN"])];

  app.get("/", { preHandler: guards }, async (request) => service.list(request.user!));
  app.post("/", { preHandler: guards }, async (request) => service.create(request.user!, request.body));
  app.get("/:staffId", { preHandler: guards }, async (request) => service.get(request.user!, paramsSchema.parse(request.params).staffId));
  app.post("/:staffId/reset-password", { preHandler: guards }, async (request) =>
    service.resetPassword(request.user!, paramsSchema.parse(request.params).staffId, request.body)
  );
  app.post("/:staffId/suspend", { preHandler: guards }, async (request) => service.suspend(request.user!, paramsSchema.parse(request.params).staffId));
  app.post("/:staffId/reactivate", { preHandler: guards }, async (request) => service.reactivate(request.user!, paramsSchema.parse(request.params).staffId));
  app.post("/:staffId/archive", { preHandler: guards }, async (request) => service.archive(request.user!, paramsSchema.parse(request.params).staffId));
  app.delete("/:staffId/sessions", { preHandler: guards }, async (request) => service.revokeAllSessions(request.user!, paramsSchema.parse(request.params).staffId));
  app.delete("/:staffId/sessions/:sessionId", { preHandler: guards }, async (request) => {
    const params = sessionParamsSchema.parse(request.params);
    return service.revokeSession(request.user!, params.staffId, params.sessionId);
  });
}
