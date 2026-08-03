import type { FastifyInstance } from "fastify";
import {
  assignBodySchema,
  chatTagBodySchema,
  crmChatParamsSchema,
  crmChatTagParamsSchema,
  crmNoteParamsSchema,
  crmTagParamsSchema,
  noteCreateBodySchema,
  noteUpdateBodySchema,
  statusBodySchema,
  tagCreateBodySchema,
  tagUpdateBodySchema
} from "./crm.schemas";
import {
  crmAssignGuard,
  crmClaimGuard,
  crmNoteGuard,
  crmReadGuard,
  crmStatusGuard,
  crmTagApplyGuard,
  crmTagManageGuard
} from "./crm.permissions";
import { CrmService } from "./crm.service";

/**
 * Registers CRM conversation, tag, note, and inbox routes.
 */
export async function crmRoutes(app: FastifyInstance): Promise<void> {
  const service = new CrmService(app);

  app.post("/chats/:chatId/claim", { preHandler: [crmClaimGuard(app)] }, async (request) => {
    const params = crmChatParamsSchema.parse(request.params);
    await service.claim(request.user!, params.chatId);
    return service.getPanel(request.user!, params.chatId);
  });

  app.post("/chats/:chatId/release", { preHandler: [crmClaimGuard(app)] }, async (request) => {
    const params = crmChatParamsSchema.parse(request.params);
    await service.release(request.user!, params.chatId);
    return service.getPanel(request.user!, params.chatId);
  });

  app.post("/chats/:chatId/assign", { preHandler: [crmAssignGuard(app)] }, async (request) => {
    const params = crmChatParamsSchema.parse(request.params);
    const input = assignBodySchema.parse(request.body);
    await service.assign(request.user!, params.chatId, input.assigneeUserId);
    return service.getPanel(request.user!, params.chatId);
  });

  app.post("/chats/:chatId/status", { preHandler: [crmStatusGuard(app)] }, async (request) => {
    const params = crmChatParamsSchema.parse(request.params);
    const input = statusBodySchema.parse(request.body);
    await service.setStatus(request.user!, params.chatId, input.status);
    return service.getPanel(request.user!, params.chatId);
  });

  app.get("/chats/:chatId/panel", { preHandler: [crmReadGuard(app)] }, async (request) => {
    const params = crmChatParamsSchema.parse(request.params);
    return service.getPanel(request.user!, params.chatId);
  });

  app.get("/chats/:chatId/notes", { preHandler: [crmReadGuard(app)] }, async (request) => {
    const params = crmChatParamsSchema.parse(request.params);
    return service.listNotes(request.user!, params.chatId);
  });

  app.post("/chats/:chatId/notes", { preHandler: [crmNoteGuard(app)] }, async (request) => {
    const params = crmChatParamsSchema.parse(request.params);
    const input = noteCreateBodySchema.parse(request.body);
    return service.createNote(request.user!, params.chatId, input.body);
  });

  app.patch("/chats/:chatId/notes/:noteId", { preHandler: [crmNoteGuard(app)] }, async (request) => {
    const params = crmNoteParamsSchema.parse(request.params);
    const input = noteUpdateBodySchema.parse(request.body);
    return service.updateNote(request.user!, params.chatId, params.noteId, input.body);
  });

  app.post("/chats/:chatId/tags", { preHandler: [crmTagApplyGuard(app)] }, async (request) => {
    const params = crmChatParamsSchema.parse(request.params);
    const input = chatTagBodySchema.parse(request.body);
    await service.addTag(request.user!, params.chatId, input.tagId);
    return service.getPanel(request.user!, params.chatId);
  });

  app.delete("/chats/:chatId/tags/:tagId", { preHandler: [crmTagApplyGuard(app)] }, async (request) => {
    const params = crmChatTagParamsSchema.parse(request.params);
    await service.removeTag(request.user!, params.chatId, params.tagId);
    return service.getPanel(request.user!, params.chatId);
  });

  app.get("/tags", { preHandler: [crmReadGuard(app)] }, async (request) => service.listTags(request.user!));

  app.post("/tags", { preHandler: [crmTagManageGuard(app)] }, async (request) => {
    const input = tagCreateBodySchema.parse(request.body);
    return service.createTag(request.user!, input);
  });

  app.patch("/tags/:tagId", { preHandler: [crmTagManageGuard(app)] }, async (request) => {
    const params = crmTagParamsSchema.parse(request.params);
    const input = tagUpdateBodySchema.parse(request.body);
    return service.updateTag(request.user!, params.tagId, input);
  });

  app.get("/inbox/counts", { preHandler: [crmReadGuard(app)] }, async (request) => service.getInboxCounts(request.user!));

  app.get("/assignees", { preHandler: [crmReadGuard(app)] }, async (request) => service.listAssignees(request.user!));
}
