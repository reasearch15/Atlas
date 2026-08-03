import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Builds route guards for Telegram account management.
 */
export function telegramManageGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN"])(request, reply);
    await app.requirePermission("telegram:account:manage")(request, reply);
  };
}

/**
 * Builds route guards for Telegram inbox reads. Staff can read inboxes for
 * conversations they may be assigned or claim CRM ownership over.
 */
export function telegramReadGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN", "STAFF"])(request, reply);
    await app.requirePermission("telegram:chat:read")(request, reply);
  };
}

/**
 * Builds route guards for Telegram message sending. Staff can reply within
 * conversations they own via CRM claim/assignment.
 */
export function telegramSendGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN", "STAFF"])(request, reply);
    await app.requirePermission("telegram:message:send")(request, reply);
  };
}
