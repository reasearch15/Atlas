import type { FastifyInstance } from "fastify";
import {
  deletePushDeviceSchema,
  notificationAckSchema,
  notificationActionSchema,
  notificationHistoryQuerySchema,
  notificationPreferencesSchema,
  refreshPushDeviceSchema,
  registerPushDeviceSchema
} from "@atlas/shared";
import { z } from "zod";

const testBodySchema = z
  .object({
    deviceTokenId: z.string().uuid().optional()
  })
  .optional();

/**
 * Device registration, preference, history, ack/actions, and admin notification APIs.
 */
export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  const tenantGuards = [app.authenticate, app.requireRole(["COADMIN", "STAFF"] as const)];

  app.get("/web-config", { preHandler: tenantGuards }, async () => {
    return app.notifications.webConfig();
  });

  app.post("/devices", { preHandler: tenantGuards }, async (request) => {
    const body = registerPushDeviceSchema.parse(request.body);
    const device = await app.notifications.devices.register(request.user!, body);
    // Device came online — deliver anything held while offline / unregistered.
    void app.notifications.reconcileForUser(request.user!);
    return device;
  });

  app.post("/devices/refresh", { preHandler: tenantGuards }, async (request) => {
    const body = refreshPushDeviceSchema.parse(request.body);
    const device = await app.notifications.devices.refresh(request.user!, body);
    void app.notifications.reconcileForUser(request.user!);
    return device;
  });

  app.delete("/devices", { preHandler: tenantGuards }, async (request) => {
    const body = deletePushDeviceSchema.parse(request.body);
    return app.notifications.devices.unregister(request.user!, body.token);
  });

  app.get("/devices", { preHandler: tenantGuards }, async (request) => {
    return app.notifications.devices.listForUser(request.user!);
  });

  app.get("/preferences", { preHandler: tenantGuards }, async (request) => {
    return app.notifications.preferences.get(request.user!);
  });

  app.put("/preferences", { preHandler: tenantGuards }, async (request) => {
    const body = notificationPreferencesSchema.parse(request.body);
    return app.notifications.preferences.update(request.user!, body);
  });

  app.post("/test", { preHandler: tenantGuards }, async (request) => {
    const body = testBodySchema.parse(request.body) ?? {};
    return app.notifications.notifyTest(request.user!, {
      workspaceId: request.user!.workspaceId!,
      userId: request.user!.id,
      ...(body.deviceTokenId ? { deviceTokenId: body.deviceTokenId } : {})
    });
  });

  app.get("/history", { preHandler: tenantGuards }, async (request) => {
    const query = notificationHistoryQuerySchema.parse(request.query);
    return app.notifications.listHistory(request.user!, {
      status: query.status,
      limit: query.limit,
      ...(query.cursor ? { cursor: query.cursor } : {})
    });
  });

  app.post("/reconcile", { preHandler: tenantGuards }, async (request) => {
    return app.notifications.reconcileForUser(request.user!);
  });

  app.post("/:id/ack", { preHandler: tenantGuards }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = notificationAckSchema.parse(request.body);
    return app.notifications.acknowledge(request.user!, params.id, body.event);
  });

  app.post("/:id/actions", { preHandler: tenantGuards }, async (request) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = notificationActionSchema.parse(request.body);
    return app.notifications.performAction(request.user!, params.id, body.action);
  });

  app.get(
    "/admin/devices",
    { preHandler: [app.authenticate, app.requireRole(["COADMIN", "PLATFORM_ADMIN"] as const)] },
    async (request) => {
      const workspaceId =
        request.user!.role === "PLATFORM_ADMIN"
          ? z.object({ workspaceId: z.string().uuid() }).parse(request.query).workspaceId
          : request.user!.workspaceId!;
      return app.notifications.devices.listForWorkspaceAdmin(request.user!, workspaceId);
    }
  );

  app.get(
    "/admin/stats",
    { preHandler: [app.authenticate, app.requireRole(["COADMIN", "PLATFORM_ADMIN"] as const)] },
    async (request) => {
      const workspaceId =
        request.user!.role === "PLATFORM_ADMIN"
          ? z.object({ workspaceId: z.string().uuid().optional() }).parse(request.query).workspaceId
          : request.user!.workspaceId!;
      return app.notifications.adminStats(workspaceId);
    }
  );

  app.get(
    "/admin/analytics",
    { preHandler: [app.authenticate, app.requireRole(["COADMIN", "PLATFORM_ADMIN"] as const)] },
    async (request) => {
      const query = z
        .object({
          workspaceId: z.string().uuid().optional(),
          windowHours: z.coerce.number().int().min(1).max(720).default(24)
        })
        .parse(request.query);
      const workspaceId =
        request.user!.role === "PLATFORM_ADMIN" ? query.workspaceId : request.user!.workspaceId!;
      return app.notifications.analytics(workspaceId, query.windowHours);
    }
  );

  app.post(
    "/admin/test",
    { preHandler: [app.authenticate, app.requireRole(["COADMIN", "PLATFORM_ADMIN"] as const)] },
    async (request) => {
      const body = z
        .object({
          userId: z.string().uuid().optional(),
          deviceTokenId: z.string().uuid().optional()
        })
        .parse(request.body ?? {});
      const targetUserId = body.userId ?? request.user!.id;
      const workspaceId = request.user!.workspaceId;
      if (!workspaceId && request.user!.role !== "PLATFORM_ADMIN") {
        return { queued: 0 };
      }
      const resolvedWorkspace =
        workspaceId ??
        (
          await app.prisma.user.findUnique({
            where: { id: targetUserId },
            select: { workspaceId: true }
          })
        )?.workspaceId;
      if (!resolvedWorkspace) return { queued: 0 };
      return app.notifications.notifyTest(request.user!, {
        workspaceId: resolvedWorkspace,
        userId: targetUserId,
        ...(body.deviceTokenId ? { deviceTokenId: body.deviceTokenId } : {})
      });
    }
  );
}
