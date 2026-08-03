import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyInstance } from "fastify";
import { AppError, forbidden, unauthorized } from "../../utils/errors";
import { telegramNotFound } from "./telegram.errors";
import type { RequestUser } from "../auth/auth.types";
import { signMediaAccessTicket, verifyMediaAccessTicket, withMediaAccessTicket, type MediaAccessVariant } from "./media-access-ticket";
import { buildTelegramMessageMediaPath } from "@atlas/shared";

const INLINE_CONTENT_TYPES = new Set([
  "PHOTO",
  "VIDEO",
  "VIDEO_NOTE",
  "VOICE",
  "AUDIO",
  "ANIMATION",
  "STICKER"
]);

/**
 * Streams Telegram message media from private MinIO through the authenticated Atlas API.
 */
export class TelegramMediaProxyService {
  public constructor(
    private readonly app: FastifyInstance
  ) {}

  /**
   * Mints a short-lived same-origin media URL for browser <img>/<video>/<audio> tags.
   */
  public async mintMediaAccessUrl(
    user: RequestUser,
    messageId: string,
    variant: MediaAccessVariant
  ): Promise<{ readonly url: string }> {
    const { message } = await this.loadAuthorizedMessage(user, messageId, variant);
    const path = buildTelegramMessageMediaPath(message.id, variant);
    const ticket = signMediaAccessTicket(this.app.env.JWT_ACCESS_SECRET, {
      messageId: message.id,
      workspaceId: message.workspaceId,
      userId: user.id,
      variant
    });
    return { url: withMediaAccessTicket(path, ticket) };
  }

  /**
   * Builds a same-origin media URL with access ticket for inclusion in REST DTOs.
   */
  public buildDtoMediaUrl(user: RequestUser, messageId: string, workspaceId: string, variant: MediaAccessVariant): string {
    const path = buildTelegramMessageMediaPath(messageId, variant);
    const ticket = signMediaAccessTicket(this.app.env.JWT_ACCESS_SECRET, {
      messageId,
      workspaceId,
      userId: user.id,
      variant
    });
    return withMediaAccessTicket(path, ticket);
  }

  /**
   * Authenticates via Bearer or media access ticket, then streams object bytes (with Range).
   */
  public async streamMessageMedia(
    request: FastifyRequest,
    reply: FastifyReply,
    messageId: string,
    variant: MediaAccessVariant
  ): Promise<void> {
    const user = await this.resolveMediaUser(request, messageId, variant);
    const { message, key } = await this.loadAuthorizedMessage(user, messageId, variant);

    const state = message.mediaDownloadState ?? "NONE";
    if (state === "PENDING" || state === "DOWNLOADING") {
      throw new AppError(409, "MEDIA_PENDING", "Media is still processing.");
    }
    if (state === "UNAVAILABLE" || message.mediaError === "OBJECT_MISSING") {
      throw new AppError(404, "MEDIA_UNAVAILABLE", "Media object is unavailable.");
    }
    if (state !== "STORED" && variant === "media") {
      throw new AppError(404, "MEDIA_NOT_READY", "Media is not stored yet.");
    }
    if (!key) {
      throw telegramNotFound();
    }

    this.app.storage.assertWorkspaceKey(message.workspaceId, key);

    const rangeHeader = typeof request.headers.range === "string" ? request.headers.range : null;
    let streamed;
    try {
      streamed = await this.app.storage.getObjectStream({
        key,
        range: rangeHeader
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      const code = (error as { Code?: string; name?: string })?.Code ?? name;
      if (code === "NoSuchKey" || code === "NotFound" || /NoSuchKey|NotFound/i.test(String(error))) {
        if (variant === "media") {
          await this.app.prisma.telegramMessage
            .update({
              where: { id: message.id },
              data: {
                mediaDownloadState: "UNAVAILABLE",
                mediaUploadState: "UNAVAILABLE",
                mediaError: "OBJECT_MISSING"
              }
            })
            .catch(() => undefined);
        }
        throw new AppError(404, "MEDIA_UNAVAILABLE", "Media object is missing from storage.");
      }
      if (code === "InvalidRange" || /InvalidRange/i.test(String(error))) {
        throw new AppError(416, "RANGE_NOT_SATISFIABLE", "Requested range is not satisfiable.");
      }
      throw error;
    }

    const contentType =
      streamed.contentType ||
      message.mimeType ||
      (variant === "thumbnail" ? "image/jpeg" : "application/octet-stream");
    const safeName = sanitizeContentDispositionFilename(message.fileName || `${variant}.bin`);
    const dispositionType =
      variant === "thumbnail" || INLINE_CONTENT_TYPES.has(message.contentType) ? "inline" : "attachment";

    reply.code(streamed.statusCode);
    reply.header("Content-Type", sanitizeHeaderToken(contentType));
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "private, max-age=300");
    reply.header("Accept-Ranges", streamed.acceptRanges);
    reply.header("Content-Disposition", `${dispositionType}; filename="${safeName}"; filename*=UTF-8''${encodeRFC5987(safeName)}`);
    // Authenticated media must not be cached by shared proxies / CDN edge caches.
    reply.header("Vary", "Authorization, Cookie");
    if (streamed.contentLength != null) {
      reply.header("Content-Length", String(streamed.contentLength));
    }
    if (streamed.contentRange) {
      reply.header("Content-Range", streamed.contentRange);
    }
    if (streamed.etag) {
      reply.header("ETag", streamed.etag);
    }

    return reply.send(streamed.body);
  }

  private async resolveMediaUser(
    request: FastifyRequest,
    messageId: string,
    variant: MediaAccessVariant
  ): Promise<RequestUser> {
    const header = request.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    if (bearer) {
      return this.app.auth.authenticate(bearer);
    }

    const query = request.query as { access?: string };
    const ticket = verifyMediaAccessTicket(this.app.env.JWT_ACCESS_SECRET, query.access);
    if (!ticket || ticket.messageId !== messageId || ticket.variant !== variant) {
      throw unauthorized();
    }

    const user = await this.app.prisma.user.findFirst({
      where: { id: ticket.userId, status: "ACTIVE" },
      select: { id: true, role: true, workspaceId: true, status: true, name: true, email: true }
    });
    if (!user || user.workspaceId !== ticket.workspaceId) {
      throw unauthorized();
    }
    if (user.role !== "COADMIN" && user.role !== "STAFF") {
      throw forbidden();
    }

    return {
      id: user.id,
      email: user.email ?? "",
      name: user.name,
      role: user.role as RequestUser["role"],
      workspaceId: user.workspaceId,
      sessionId: "media-ticket"
    };
  }

  private async loadAuthorizedMessage(user: RequestUser, messageId: string, variant: MediaAccessVariant) {
    if (!user.workspaceId) {
      throw forbidden();
    }
    const message = await this.app.prisma.telegramMessage.findFirst({
      where: { id: messageId, workspaceId: user.workspaceId },
      select: {
        id: true,
        workspaceId: true,
        telegramChatDbId: true,
        telegramAccountId: true,
        contentType: true,
        mimeType: true,
        fileName: true,
        mediaStorageKey: true,
        thumbnailStorageKey: true,
        mediaDownloadState: true,
        mediaUploadState: true,
        mediaError: true
      }
    });
    if (!message) {
      throw telegramNotFound();
    }

    const chat = await this.app.prisma.telegramChat.findFirst({
      where: { id: message.telegramChatDbId, workspaceId: user.workspaceId, isArchived: false },
      select: { id: true, telegramAccountId: true }
    });
    if (!chat || chat.telegramAccountId !== message.telegramAccountId) {
      throw forbidden("You do not have access to this conversation.");
    }

    const account = await this.app.prisma.telegramAccount.findFirst({
      where: { id: message.telegramAccountId, workspaceId: user.workspaceId },
      select: { id: true }
    });
    if (!account) {
      throw forbidden("You do not have access to this Telegram account.");
    }

    const key = variant === "thumbnail" ? message.thumbnailStorageKey : message.mediaStorageKey;
    return { message, key };
  }
}

function sanitizeContentDispositionFilename(name: string): string {
  return name.replace(/[\r\n"]/g, "_").replace(/[^\w.\- ()[\]]+/g, "_").slice(0, 180) || "file.bin";
}

function sanitizeHeaderToken(value: string): string {
  return value.replace(/[\r\n]/g, "").slice(0, 180) || "application/octet-stream";
}

function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(/['()]/g, escape).replace(/\*/g, "%2A");
}
