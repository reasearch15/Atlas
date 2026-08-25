import type { FastifyInstance } from "fastify";
import { z } from "zod";

const deviceParamsSchema = z.object({ deviceId: z.string().uuid() });

/**
 * Registers Platform Admin authentication and trusted-device endpoints.
 */
export async function adminAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post("/login", async (request, reply) => app.adminAuth.login(request, reply));
  app.post("/verify-device", async (request, reply) => app.adminAuth.verifyDevice(request, reply));
  app.post("/resend-code", async (request) => app.adminAuth.resendCode(request));
  app.post("/refresh", async (request, reply) => app.adminAuth.refresh(request, reply));
  app.post(
    "/logout",
    { preHandler: [app.authenticate, app.requireRole(["PLATFORM_ADMIN"])] },
    async (request, reply) => app.adminAuth.logout(request, reply)
  );
  app.get("/me", { preHandler: [app.authenticate, app.requireRole(["PLATFORM_ADMIN"])] }, async (request) => app.adminAuth.me(request.user!));
  app.get(
    "/devices",
    { preHandler: [app.authenticate, app.requireRole(["PLATFORM_ADMIN"])] },
    async (request) => app.adminAuth.devices(request.user!)
  );
  app.delete(
    "/devices",
    { preHandler: [app.authenticate, app.requireRole(["PLATFORM_ADMIN"])] },
    async (request, reply) => app.adminAuth.revokeAllDevices(request, reply)
  );
  app.delete(
    "/devices/:deviceId",
    { preHandler: [app.authenticate, app.requireRole(["PLATFORM_ADMIN"])] },
    async (request) => {
      const params = deviceParamsSchema.parse(request.params);
      return app.adminAuth.revokeDevice(request, params.deviceId);
    }
  );
}
