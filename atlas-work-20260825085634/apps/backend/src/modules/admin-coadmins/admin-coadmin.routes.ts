import type { FastifyInstance } from "fastify";
import type { UserStatus } from "@prisma/client";
import { z } from "zod";
import { AdminCoadminService } from "./admin-coadmin.service";

const paramsSchema = z.object({ coadminId: z.string().uuid() });
const sessionParamsSchema = z.object({ coadminId: z.string().uuid(), sessionId: z.string().uuid() });
const querySchema = z.object({
  search: z.string().trim().optional(),
  status: z.enum(["ACTIVE", "PENDING_PASSWORD_CHANGE", "SUSPENDED", "ARCHIVED", "DISABLED"]).optional()
});

/**
 * Registers Platform Admin Coadmin management endpoints.
 */
export async function adminCoadminRoutes(app: FastifyInstance): Promise<void> {
  const service = new AdminCoadminService(app.prisma);
  const guards = [app.authenticate, app.requireRole(["PLATFORM_ADMIN"])];

  app.get("/", { preHandler: guards }, async (request) => {
    const parsed = querySchema.parse(request.query);
    const query: { search?: string; status?: UserStatus } = {};
    if (parsed.search) query.search = parsed.search;
    if (parsed.status) query.status = parsed.status;
    return service.list(query);
  });
  app.post("/", { preHandler: guards }, async (request) => service.create(request.user!, request.body));
  app.get("/:coadminId", { preHandler: guards }, async (request) => service.get(paramsSchema.parse(request.params).coadminId));
  app.post("/:coadminId/reset-password", { preHandler: guards }, async (request) =>
    service.resetPassword(request.user!, paramsSchema.parse(request.params).coadminId, request.body)
  );
  app.post("/:coadminId/suspend", { preHandler: guards }, async (request) => service.suspend(request.user!, paramsSchema.parse(request.params).coadminId));
  app.post("/:coadminId/reactivate", { preHandler: guards }, async (request) =>
    service.reactivate(request.user!, paramsSchema.parse(request.params).coadminId)
  );
  app.post("/:coadminId/archive", { preHandler: guards }, async (request) => service.archive(request.user!, paramsSchema.parse(request.params).coadminId));
  app.delete("/:coadminId/sessions", { preHandler: guards }, async (request) =>
    service.revokeAllSessions(request.user!, paramsSchema.parse(request.params).coadminId)
  );
  app.delete("/:coadminId/sessions/:sessionId", { preHandler: guards }, async (request) => {
    const params = sessionParamsSchema.parse(request.params);
    return service.revokeSession(request.user!, params.coadminId, params.sessionId);
  });
}
