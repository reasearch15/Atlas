import type { FastifyInstance } from "fastify";
import { developerAppParamsSchema } from "./developer-app.schemas";
import { DeveloperAppService } from "./developer-app.service";

/**
 * Registers developer app management routes.
 */
export async function developerAppRoutes(app: FastifyInstance): Promise<void> {
  const guards = [app.authenticate, app.requireRole(["COADMIN"]), app.requirePermission("developer-app:read")];
  const manageGuards = [app.authenticate, app.requireRole(["COADMIN"]), app.requirePermission("developer-app:manage")];

  app.get("/", { preHandler: guards }, async (request) => {
    return new DeveloperAppService(request).list(request.user!);
  });

  app.post("/", { preHandler: manageGuards }, async (request) => {
    return new DeveloperAppService(request).create(request.user!, request.body, request.headers["x-workspace-id"] as string | undefined);
  });

  app.get("/:id", { preHandler: guards }, async (request) => {
    const params = developerAppParamsSchema.parse(request.params);
    return new DeveloperAppService(request).get(request.user!, params.id);
  });

  app.patch("/:id", { preHandler: manageGuards }, async (request) => {
    const params = developerAppParamsSchema.parse(request.params);
    return new DeveloperAppService(request).update(request.user!, params.id, request.body);
  });

  app.post("/:id/enable", { preHandler: manageGuards }, async (request) => {
    const params = developerAppParamsSchema.parse(request.params);
    return new DeveloperAppService(request).enable(request.user!, params.id);
  });

  app.post("/:id/disable", { preHandler: manageGuards }, async (request) => {
    const params = developerAppParamsSchema.parse(request.params);
    return new DeveloperAppService(request).disable(request.user!, params.id);
  });

  app.delete("/:id", { preHandler: manageGuards }, async (request) => {
    const params = developerAppParamsSchema.parse(request.params);
    return new DeveloperAppService(request).remove(request.user!, params.id);
  });
}
