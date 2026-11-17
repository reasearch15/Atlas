import { decryptSecret, encryptSecret } from "@atlas/shared/session-encryption";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { TelegramService } from "../telegram/telegram.service";
import { DisabledPyeCashProvider, HttpPyeCashClient } from "./pye-cash.client";
import { listInvoiceQuerySchema } from "./pye-cash.schema";
import { PyeCashService } from "./pye-cash.service";
import { PrismaPyeCashChatLookup, PrismaPyeCashInvoiceStore } from "./pye-cash.store";
import type { PyeCashStaff } from "./pye-cash.types";

const chatParamsSchema = z.object({
  chatId: z.string().uuid()
});

const invoiceParamsSchema = chatParamsSchema.extend({
  invoiceId: z.string().uuid()
});

export const PYE_CASH_CREATE_RATE_LIMIT = { max: 10, timeWindow: "1 minute" } as const;

/**
 * Staff invoice routes. Creation contacts Pye-Cash only when PYE_CASH_ENABLED=true
 * and this process is not a test run.
 */
export async function pyeCashRoutes(app: FastifyInstance): Promise<void> {
  const enabled = app.env.PYE_CASH_ENABLED;
  const provider = enabled
    ? new HttpPyeCashClient({
        baseUrl: app.env.PYE_CASH_BASE_URL,
        timeoutMs: app.env.PYE_CASH_TIMEOUT_MS,
        allowLiveFetch: process.env.NODE_ENV !== "test"
      })
    : new DisabledPyeCashProvider();
  const telegram = new TelegramService(app);
  const service = new PyeCashService({
    config: {
      enabled,
      testMode: app.env.PYE_CASH_TEST_MODE,
      allowedUserIds: app.env.PYE_CASH_ALLOWED_USER_IDS,
      allowedChatIds: app.env.PYE_CASH_ALLOWED_CHAT_IDS,
      merchant: app.env.PYE_CASH_MERCHANT,
      baseUrl: app.env.PYE_CASH_BASE_URL,
      timeoutMs: app.env.PYE_CASH_TIMEOUT_MS,
      maxAmountCents: app.env.PYE_CASH_MAX_AMOUNT_CENTS,
      encryptionKey: app.env.TELEGRAM_SESSION_ENCRYPTION_KEY,
      staleCreatingMs: Math.max(app.env.PYE_CASH_TIMEOUT_MS * 3, 30_000)
    },
    provider,
    invoices: new PrismaPyeCashInvoiceStore(app.prisma),
    chats: new PrismaPyeCashChatLookup(app.prisma),
    encrypt: (plaintext) => encryptSecret(plaintext, app.env.TELEGRAM_SESSION_ENCRYPTION_KEY),
    decrypt: (envelope) => decryptSecret(envelope, app.env.TELEGRAM_SESSION_ENCRYPTION_KEY),
    media: {
      async putPng(input) {
        const key = app.storage.buildWorkspaceMediaKey({
          workspaceId: input.workspaceId,
          telegramAccountId: input.telegramAccountId,
          telegramChatId: input.telegramChatId,
          telegramMessageId: `pye-${input.invoiceId}`,
          fileName: "pye-cash-qr.png"
        });
        app.storage.assertWorkspaceKey(input.workspaceId, key);
        await app.storage.putObject({ key, body: input.png, contentType: "image/png" });
        return key;
      }
    },
    delivery: {
      async enqueue(input) {
        return telegram.enqueueStoredPhoto(
          {
            id: input.user.id,
            email: input.user.email ?? "",
            name: input.user.name,
            role: input.user.role === "PLATFORM_ADMIN" ? "COADMIN" : input.user.role,
            workspaceId: input.user.workspaceId,
            sessionId: input.user.sessionId
          },
          input.chat.id,
          {
            idempotencyKey: input.idempotencyKey,
            storageKey: input.storageKey,
            caption: input.caption,
            fileSizeBytes: input.fileSizeBytes,
            pyeCashInvoiceId: input.invoiceId,
            resend: input.resend
          }
        );
      }
    },
    log: (event) => app.log.info(event)
  });

  app.get("/chats/:chatId/capability", { preHandler: [pyeCashSendGuard(app)] }, async (request) => {
    const params = chatParamsSchema.parse(request.params);
    return service.capability(request.user as PyeCashStaff | undefined, params.chatId);
  });

  app.post(
    "/chats/:chatId/invoices",
    { preHandler: [pyeCashSendGuard(app)], config: { rateLimit: PYE_CASH_CREATE_RATE_LIMIT } },
    async (request, reply) => {
      const params = chatParamsSchema.parse(request.params);
      const result = await service.create(request.user as PyeCashStaff | undefined, params.chatId, request.body);
      if (result.error) {
        return reply.status(result.statusCode).send({ error: result.error, invoice: result.invoice });
      }
      return reply.status(result.statusCode).send({ invoice: result.invoice });
    }
  );

  app.post(
    "/chats/:chatId/invoices/:invoiceId/qr",
    { preHandler: [pyeCashSendGuard(app)], config: { rateLimit: PYE_CASH_CREATE_RATE_LIMIT } },
    async (request, reply) => {
      const params = invoiceParamsSchema.parse(request.params);
      const result = await service.queueQr(request.user, params.chatId, params.invoiceId);
      return reply.status(result.statusCode).send({ invoice: result.invoice });
    }
  );

  app.get("/chats/:chatId/invoices", { preHandler: [pyeCashSendGuard(app)] }, async (request) => {
    const params = chatParamsSchema.parse(request.params);
    const query = listInvoiceQuerySchema.parse(request.query);
    const invoices = await service.list(request.user as PyeCashStaff | undefined, params.chatId, query.limit);
    return { invoices };
  });
}

function pyeCashSendGuard(app: FastifyInstance) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await app.authenticate(request, reply);
    await app.requireRole(["COADMIN", "STAFF"])(request, reply);
    await app.requirePermission("payments:cash-app:send")(request, reply);
    await app.requirePermission("telegram:message:send")(request, reply);
  };
}
