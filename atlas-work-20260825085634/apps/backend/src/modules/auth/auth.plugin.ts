import fp from "fastify-plugin";
import type { FastifyReply, FastifyRequest } from "fastify";
import { hasPermission, type Permission, type Role } from "@atlas/shared";
import type { Env } from "../../config/env";
import { forbidden, unauthorized } from "../../utils/errors";
import { AdminAuthService } from "../admin-auth/admin-auth.service";
import { EmailService } from "../email/EmailService";
import { assertNoOrphanPlatformAdminUsers } from "../../scripts/admin-orphan-cleanup.service";
import { AuthService } from "./auth.service";
import "./auth.types";

declare module "fastify" {
  interface FastifyInstance {
    auth: AuthService;
    adminAuth: AdminAuthService;
    email: EmailService;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireRole: (roles: readonly Role[]) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePermission: (permission: Permission) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * Registers authentication services and reusable route guards.
 */
export const authPlugin = fp<{ env: Env }>(async (app, options) => {
  await assertNoOrphanPlatformAdminUsers(app.prisma);
  const auth = new AuthService(app.prisma, options.env);
  const email = new EmailService(options.env, app.log);
  await email.verify();
  const adminAuth = new AdminAuthService(app.prisma, app.redis, options.env, email);
  app.decorate("auth", auth);
  app.decorate("adminAuth", adminAuth);
  app.decorate("email", email);

  app.decorate("authenticate", async (request) => {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (!token) {
      throw unauthorized();
    }
    request.user = await auth.authenticate(token);
  });

  app.decorate("requireRole", (roles) => async (request) => {
    if (!request.user) {
      throw unauthorized();
    }
    if (!roles.includes(request.user.role)) {
      throw forbidden();
    }
  });

  app.decorate("requirePermission", (permission) => async (request) => {
    if (!request.user) {
      throw unauthorized();
    }
    if (!hasPermission(request.user.role, permission)) {
      throw forbidden();
    }
  });
});
