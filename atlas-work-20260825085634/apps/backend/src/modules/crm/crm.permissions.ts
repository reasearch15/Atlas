import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Builds route guards for CRM reads (panel, notes list, tag catalog, inbox counts, assignees).
 */
export function crmReadGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN", "STAFF"])(request, reply);
    await app.requirePermission("crm:contact:read")(request, reply);
  };
}

/**
 * Builds route guards for claiming and releasing conversations.
 */
export function crmClaimGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN", "STAFF"])(request, reply);
    await app.requirePermission("crm:conversation:claim")(request, reply);
  };
}

/**
 * Builds route guards for Coadmin-only assignment (assign/reassign/force-release).
 */
export function crmAssignGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN"])(request, reply);
    await app.requirePermission("crm:conversation:assign")(request, reply);
  };
}

/**
 * Builds route guards for conversation status transitions.
 */
export function crmStatusGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN", "STAFF"])(request, reply);
    await app.requirePermission("crm:conversation:status")(request, reply);
  };
}

/**
 * Builds route guards for internal note authoring.
 */
export function crmNoteGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN", "STAFF"])(request, reply);
    await app.requirePermission("crm:note:write")(request, reply);
  };
}

/**
 * Builds route guards for applying/removing tags on a conversation.
 */
export function crmTagApplyGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN", "STAFF"])(request, reply);
    await app.requirePermission("crm:tag:apply")(request, reply);
  };
}

/**
 * Builds route guards for Coadmin-only tag catalog management (create/rename/archive).
 */
export function crmTagManageGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN"])(request, reply);
    await app.requirePermission("crm:tag:manage")(request, reply);
  };
}
