import type { FastifyInstance } from "fastify";
import { InternalMessagesService } from "./internal-messages.service";

/**
 * Registers internal Coadmin↔Staff messaging routes (never Telegram).
 */
export async function internalMessagesRoutes(app: FastifyInstance): Promise<void> {
  const service = new InternalMessagesService(app);

  app.get("/threads", { preHandler: [app.authenticate] }, async (request) => {
    return service.listThreads(request.user!);
  });

  app.get<{ Params: { staffId: string } }>(
    "/threads/:staffId",
    { preHandler: [app.authenticate] },
    async (request) => {
      return service.listMessages(request.user!, request.params.staffId);
    }
  );

  app.post<{ Params: { staffId: string } }>(
    "/threads/:staffId/messages",
    { preHandler: [app.authenticate] },
    async (request) => {
      return service.sendMessage(request.user!, request.params.staffId, request.body);
    }
  );

  app.post<{ Params: { id: string } }>(
    "/messages/:id/read",
    { preHandler: [app.authenticate] },
    async (request) => {
      return service.markRead(request.user!, request.params.id);
    }
  );
}
