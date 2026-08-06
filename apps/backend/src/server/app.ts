import Fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import type { Env } from "../config/env";
import { errorPlugin } from "../plugins/errors";
import { prismaPlugin } from "../plugins/prisma";
import { queuesPlugin } from "../plugins/queues";
import { realtimePlugin } from "../plugins/realtime";
import { redisPlugin } from "../plugins/redis";
import { storagePlugin } from "../plugins/storage";
import { auditRoutes } from "../modules/audit/audit.routes";
import { adminCoadminRoutes } from "../modules/admin-coadmins/admin-coadmin.routes";
import { adminDashboardRoutes } from "../modules/admin-dashboard/admin-dashboard.routes";
import { adminAuthRoutes } from "../modules/admin-auth/admin-auth.routes";
import { authPlugin } from "../modules/auth/auth.plugin";
import { authRoutes } from "../modules/auth/auth.routes";
import { coadminAuthRoutes } from "../modules/coadmin-auth/coadmin-auth.routes";
import { crmRoutes } from "../modules/crm/crm.routes";
import { dashboardRoutes } from "../modules/dashboard/dashboard.routes";
import { developerAppRoutes } from "../modules/developer-apps/developer-app.routes";
import { healthRoutes } from "../modules/health/health.routes";
import { notificationPlugin } from "../modules/notifications/notification.plugin";
import { notificationRoutes } from "../modules/notifications/notification.routes";
import { staffAuthRoutes } from "../modules/staff-auth/staff-auth.routes";
import { staffManagementRoutes } from "../modules/staff/staff-management.routes";
import { internalMessagesRoutes } from "../modules/internal-messages/internal-messages.routes";
import { telegramRoutes } from "../modules/telegram/telegram.routes";
import { userRoutes } from "../modules/users/user.routes";
import { websocketRoutes } from "../modules/websocket/websocket.routes";
import { workspaceRoutes } from "../modules/workspaces/workspace.routes";

declare module "fastify" {
  interface FastifyInstance {
    env: Env;
  }
}

/** Max outbound media upload accepted by the same-origin proxy (matches shared schema). */
const MEDIA_UPLOAD_BODY_LIMIT = 105 * 1024 * 1024;

/**
 * Builds the Fastify application with plugins, infrastructure, and versioned routes.
 */
export async function buildApp(env: Env) {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === "production" ? "info" : "debug"
    },
    // Nginx terminates TLS and forwards X-Forwarded-For / X-Real-IP; without this,
    // request.ip collapses to 127.0.0.1 and staff login rate limits share one bucket.
    trustProxy: true,
    genReqId: () => crypto.randomUUID(),
    bodyLimit: MEDIA_UPLOAD_BODY_LIMIT
  });
  app.decorate("env", env);

  try {
    await app.register(errorPlugin);
    await app.register(helmet);
    await app.register(cors, { origin: env.FRONTEND_ORIGIN, credentials: true });
    await app.register(cookie);
    await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });
    await app.register(websocket);
    await app.register(prismaPlugin);
    await app.register(redisPlugin, { env });
    await app.register(queuesPlugin);
    await app.register(storagePlugin, { env });
    await app.register(realtimePlugin);
    await app.register(authPlugin, { env });
    await app.register(notificationPlugin);

    // Pass media upload bodies through as streams (do not buffer into JSON/string).
    const passStream = (_request: unknown, payload: NodeJS.ReadableStream, done: (err: null, body: NodeJS.ReadableStream) => void) => {
      done(null, payload);
    };
    app.addContentTypeParser(/^image\/.*/, passStream);
    app.addContentTypeParser(/^video\/.*/, passStream);
    app.addContentTypeParser(/^audio\/.*/, passStream);
    app.addContentTypeParser("application/octet-stream", passStream);
    app.addContentTypeParser("application/pdf", passStream);
    app.addContentTypeParser("application/zip", passStream);
    app.addContentTypeParser("application/x-tgsticker", passStream);

    await app.register(healthRoutes);
    await app.register(adminAuthRoutes, { prefix: "/api/admin-auth" });
    await app.register(adminDashboardRoutes, { prefix: "/api/admin/dashboard" });
    await app.register(adminCoadminRoutes, { prefix: "/api/admin/coadmins" });
    await app.register(coadminAuthRoutes, { prefix: "/api/coadmin-auth" });
    await app.register(staffAuthRoutes, { prefix: "/api/staff-auth" });
    await app.register(staffManagementRoutes, { prefix: "/api/staff" });
    await app.register(internalMessagesRoutes, { prefix: "/api/internal-messages" });
    await app.register(authRoutes, { prefix: "/api/auth" });
    await app.register(workspaceRoutes, { prefix: "/api/workspaces" });
    await app.register(userRoutes, { prefix: "/api/users" });
    await app.register(auditRoutes, { prefix: "/api/audit-logs" });
    await app.register(dashboardRoutes, { prefix: "/api/dashboard" });
    await app.register(developerAppRoutes, { prefix: "/api/developer-apps" });
    await app.register(telegramRoutes, { prefix: "/api/telegram" });
    await app.register(crmRoutes, { prefix: "/api/crm" });
    await app.register(notificationRoutes, { prefix: "/api/notifications" });
    await app.register(websocketRoutes);
  } catch (error) {
    await app.close();
    throw error;
  }

  return app;
}
