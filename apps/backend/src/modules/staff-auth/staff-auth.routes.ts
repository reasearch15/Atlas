import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CoadminAuthService } from "../coadmin-auth/coadmin-auth.service";

const deviceParamsSchema = z.object({ deviceId: z.string().uuid() });

/**
 * Registers Staff authentication and device endpoints.
 */
export async function staffAuthRoutes(app: FastifyInstance): Promise<void> {
  const service = new CoadminAuthService(app.prisma, app.redis, app.env, "STAFF");
  const guards = [app.authenticate, app.requireRole(["STAFF"])];

  app.post("/login", async (request, reply) => service.login(request, reply));
  app.post("/change-password", async (request, reply) => service.changePassword(request, reply));
  app.post("/refresh", async (request, reply) => service.refresh(request, reply));
  app.post("/logout", { preHandler: guards }, async (request, reply) => service.logout(request, reply));
  app.get("/me", { preHandler: guards }, async (request) => service.me(request.user!));
  app.get("/devices", { preHandler: guards }, async (request) => service.devices(request.user!));
  app.delete("/devices", { preHandler: guards }, async (request, reply) => service.revokeAllDevices(request, reply));
  app.delete("/devices/:deviceId", { preHandler: guards }, async (request) => service.revokeDevice(request, deviceParamsSchema.parse(request.params).deviceId));
}
