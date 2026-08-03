import type { FastifyInstance } from "fastify";
import {
  telegramAccountParamsSchema,
  telegramChatIdParamsSchema,
  telegramChatParamsSchema,
  telegramMediaVariantQuerySchema,
  telegramMessageIdParamsSchema
} from "./telegram.schemas";
import { telegramManageGuard, telegramReadGuard, telegramSendGuard } from "./telegram.permissions";
import { TelegramService } from "./telegram.service";
import { TelegramMediaProxyService } from "./telegram-media-proxy.service";

/**
 * Registers Telegram account, inbox, message, and operational health routes.
 */
export async function telegramRoutes(app: FastifyInstance): Promise<void> {
  const service = new TelegramService(app);
  const mediaProxy = new TelegramMediaProxyService(app);
  const authRateLimit = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

  app.post("/accounts", { preHandler: [telegramManageGuard(app)] }, async (request) =>
    service.createAccount(request.user!, request.body, request.headers["x-workspace-id"] as string | undefined)
  );

  app.get("/accounts", { preHandler: [telegramReadGuard(app)] }, async (request) =>
    service.listAccounts(request.user!)
  );

  app.get("/accounts/:accountId", { preHandler: [telegramReadGuard(app)] }, async (request) => {
    const params = telegramAccountParamsSchema.parse(request.params);
    return service.getAccount(request.user!, params.accountId);
  });

  app.post("/accounts/:accountId/start-auth", { ...authRateLimit, preHandler: [telegramManageGuard(app)] }, async (request) => {
    const params = telegramAccountParamsSchema.parse(request.params);
    return service.startAuthorization(request.user!, params.accountId);
  });

  app.post("/accounts/:accountId/submit-phone", { ...authRateLimit, preHandler: [telegramManageGuard(app)] }, async (request) => {
    const params = telegramAccountParamsSchema.parse(request.params);
    return service.submitPhone(request.user!, params.accountId, request.body);
  });

  app.post("/accounts/:accountId/submit-code", { ...authRateLimit, preHandler: [telegramManageGuard(app)] }, async (request) => {
    const params = telegramAccountParamsSchema.parse(request.params);
    return service.submitCode(request.user!, params.accountId, request.body);
  });

  app.post("/accounts/:accountId/submit-password", { ...authRateLimit, preHandler: [telegramManageGuard(app)] }, async (request) => {
    const params = telegramAccountParamsSchema.parse(request.params);
    return service.submitPassword(request.user!, params.accountId, request.body);
  });

  app.post("/accounts/:accountId/cancel-auth", { preHandler: [telegramManageGuard(app)] }, async (request) => {
    const params = telegramAccountParamsSchema.parse(request.params);
    return service.cancelAuthorization(request.user!, params.accountId);
  });

  app.post("/accounts/:accountId/reauthorize", { preHandler: [telegramManageGuard(app)] }, async (request) => {
    const params = telegramAccountParamsSchema.parse(request.params);
    return service.reauthorize(request.user!, params.accountId);
  });

  app.post("/accounts/:accountId/restart-authorization", { ...authRateLimit, preHandler: [telegramManageGuard(app)] }, async (request) => {
    const params = telegramAccountParamsSchema.parse(request.params);
    return service.restartAuthorization(request.user!, params.accountId);
  });

  app.delete("/accounts/:accountId", { preHandler: [telegramManageGuard(app)] }, async (request) => {
    const params = telegramAccountParamsSchema.parse(request.params);
    return service.disconnect(request.user!, params.accountId);
  });

  app.post("/accounts/:accountId/permanent-delete", { preHandler: [telegramManageGuard(app)] }, async (request) => {
    const params = telegramAccountParamsSchema.parse(request.params);
    return service.permanentDelete(request.user!, params.accountId, request.body);
  });

  app.get("/accounts/:accountId/chats", { preHandler: [telegramReadGuard(app)] }, async (request) => {
    const params = telegramAccountParamsSchema.parse(request.params);
    return service.listChats(request.user!, params.accountId);
  });

  app.post("/accounts/:accountId/chats/refresh-metadata", { preHandler: [telegramManageGuard(app)] }, async (request) => {
    const params = telegramAccountParamsSchema.parse(request.params);
    return service.refreshChatMetadata(request.user!, params.accountId);
  });

  app.get("/accounts/:accountId/chats/refresh-metadata", { preHandler: [telegramReadGuard(app)] }, async (request) => {
    const params = telegramAccountParamsSchema.parse(request.params);
    return service.getChatIdentityBackfillResult(request.user!, params.accountId);
  });

  app.get("/accounts/:accountId/chats/:chatId/messages", { preHandler: [telegramReadGuard(app)] }, async (request) => {
    const params = telegramChatParamsSchema.parse(request.params);
    return service.listMessages(request.user!, params.accountId, params.chatId);
  });

  app.get("/chats/:chatId/messages", { preHandler: [telegramReadGuard(app)] }, async (request) => {
    const params = telegramChatIdParamsSchema.parse(request.params);
    return service.listMessagesByChatId(request.user!, params.chatId);
  });

  app.get("/messages/:messageId/media", { preHandler: [] }, async (request, reply) => {
    const params = telegramMessageIdParamsSchema.parse(request.params);
    return mediaProxy.streamMessageMedia(request, reply, params.messageId, "media");
  });

  app.get("/messages/:messageId/thumbnail", { preHandler: [] }, async (request, reply) => {
    const params = telegramMessageIdParamsSchema.parse(request.params);
    return mediaProxy.streamMessageMedia(request, reply, params.messageId, "thumbnail");
  });

  app.get("/messages/:messageId/media-access", { preHandler: [telegramReadGuard(app)] }, async (request) => {
    const params = telegramMessageIdParamsSchema.parse(request.params);
    const query = telegramMediaVariantQuerySchema.parse(request.query);
    return mediaProxy.mintMediaAccessUrl(request.user!, params.messageId, query.variant);
  });

  app.post("/chats/:chatId/read", { preHandler: [telegramReadGuard(app)] }, async (request) => {
    const params = telegramChatIdParamsSchema.parse(request.params);
    return service.markChatRead(request.user!, params.chatId);
  });

  app.post("/chats/:chatId/messages", { preHandler: [telegramSendGuard(app)] }, async (request, reply) => {
    const params = telegramChatIdParamsSchema.parse(request.params);
    const result = await service.sendTextByChatId(request.user!, params.chatId, request.body);
    return reply.status(result.statusCode).send(result.message);
  });

  app.post("/chats/:chatId/media/presign", { preHandler: [telegramSendGuard(app)] }, async (request) => {
    const params = telegramChatIdParamsSchema.parse(request.params);
    return service.createMediaUploadUrl(request.user!, params.chatId, request.body);
  });

  app.post("/chats/:chatId/media", { preHandler: [telegramSendGuard(app)] }, async (request, reply) => {
    const params = telegramChatIdParamsSchema.parse(request.params);
    const result = await service.sendMediaByChatId(request.user!, params.chatId, request.body);
    return reply.status(result.statusCode).send(result.message);
  });

  app.post("/accounts/:accountId/chats/:chatId/messages", { preHandler: [telegramSendGuard(app)] }, async (request, reply) => {
    const params = telegramChatParamsSchema.parse(request.params);
    const result = await service.sendText(request.user!, params.accountId, params.chatId, request.body);
    return reply.status(result.statusCode).send(result.message);
  });

  app.post("/accounts/:accountId/media/backfill", { preHandler: [telegramManageGuard(app)] }, async (request) => {
    const params = telegramAccountParamsSchema.parse(request.params);
    return service.enqueueMediaBackfill(request.user!, params.accountId);
  });

  app.get("/accounts/:accountId/media/backfill", { preHandler: [telegramReadGuard(app)] }, async (request) => {
    const params = telegramAccountParamsSchema.parse(request.params);
    return service.getMediaBackfillResult(request.user!, params.accountId);
  });

  app.get("/health", { preHandler: [telegramReadGuard(app)] }, async () => service.queueHealth());
}
