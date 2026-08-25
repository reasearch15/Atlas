import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";
import { auditQuerySchema, isPlatformRole, type AuditLogDto } from "@atlas/shared";

/**
 * Registers tenant-scoped audit log reads.
 */
export async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.get("/", { preHandler: [app.authenticate, app.requirePermission("audit:read")] }, async (request) => {
    const query = auditQuerySchema.parse(request.query);
    type AuditWithActor = Prisma.AuditLogGetPayload<{ include: { actor: { select: { email: true } } } }>;
    const args: Prisma.AuditLogFindManyArgs = {
      where: isPlatformRole(request.user!.role) ? {} : { workspaceId: request.user!.workspaceId },
      orderBy: { createdAt: "desc" },
      take: query.limit,
      skip: query.cursor ? 1 : 0,
      include: { actor: { select: { email: true } } }
    };
    if (query.cursor) {
      args.cursor = { id: query.cursor };
    }

    const logs = (await app.prisma.auditLog.findMany(args)) as AuditWithActor[];

    return logs.map(
      (log): AuditLogDto => ({
        id: log.id,
        action: log.action,
        actorEmail: log.actor?.email ?? "system",
        workspaceId: log.workspaceId,
        createdAt: log.createdAt.toISOString(),
        metadata: typeof log.metadata === "object" && log.metadata !== null ? (log.metadata as Record<string, unknown>) : {}
      })
    );
  });
}
