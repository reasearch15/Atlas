import type { FastifyInstance } from "fastify";
import { z } from "zod";

const sessionParamsSchema = z.object({ sessionId: z.string().uuid() });

/**
 * Registers authentication endpoints for login, refresh, logout, and session introspection.
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/login", async (request, reply) => app.auth.login(request, reply));
  app.post("/refresh", async (request, reply) => app.auth.refresh(request, reply));
  app.post("/logout", { preHandler: [app.authenticate] }, async (request, reply) => app.auth.logout(request, reply));
  app.get("/me", { preHandler: [app.authenticate] }, async (request) => app.auth.me(request.user!));
  app.delete(
    "/sessions",
    { preHandler: [app.authenticate, app.requirePermission("session:revoke")] },
    async (request, reply) => app.auth.revokeAllSessions(request, reply)
  );
  app.delete(
    "/sessions/:sessionId",
    { preHandler: [app.authenticate, app.requirePermission("session:revoke")] },
    async (request) => {
      const params = sessionParamsSchema.parse(request.params);
      return app.auth.revokeSession(request, params.sessionId);
    }
  );
}
