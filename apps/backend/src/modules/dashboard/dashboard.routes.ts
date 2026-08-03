import type { FastifyInstance } from "fastify";
import { isPlatformRole, type DashboardStats } from "@atlas/shared";

/**
 * Registers aggregate dashboard metrics for the authenticated tenant context.
 */
export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/stats", { preHandler: [app.authenticate, app.requirePermission("dashboard:read")] }, async (request) => {
    const workspaceScoped = isPlatformRole(request.user!.role) ? {} : { workspaceId: request.user!.workspaceId };
    const [workspaceCount, staffCount, activeSessionCount, auditEventCount] = await Promise.all([
      isPlatformRole(request.user!.role) ? app.prisma.workspace.count() : Promise.resolve(1),
      app.prisma.user.count({ where: workspaceScoped }),
      app.prisma.session.count({ where: { ...workspaceScoped, revokedAt: null, expiresAt: { gt: new Date() } } }),
      app.prisma.auditLog.count({ where: workspaceScoped })
    ]);

    return {
      workspaceCount,
      staffCount,
      activeSessionCount,
      auditEventCount
    } satisfies DashboardStats;
  });
}
