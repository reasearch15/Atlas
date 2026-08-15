import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export function freeplayReadGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN", "STAFF"])(request, reply);
    await app.requirePermission("freeplay:read")(request, reply);
  };
}

export function freeplaySpinGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN", "STAFF"])(request, reply);
    await app.requirePermission("freeplay:spin")(request, reply);
  };
}

export function freeplayClaimGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN", "STAFF"])(request, reply);
    await app.requirePermission("freeplay:claim")(request, reply);
  };
}
