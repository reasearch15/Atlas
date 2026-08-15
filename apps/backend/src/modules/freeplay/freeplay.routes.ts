import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { FreeplayService } from "./freeplay.service";
import { freeplayClaimGuard, freeplayReadGuard, freeplaySpinGuard } from "./freeplay.permissions";

const contactParamsSchema = z.object({ crmContactId: z.string().uuid() });
const claimParamsSchema = z.object({ claimId: z.string().uuid() });
const spinBodySchema = z.object({
  crmContactId: z.string().uuid(),
  chatId: z.string().uuid().nullable().optional(),
  idempotencyKey: z.string().trim().min(8).max(160)
});
const claimBodySchema = z.object({
  fulfillmentNote: z.string().trim().max(500).optional()
});

export async function freeplayRoutes(app: FastifyInstance): Promise<void> {
  const service = new FreeplayService(app);

  app.get("/player/:crmContactId/status", { preHandler: [freeplayReadGuard(app)] }, async (request) => {
    const params = contactParamsSchema.parse(request.params);
    return service.getPlayerStatus(request.user!, params.crmContactId);
  });

  app.get("/staff/:crmContactId/status", { preHandler: [freeplayReadGuard(app)] }, async (request) => {
    const params = contactParamsSchema.parse(request.params);
    return service.getStaffStatusForContact(request.user!, params.crmContactId);
  });

  app.post("/spin", { preHandler: [freeplaySpinGuard(app)] }, async (request) => {
    const body = spinBodySchema.parse(request.body);
    return service.spin(request.user!, {
      crmContactId: body.crmContactId,
      idempotencyKey: body.idempotencyKey,
      ...(body.chatId !== undefined ? { chatId: body.chatId } : {})
    });
  });

  app.post("/claims/:claimId/claim", { preHandler: [freeplayClaimGuard(app)] }, async (request) => {
    const params = claimParamsSchema.parse(request.params);
    const body = claimBodySchema.parse(request.body ?? {});
    return service.claim(request.user!, params.claimId, body.fulfillmentNote);
  });
}
