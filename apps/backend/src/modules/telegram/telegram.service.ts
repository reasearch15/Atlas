import { Prisma, type TelegramAccountStatus, type TelegramAuthorizationState } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import type {
  TelegramAccountDto,
  TelegramChatDto,
  TelegramChatIdentityBackfillResult,
  TelegramMediaBackfillResult,
  TelegramMessageDto,
  TelegramQueueHealthDto
} from "@atlas/shared";
import {
  buildCrmContactDisplayTitle,
  buildTelegramMessageMediaPath,
  classifyMessageOrigin,
  contentTypeToMediaType,
  formatTelegramMediaPreview,
  isUsableHumanDisplayTitle,
  shouldIgnoreTelegramDialog,
  type TelegramContentType
} from "@atlas/shared";
import { decryptSecret, encryptSecret, type EncryptedSecret } from "@atlas/shared/session-encryption";
import {
  createAccountBodySchema,
  codeBodySchema,
  deleteMessageBodySchema,
  mediaPresignBodySchema,
  passwordBodySchema,
  phoneBodySchema,
  sendMediaBodySchema,
  sendMessageBodySchema
} from "./telegram.schemas";
import type { RequestUser } from "../auth/auth.types";
import { AuditService } from "../audit/audit.service";
import { TelegramRepository } from "./telegram.repository";
import { invalidTelegramTransition, telegramAccountDeleted, telegramAccountDisconnected, telegramAccountNotAuthorized, telegramAuthCommandInProgress, telegramNotFound, telegramWorkerUnavailable } from "./telegram.errors";
import { AppError, forbidden } from "../../utils/errors";
import {
  applyAccountPrivacy,
  applyChatPrivacy,
  applyMessagePrivacy
} from "../privacy/customer-privacy-mapper";
import type { Role, TelegramAccountPermanentDeleteResponse, TelegramDeleteMessageInput } from "@atlas/shared";
import { TelegramAccountPermanentDeleteService } from "./telegram-account-permanent-delete.service";
import { signMediaAccessTicket, withMediaAccessTicket } from "./media-access-ticket";
import {
  assertDeletableTelegramMessage,
  buildMessageDeletedEvent,
  deleteUnreferencedMediaKeys,
  refreshChatPreviewAfterDeletion,
  softDeleteMessageRow
} from "./telegram-message-delete";
const manageableStates: readonly TelegramAccountStatus[] = [
  "PENDING",
  "AUTHORIZING",
  "WAITING_FOR_QR",
  "WAITING_FOR_PHONE",
  "WAITING_FOR_CODE",
  "WAITING_FOR_PASSWORD",
  "FAILED",
  "REAUTH_REQUIRED"
];

export class TelegramService {
  private readonly app: FastifyInstance;
  private readonly repository: TelegramRepository;
  private readonly audit: AuditService;

  /**
   * Creates a Telegram application service.
   */
  public constructor(app: FastifyInstance) {
    this.app = app;
    this.repository = new TelegramRepository(app.prisma);
    this.audit = new AuditService(app.prisma);
  }

  /**
   * Creates a pending Telegram account for the actor's workspace.
   */
  public async createAccount(user: RequestUser, body: unknown, workspaceId?: string): Promise<TelegramAccountDto> {
    this.assertCoadmin(user);
    const input = createAccountBodySchema.parse(body);
    const account = await this.repository.createAccountForDeveloperApp(user, input.developerAppId, input.displayName, workspaceId);
    await this.audit.record({
      workspaceId: account.workspaceId,
      actorId: user.id,
      action: "telegram.account.create",
      metadata: { telegramAccountId: account.id, developerAppId: account.developerAppId }
    });
    return this.toAccountDto(account, user);
  }

  /**
   * Lists Telegram accounts visible to the actor.
   */
  public async listAccounts(user: RequestUser): Promise<TelegramAccountDto[]> {
    this.assertWorkspaceMember(user);
    const accounts = await this.repository.listAccounts(user);
    return accounts.map((account) => this.toAccountDto(account, user));
  }

  /**
   * Loads a Telegram account visible to the actor.
   */
  public async getAccount(user: RequestUser, accountId: string): Promise<TelegramAccountDto> {
    this.assertWorkspaceMember(user);
    return this.toAccountDto(await this.repository.getAccountForUser(user, accountId), user);
  }

  /**
   * Starts Telegram authorization by queueing a worker command.
   */
  public async startAuthorization(user: RequestUser, accountId: string): Promise<TelegramAccountDto> {
    this.assertCoadmin(user);
    const account = await this.repository.getAccountForUser(user, accountId);
    this.assertManageable(account.status);
    const updated = await this.repository.updateAccount(account.id, {
      status: "WAITING_FOR_PHONE",
      authorizationState: "PHONE_REQUESTED",
      lastErrorCode: null,
      lastErrorMessage: null
    });
    await this.auditState(user, account.workspaceId, account.id, "telegram.auth.start", "PHONE_REQUESTED");
    return this.toAccountDto(updated, user);
  }

  /**
   * Submits a phone number without retaining plaintext.
   */
  public async submitPhone(user: RequestUser, accountId: string, body: unknown): Promise<TelegramAccountDto> {
    this.assertCoadmin(user);
    const input = phoneBodySchema.parse(body);
    const account = await this.repository.getAccountForUser(user, accountId);
    this.assertAuthorizationState(account.authorizationState, ["QR_REQUESTED", "PHONE_REQUESTED"]);
    await this.assertPhoneAvailable(account.workspaceId, account.id, input.phoneNumber);
    const encryptedPhone = encryptSecret(input.phoneNumber, this.app.env.TELEGRAM_SESSION_ENCRYPTION_KEY);
    const updated = await this.repository.updateAccount(account.id, {
      status: "WAITING_FOR_CODE",
      authorizationState: "CODE_REQUESTED",
      phoneNumberEncrypted: encryptedPhone as unknown as Prisma.InputJsonObject
    });
    await this.enqueue(account.workspaceId, account.id, user, "SUBMIT_PHONE", {}, `auth-phone:${account.id}:${crypto.randomUUID()}`);
    await this.auditState(user, account.workspaceId, account.id, "telegram.auth.submit_phone", "CODE_REQUESTED");
    return this.toAccountDto(updated, user);
  }

  /**
   * Submits a transient Telegram login code to the worker queue.
   */
  public async submitCode(user: RequestUser, accountId: string, body: unknown): Promise<TelegramAccountDto> {
    this.assertCoadmin(user);
    const input = codeBodySchema.parse(body);
    const account = await this.repository.getAccountForUser(user, accountId);
    this.assertAuthorizationState(account.authorizationState, ["CODE_REQUESTED"]);
    await this.assertNoInFlightAuthCommand(account.id, "SUBMIT_CODE");
    const secretRef = await this.storeEphemeralSecret(account.id, "code", input.code);
    await this.enqueue(account.workspaceId, account.id, user, "SUBMIT_CODE", { secretRef }, `auth-code:${account.id}:${secretRef}`);
    await this.auditState(user, account.workspaceId, account.id, "telegram.auth.submit_code", "CODE_REQUESTED");
    return this.toAccountDto(account, user);
  }

  /**
   * Submits a transient Telegram 2FA password to the worker queue.
   */
  public async submitPassword(user: RequestUser, accountId: string, body: unknown): Promise<TelegramAccountDto> {
    this.assertCoadmin(user);
    const input = passwordBodySchema.parse(body);
    const account = await this.repository.getAccountForUser(user, accountId);
    this.assertAuthorizationState(account.authorizationState, ["PASSWORD_REQUESTED"]);
    await this.assertNoInFlightAuthCommand(account.id, "SUBMIT_PASSWORD");
    const secretRef = await this.storeEphemeralSecret(account.id, "password", input.password);
    await this.enqueue(account.workspaceId, account.id, user, "SUBMIT_PASSWORD", { secretRef }, `auth-password:${account.id}:${secretRef}`);
    await this.auditState(user, account.workspaceId, account.id, "telegram.auth.submit_password", "PASSWORD_REQUESTED");
    return this.toAccountDto(account, user);
  }

  /**
   * Cancels an in-flight authorization attempt.
   */
  public async cancelAuthorization(user: RequestUser, accountId: string): Promise<TelegramAccountDto> {
    this.assertCoadmin(user);
    const account = await this.repository.getAccountForUser(user, accountId);
    const updated = await this.repository.updateAccount(account.id, {
      status: "PENDING",
      authorizationState: "CANCELLED",
      lastErrorCode: null,
      lastErrorMessage: null
    });
    await this.auditState(user, account.workspaceId, account.id, "telegram.auth.cancel", "CANCELLED");
    return this.toAccountDto(updated, user);
  }

  /**
   * Marks an account for reauthorization.
   */
  public async reauthorize(user: RequestUser, accountId: string): Promise<TelegramAccountDto> {
    this.assertCoadmin(user);
    const account = await this.repository.getAccountForUser(user, accountId);
    if (!account.sessionEncrypted) {
      return this.restartAuthorization(user, accountId);
    }
    const updated = await this.repository.updateAccount(account.id, {
      status: "AUTHORIZING",
      authorizationState: "REAUTH_REQUIRED",
      syncState: "PAUSED"
    });
    await this.auditState(user, account.workspaceId, account.id, "telegram.auth.reauthorize", "REAUTH_REQUIRED");
    return this.toAccountDto(updated, user);
  }

  /**
   * Restarts an incomplete or failed Telegram authorization attempt from the phone step.
   */
  public async restartAuthorization(user: RequestUser, accountId: string): Promise<TelegramAccountDto> {
    this.assertCoadmin(user);
    const account = await this.repository.getAccountForUser(user, accountId);
    this.assertAuthorizationState(account.authorizationState, ["REAUTH_REQUIRED", "PHONE_REQUESTED", "CODE_REQUESTED", "PASSWORD_REQUESTED", "CANCELLED"]);
    await this.clearAuthorizationRuntimeState(account.id);
    const updated = await this.repository.updateAccount(account.id, {
      status: "WAITING_FOR_PHONE",
      authorizationState: "PHONE_REQUESTED",
      syncState: "IDLE",
      phoneNumberEncrypted: Prisma.DbNull,
      sessionEncrypted: Prisma.DbNull,
      lastErrorCode: null,
      lastErrorMessage: null,
      workerLeaseOwner: null,
      workerLeaseExpiresAt: null
    });
    await this.auditState(user, account.workspaceId, account.id, "telegram.auth.restart", "PHONE_REQUESTED");
    return this.toAccountDto(updated, user);
  }

  /**
   * Disconnects a Telegram account without deleting audit history or cached metadata.
   */
  public async disconnect(user: RequestUser, accountId: string): Promise<TelegramAccountDto> {
    this.assertCoadmin(user);
    const account = await this.repository.getAccountForUser(user, accountId);
    if (account.status === "DELETING") {
      throw telegramAccountDeleted();
    }
    const updated = await this.repository.updateAccount(account.id, {
      status: "DISCONNECTED",
      authorizationState: "CANCELLED",
      syncState: "PAUSED",
      workerLeaseOwner: null,
      workerLeaseExpiresAt: null,
      disconnectedAt: new Date()
    });
    await this.enqueue(account.workspaceId, account.id, user, "DISCONNECT", {}, `disconnect:${account.id}:${crypto.randomUUID()}`);
    await this.audit.record({
      workspaceId: account.workspaceId,
      actorId: user.id,
      action: "telegram.account.disconnect",
      metadata: { telegramAccountId: account.id, sessionId: user.sessionId }
    });
    return this.toAccountDto(updated, user);
  }

  /**
   * Permanently deletes a disconnected Telegram account and its exclusive inbox data.
   */
  public async permanentDelete(user: RequestUser, accountId: string, body: unknown): Promise<TelegramAccountPermanentDeleteResponse> {
    return new TelegramAccountPermanentDeleteService(this.app).permanentDelete(user, accountId, body);
  }

  /**
   * Lists cached chats for an account.
   */
  public async listChats(user: RequestUser, accountId: string): Promise<TelegramChatDto[]> {
    this.assertWorkspaceMember(user);
    const chats = await this.repository.listChats(user, accountId);
    return chats
      .filter((chat) => {
        const meta =
          chat.rawMetadataJson && typeof chat.rawMetadataJson === "object" && !Array.isArray(chat.rawMetadataJson)
            ? (chat.rawMetadataJson as Record<string, unknown>)
            : {};
        return !shouldIgnoreTelegramDialog({
          telegramChatId: chat.telegramChatId,
          chatType: chat.chatType,
          title: chat.title,
          username: chat.username,
          firstName: chat.firstName,
          lastName: chat.lastName,
          isSelf: Boolean(meta.self),
          isSupport: Boolean(meta.support),
          isArchived: chat.isArchived || Boolean(meta.archived)
        });
      })
      .map((chat) => this.toChatDto(chat, user));
  }

  /**
   * Persists conversation read state and enqueues Telegram readHistory acknowledgement.
   */
  public async markChatRead(user: RequestUser, chatId: string): Promise<{ readonly unreadCount: 0; readonly chatId: string }> {
    this.assertWorkspaceMember(user);
    const chat = await this.app.prisma.telegramChat.findFirst({
      where: { id: chatId, workspaceId: user.workspaceId ?? "" }
    });
    if (!chat) {
      throw telegramNotFound();
    }

    const previousUnread = chat.unreadCount;
    const maxId = chat.lastMessageId;
    const updated = await this.app.prisma.telegramChat.update({
      where: { id: chat.id },
      data: {
        unreadCount: 0,
        ...(maxId
          ? {
              lastReadTelegramMessageId: maxId,
              lastReadAt: new Date()
            }
          : { lastReadAt: new Date() })
      }
    });

    this.app.log.info(
      {
        event: "telegram_chat.mark_read_api",
        conversationId: chat.id,
        telegramAccountId: chat.telegramAccountId,
        peerId: chat.telegramChatId,
        previousUnreadCount: previousUnread,
        newUnreadCount: 0,
        readMaxMessageId: maxId
      },
      "chat marked read"
    );

    await this.app.redis.publish(
      "atlas.workspace-events",
      JSON.stringify({
        type: "telegram.chat.updated",
        eventId: crypto.randomUUID(),
        workspaceId: chat.workspaceId,
        telegramAccountId: chat.telegramAccountId,
        chatId: chat.id,
        lastMessagePreview: updated.lastMessagePreview,
        lastMessageAt: updated.lastMessageAt?.toISOString() ?? null,
        lastMessageDirection: null,
        unreadCount: 0,
        title: updated.title,
        firstName: updated.firstName,
        lastName: updated.lastName,
        username: updated.username,
        phone: updated.peerPhone,
        chatType: updated.chatType,
        isBot: updated.isBot,
        isPinned: updated.isPinned,
        identityResolved: isUsableHumanDisplayTitle(updated.title, updated.telegramChatId),
        needsCrmAttention: updated.needsCrmAttention,
        telegramChatId: updated.telegramChatId
      })
    );

    if (maxId) {
      try {
        await this.enqueue(
          chat.workspaceId,
          chat.telegramAccountId,
          user,
          "MARK_CHAT_READ",
          { chatDbId: chat.id, maxTelegramMessageId: maxId },
          `mark-read:${chat.id}:${maxId}`
        );
      } catch (error) {
        this.app.log.warn({ err: error, chatId: chat.id }, "mark-read enqueue skipped");
      }
    }

    return { unreadCount: 0, chatId: chat.id };
  }

  /**
   * Lists recent cached messages for a chat (with signed media URLs).
   */
  public async listMessages(user: RequestUser, accountId: string, chatId: string): Promise<TelegramMessageDto[]> {
    this.assertWorkspaceMember(user);
    const chat = await this.app.prisma.telegramChat.findFirst({
      where: { id: chatId, telegramAccountId: accountId, workspaceId: user.workspaceId ?? "" }
    });
    if (!chat) {
      throw telegramNotFound();
    }
    const messages = await this.repository.listMessages(user, accountId, chatId);
    return Promise.all(messages.map((message) => this.toMessageDto(message, chat, user)));
  }

  /**
   * Lists messages for a workspace-scoped chat id.
   */
  public async listMessagesByChatId(user: RequestUser, chatId: string): Promise<TelegramMessageDto[]> {
    this.assertWorkspaceMember(user);
    const { chat, messages } = await this.repository.listMessagesByChatId(user, chatId);
    return Promise.all(messages.map((message) => this.toMessageDto(message, chat, user)));
  }

  /**
   * Explicitly re-queues a FAILED_* outbound message after peer identity repair.
   * Never auto-sends FAILED_PERMANENT — requires this user action. Idempotent per message.
   */
  public async retryFailedOutboundMessage(user: RequestUser, messageId: string): Promise<TelegramMessageDto> {
    this.assertWorkspaceMember(user);
    if (!user.workspaceId) {
      throw forbidden();
    }

    const message = await this.app.prisma.telegramMessage.findFirst({
      where: {
        id: messageId,
        workspaceId: user.workspaceId,
        direction: "OUTBOUND",
        sendStatus: { in: ["FAILED_RETRYABLE", "FAILED_PERMANENT"] }
      }
    });
    if (!message) {
      throw telegramNotFound("Failed outbound message was not found.");
    }

    const chat = await this.app.prisma.telegramChat.findFirst({
      where: { id: message.telegramChatDbId, workspaceId: user.workspaceId }
    });
    if (!chat) {
      throw telegramNotFound();
    }

    // Always allow explicit Retry for FAILED_* Atlas messages. The worker resolves InputPeer from
    // stored access_hash / live entity cache / dialogs; unresolved peers stay FAILED_RETRYABLE
    // (TELEGRAM_PEER_UNRESOLVED) so a later inbound identity repair can make Retry succeed.

    const command = await this.app.prisma.telegramOutboundCommand.findFirst({
      where: {
        workspaceId: user.workspaceId,
        telegramMessageId: message.id,
        status: { in: ["FAILED_RETRYABLE", "FAILED_PERMANENT"] }
      },
      orderBy: { createdAt: "desc" }
    });
    if (!command) {
      throw telegramNotFound("Outbound command for this failed message was not found.");
    }

    // Idempotency: if another retry already re-queued this command, return current message state.
    if (command.status === "QUEUED" || command.status === "SENDING") {
      return this.toMessageDto(message, chat, user);
    }

    await this.app.prisma.telegramOutboundCommand.update({
      where: { id: command.id },
      data: {
        status: "QUEUED",
        lastError: null,
        processedAt: null
      }
    });
    const updatedMessage = await this.app.prisma.telegramMessage.update({
      where: { id: message.id },
      data: { sendStatus: "QUEUED", updatedAt: new Date() }
    });

    try {
      const existingJob = await this.app.queues.telegramOutbound.getJob(command.id);
      if (existingJob) {
        await existingJob.remove().catch(() => undefined);
      }
      await this.app.queues.telegramOutbound.add(
        "telegram-outbound",
        { commandId: command.id },
        { jobId: `${command.id}:retry:${command.attempts + 1}` }
      );
    } catch {
      throw telegramWorkerUnavailable();
    }

    await this.audit.record({
      workspaceId: user.workspaceId,
      actorId: user.id,
      action: "telegram.message.retry",
      metadata: {
        messageId: message.id,
        commandId: command.id,
        telegramChatId: chat.telegramChatId,
        sessionId: user.sessionId
      }
    });

    return this.toMessageDto(updatedMessage, chat, user);
  }

  /**
   * Deletes a Telegram message for Coadmin / Platform Admin.
   * EVERYONE enqueues a durable worker command; ATLAS_ONLY soft-deletes locally without calling Telegram.
   */
  public async deleteMessage(
    user: RequestUser,
    messageId: string,
    body: unknown
  ): Promise<{
    readonly statusCode: number;
    readonly body:
      | TelegramMessageDto
      | {
          readonly messageId: string;
          readonly status: "QUEUED" | "DELETED";
          readonly scope: "EVERYONE" | "ATLAS_ONLY";
        };
  }> {
    this.assertMessageDeleteAllowed(user);
    const input = deleteMessageBodySchema.parse(body ?? {}) as TelegramDeleteMessageInput;
    const workspaceId = user.workspaceId!;

    const message = await this.app.prisma.telegramMessage.findFirst({
      where: { id: messageId, workspaceId }
    });
    if (!message) {
      throw telegramNotFound("Message was not found.");
    }

    const chat = await this.app.prisma.telegramChat.findFirst({
      where: { id: message.telegramChatDbId, workspaceId }
    });
    if (!chat) {
      throw telegramNotFound();
    }

    try {
      assertDeletableTelegramMessage({
        isDevelopmentFixture: message.isDevelopmentFixture,
        telegramChatId: message.telegramChatId,
        telegramMessageId: message.telegramMessageId
      });
    } catch (error) {
      const err = error as { statusCode?: number; code?: string; message?: string };
      throw new AppError(err.statusCode ?? 400, err.code ?? "TELEGRAM_DELETE_REJECTED", err.message ?? "Cannot delete this message.");
    }

    // Idempotent: already soft-deleted.
    if (message.deletedAt) {
      await this.audit.record({
        workspaceId,
        actorId: user.id,
        action: "telegram.message.delete",
        metadata: {
          messageId: message.id,
          telegramMessageId: message.telegramMessageId,
          chatId: chat.id,
          scope: message.deletionScope ?? input.scope,
          result: "ALREADY_DELETED",
          actorRole: user.role
        }
      });
      return {
        statusCode: 200,
        body: {
          messageId: message.id,
          status: "DELETED",
          scope: (message.deletionScope as "EVERYONE" | "ATLAS_ONLY") ?? input.scope
        }
      };
    }

    const idempotencyKey = (input.idempotencyKey?.trim() || `delete:${message.id}:${input.scope}`).slice(0, 160);

    if (input.scope === "ATLAS_ONLY") {
      const deletedAt = new Date();
      const mediaKeys = (
        await softDeleteMessageRow(this.app.prisma, {
          messageId: message.id,
          deletedAt,
          deletedByUserId: user.id,
          deletionScope: "ATLAS_ONLY",
          originalContentType: message.contentType,
          priorMediaStorageKey: message.mediaStorageKey,
          priorThumbnailStorageKey: message.thumbnailStorageKey
        })
      ).mediaKeys;

      const preview = await refreshChatPreviewAfterDeletion(this.app.prisma, chat.id);
      await deleteUnreferencedMediaKeys(this.app.prisma, (key) => this.app.storage.deleteObject(key), mediaKeys);

      const event = buildMessageDeletedEvent({
        workspaceId,
        telegramAccountId: message.telegramAccountId,
        chatId: chat.id,
        messageId: message.id,
        telegramMessageId: message.telegramMessageId,
        scope: "ATLAS_ONLY",
        deletedAt,
        deletedBy: { id: user.id, name: user.name },
        lastMessagePreview: preview.lastMessagePreview,
        lastMessageAt: preview.lastMessageAt,
        lastMessageDirection: preview.lastMessageDirection
      });
      await this.app.redis.publish("atlas.workspace-events", JSON.stringify(event));

      await this.audit.record({
        workspaceId,
        actorId: user.id,
        action: "telegram.message.delete",
        metadata: {
          messageId: message.id,
          telegramMessageId: message.telegramMessageId,
          chatId: chat.id,
          scope: "ATLAS_ONLY",
          result: "DELETED",
          actorRole: user.role
        }
      });

      return { statusCode: 200, body: { messageId: message.id, status: "DELETED", scope: "ATLAS_ONLY" } };
    }

    // EVERYONE — require a real Telegram message id (not pending local placeholders).
    const remoteId = message.telegramMessageId;
    if (remoteId.startsWith("pending:") || remoteId.startsWith("upload:")) {
      throw new AppError(
        409,
        "TELEGRAM_DELETE_NOT_ON_TELEGRAM",
        "This message was never delivered to Telegram. Use Remove from Atlas only."
      );
    }

    const existingCommand = await this.app.prisma.telegramOutboundCommand.findUnique({
      where: { idempotencyKey }
    });
    if (existingCommand && (existingCommand.status === "QUEUED" || existingCommand.status === "SENDING" || existingCommand.status === "SENT")) {
      await this.audit.record({
        workspaceId,
        actorId: user.id,
        action: "telegram.message.delete",
        metadata: {
          messageId: message.id,
          telegramMessageId: message.telegramMessageId,
          chatId: chat.id,
          scope: "EVERYONE",
          result: existingCommand.status === "SENT" ? "ALREADY_DELETED" : "ALREADY_QUEUED",
          actorRole: user.role,
          commandId: existingCommand.id
        }
      });
      return {
        statusCode: existingCommand.status === "SENT" ? 200 : 202,
        body: {
          messageId: message.id,
          status: existingCommand.status === "SENT" ? "DELETED" : "QUEUED",
          scope: "EVERYONE"
        }
      };
    }

    await this.app.prisma.telegramMessage.update({
      where: { id: message.id },
      data: {
        telegramDeleteStatus: "QUEUED",
        telegramDeleteError: null,
        deletionScope: "EVERYONE",
        deletedByUserId: user.id
      }
    });

    const command = await this.app.prisma.telegramOutboundCommand.upsert({
      where: { idempotencyKey },
      update: {
        status: "QUEUED",
        lastError: null,
        processedAt: null
      },
      create: {
        workspaceId,
        telegramAccountId: message.telegramAccountId,
        telegramChatDbId: chat.id,
        telegramChatId: chat.telegramChatId,
        telegramMessageId: message.id,
        requestedByUserId: user.id,
        requestedBySessionId: user.sessionId,
        operation: "DELETE_MESSAGE",
        payloadJson: {
          messageDbId: message.id,
          telegramMessageId: message.telegramMessageId,
          scope: "EVERYONE",
          revoke: true
        } as unknown as Prisma.InputJsonObject,
        idempotencyKey
      }
    });

    try {
      const existingJob = await this.app.queues.telegramOutbound.getJob(command.id);
      if (existingJob) {
        await existingJob.remove().catch(() => undefined);
      }
      await this.app.queues.telegramOutbound.add(
        "telegram-outbound",
        { commandId: command.id },
        { jobId: `${command.id}:delete:${command.attempts + 1}` }
      );
    } catch {
      throw telegramWorkerUnavailable();
    }

    await this.audit.record({
      workspaceId,
      actorId: user.id,
      action: "telegram.message.delete",
      metadata: {
        messageId: message.id,
        telegramMessageId: message.telegramMessageId,
        chatId: chat.id,
        scope: "EVERYONE",
        result: "QUEUED",
        actorRole: user.role,
        commandId: command.id
      }
    });

    return { statusCode: 202, body: { messageId: message.id, status: "QUEUED", scope: "EVERYONE" } };
  }

  /**
   * Enqueues a safe identity/metadata refresh for chats with missing titles.
   */
  public async refreshChatMetadata(user: RequestUser, accountId: string): Promise<{ queued: true; accountId: string }> {
    this.assertCoadmin(user);
    const account = await this.repository.getAccountForUser(user, accountId);
    if (account.authorizationState !== "AUTHORIZED") {
      throw telegramNotFound("Telegram account is not authorized");
    }
    await this.enqueue(
      account.workspaceId,
      account.id,
      user,
      "INITIAL_SYNC",
      { reason: "chat-metadata-backfill" },
      `chat-metadata-refresh:${account.id}:${crypto.randomUUID()}`
    );
    return { queued: true, accountId: account.id };
  }

  /**
   * Returns the latest identity backfill counts for an account, if available.
   */
  public async getChatIdentityBackfillResult(user: RequestUser, accountId: string): Promise<TelegramChatIdentityBackfillResult | null> {
    this.assertWorkspaceMember(user);
    await this.repository.getAccountForUser(user, accountId);
    const raw = await this.app.redis.get(`telegram-identity-backfill:${accountId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as TelegramChatIdentityBackfillResult;
    } catch {
      return null;
    }
  }

  /**
   * Enqueues a text message for a workspace-scoped chat id.
   */
  public async sendTextByChatId(
    user: RequestUser,
    chatId: string,
    body: unknown
  ): Promise<{ readonly statusCode: 200 | 202; readonly message: TelegramMessageDto }> {
    this.assertWorkspaceMember(user);
    const chat = await this.repository.getChatForUser(user, chatId);
    return this.enqueueOutboundText(user, chat.telegramAccountId, chat.id, body);
  }

  /**
   * Enqueues a text message command with idempotency protection.
   */
  public async sendText(
    user: RequestUser,
    accountId: string,
    chatId: string,
    body: unknown
  ): Promise<{ readonly statusCode: 200 | 202; readonly message: TelegramMessageDto }> {
    this.assertWorkspaceMember(user);
    return this.enqueueOutboundText(user, accountId, chatId, body);
  }

  /**
   * Creates a presigned PUT URL for outbound media upload into workspace-scoped storage.
   */
  public async createMediaUploadUrl(
    user: RequestUser,
    chatId: string,
    body: unknown
  ): Promise<{ readonly uploadUrl: string; readonly storageKey: string; readonly expiresInSeconds: number }> {
    this.assertWorkspaceMember(user);
    const input = mediaPresignBodySchema.parse(body);
    const chat = await this.repository.getChatForUser(user, chatId);
    const account = await this.repository.getAccountForUser(user, chat.telegramAccountId);
    const pendingId = `upload:${input.idempotencyKey}`.slice(0, 80);
    const storageKey = this.app.storage.buildWorkspaceMediaKey({
      workspaceId: account.workspaceId,
      telegramAccountId: account.id,
      telegramChatId: chat.telegramChatId,
      telegramMessageId: pendingId,
      fileName: input.fileName
    });
    this.app.storage.assertWorkspaceKey(account.workspaceId, storageKey);
    const uploadUrl = await this.app.storage.getSignedPutUrl(storageKey, input.mimeType, 900);
    return { uploadUrl, storageKey, expiresInSeconds: 900 };
  }

  /**
   * Enqueues an outbound media message after the client uploaded bytes to storage.
   */
  public async sendMediaByChatId(
    user: RequestUser,
    chatId: string,
    body: unknown
  ): Promise<{ readonly statusCode: 200 | 202; readonly message: TelegramMessageDto }> {
    this.assertWorkspaceMember(user);
    const input = sendMediaBodySchema.parse(body);
    const chat = await this.repository.getChatForUser(user, chatId);
    const account = await this.repository.getAccountForUser(user, chat.telegramAccountId);
    if (account.status === "DELETING") throw telegramAccountDeleted();
    if (account.status === "DISCONNECTED") throw telegramAccountDisconnected();
    if (account.authorizationState !== "AUTHORIZED") throw telegramAccountNotAuthorized();

    if (input.storageKey) {
      this.app.storage.assertWorkspaceKey(account.workspaceId, input.storageKey);
    }

    const existingCommand = await this.app.prisma.telegramOutboundCommand.findUnique({
      where: { idempotencyKey: input.idempotencyKey }
    });
    if (existingCommand?.telegramMessageId) {
      const existingMessage = await this.app.prisma.telegramMessage.findFirst({
        where: {
          telegramAccountId: account.id,
          telegramChatDbId: chat.id,
          OR: [{ id: existingCommand.telegramMessageId }, { telegramMessageId: existingCommand.telegramMessageId }]
        }
      });
      if (existingMessage) {
        return { statusCode: 200, message: await this.toMessageDto(existingMessage, chat, user) };
      }
    }

    const preview = formatTelegramMediaPreview(input.contentType as TelegramContentType, {
      caption: input.caption ?? null,
      text: input.caption ?? null
    });
    const pendingTelegramMessageId = `pending:${input.idempotencyKey}`.slice(0, 80);
    const pendingMessage = await this.app.prisma.telegramMessage.upsert({
      where: {
        telegramAccountId_telegramChatId_telegramMessageId: {
          telegramAccountId: account.id,
          telegramChatId: chat.telegramChatId,
          telegramMessageId: pendingTelegramMessageId
        }
      },
      update: {},
      create: {
        workspaceId: account.workspaceId,
        telegramAccountId: account.id,
        telegramChatDbId: chat.id,
        telegramChatId: chat.telegramChatId,
        telegramMessageId: pendingTelegramMessageId,
        senderTelegramUserId: account.telegramUserId,
        direction: "OUTBOUND",
        contentType: input.contentType,
        textContent: preview,
        caption: input.caption ?? null,
        mimeType: input.mimeType ?? null,
        fileName: input.fileName ?? null,
        fileSizeBytes: input.fileSizeBytes ?? null,
        width: input.width ?? null,
        height: input.height ?? null,
        durationSeconds: input.durationSeconds ?? null,
        ...(input.waveform ? { waveformJson: input.waveform as unknown as Prisma.InputJsonValue } : {}),
        mediaMetadataJson: {
          ...(input.latitude != null && input.longitude != null
            ? { lat: input.latitude, long: input.longitude }
            : {}),
          ...(input.contactPhone
            ? {
                phoneNumber: input.contactPhone,
                firstName: input.contactFirstName ?? null,
                lastName: input.contactLastName ?? null
              }
            : {})
        } as Prisma.InputJsonValue,
        mediaStorageKey: input.storageKey ?? null,
        mediaDownloadState: input.storageKey ? "STORED" : "NONE",
        mediaUploadState: input.storageKey ? "STORED" : "PENDING",
        replyToTelegramMessageId: input.replyToTelegramMessageId ?? null,
        telegramCreatedAt: new Date(),
        internalSenderUserId: user.id,
        internalSenderSessionId: user.sessionId,
        internalSenderRole: user.role === "PLATFORM_ADMIN" ? "COADMIN" : user.role,
        internalSenderName: user.name,
        sendStatus: "QUEUED"
      }
    });

    await this.app.prisma.telegramChat.update({
      where: { id: chat.id },
      data: {
        lastMessageId: pendingMessage.telegramMessageId,
        lastMessagePreview: preview.slice(0, 500),
        lastMessageAt: pendingMessage.telegramCreatedAt
      }
    });

    const messageDto = await this.toMessageDto(pendingMessage, chat, user);
    await this.publishOutboundQueued(
      account.workspaceId,
      account.id,
      chat.id,
      messageDto,
      preview,
      pendingMessage.telegramCreatedAt
    );

    const command = await this.app.prisma.telegramOutboundCommand.upsert({
      where: { idempotencyKey: input.idempotencyKey },
      update: {},
      create: {
        workspaceId: account.workspaceId,
        telegramAccountId: account.id,
        telegramChatDbId: chat.id,
        telegramChatId: chat.telegramChatId,
        telegramMessageId: pendingMessage.id,
        requestedByUserId: user.id,
        requestedBySessionId: user.sessionId,
        operation: "SEND_MEDIA_MESSAGE",
        payloadJson: {
          ...input,
          pendingMessageId: pendingMessage.id
        } as unknown as Prisma.InputJsonObject,
        idempotencyKey: input.idempotencyKey
      }
    });

    if (command.status === "QUEUED" && command.attempts === 0) {
      try {
        await this.app.queues.telegramOutbound.add("telegram-outbound", { commandId: command.id }, { jobId: command.id });
      } catch {
        throw telegramWorkerUnavailable();
      }
    }

    return { statusCode: 202, message: messageDto };
  }

  /**
   * Enqueues a bounded media backfill for messages missing object storage.
   */
  public async enqueueMediaBackfill(
    user: RequestUser,
    accountId: string
  ): Promise<{ queued: true; accountId: string }> {
    this.assertCoadmin(user);
    const account = await this.repository.getAccountForUser(user, accountId);
    if (account.authorizationState !== "AUTHORIZED") {
      throw telegramNotFound("Telegram account is not authorized");
    }
    await this.enqueue(
      account.workspaceId,
      account.id,
      user,
      "MEDIA_BACKFILL",
      { reason: "media-storage-backfill" },
      `media-backfill:${account.id}:${crypto.randomUUID()}`
    );
    return { queued: true, accountId: account.id };
  }

  /**
   * Returns the latest media backfill counts for an account, if available.
   */
  public async getMediaBackfillResult(user: RequestUser, accountId: string): Promise<TelegramMediaBackfillResult | null> {
    this.assertWorkspaceMember(user);
    await this.repository.getAccountForUser(user, accountId);
    const raw = await this.app.redis.get(`telegram-media-backfill:${accountId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as TelegramMediaBackfillResult;
    } catch {
      return null;
    }
  }

  /**
   * Creates a queued outbound message and enqueues Telegram delivery.
   * Does not require the HTTP process to own the worker lease — the worker acquires/uses it.
   */
  private async enqueueOutboundText(
    user: RequestUser,
    accountId: string,
    chatId: string,
    body: unknown
  ): Promise<{ readonly statusCode: 200 | 202; readonly message: TelegramMessageDto }> {
    const input = sendMessageBodySchema.parse(body);
    const account = await this.repository.getAccountForUser(user, accountId);
    if (account.status === "DELETING") {
      throw telegramAccountDeleted();
    }
    if (account.status === "DISCONNECTED") {
      throw telegramAccountDisconnected();
    }
    if (account.authorizationState !== "AUTHORIZED") {
      throw telegramAccountNotAuthorized();
    }
    const chat = await this.app.prisma.telegramChat.findFirst({
      where: { id: chatId, workspaceId: account.workspaceId, telegramAccountId: account.id }
    });
    if (!chat) {
      throw telegramNotFound();
    }

    const existingCommand = await this.app.prisma.telegramOutboundCommand.findUnique({
      where: { idempotencyKey: input.idempotencyKey }
    });
    if (existingCommand?.telegramMessageId) {
      const existingMessage = await this.app.prisma.telegramMessage.findFirst({
        where: {
          telegramAccountId: account.id,
          telegramChatDbId: chat.id,
          OR: [{ id: existingCommand.telegramMessageId }, { telegramMessageId: existingCommand.telegramMessageId }]
        }
      });
      if (existingMessage) {
        return { statusCode: 200, message: await this.toMessageDto(existingMessage, chat, user) };
      }
    }

    const pendingTelegramMessageId = `pending:${input.idempotencyKey}`.slice(0, 80);
    const pendingMessage = await this.app.prisma.telegramMessage.upsert({
      where: {
        telegramAccountId_telegramChatId_telegramMessageId: {
          telegramAccountId: account.id,
          telegramChatId: chat.telegramChatId,
          telegramMessageId: pendingTelegramMessageId
        }
      },
      update: {},
      create: {
        workspaceId: account.workspaceId,
        telegramAccountId: account.id,
        telegramChatDbId: chat.id,
        telegramChatId: chat.telegramChatId,
        telegramMessageId: pendingTelegramMessageId,
        senderTelegramUserId: account.telegramUserId,
        direction: "OUTBOUND",
        contentType: "TEXT",
        textContent: input.text,
        replyToTelegramMessageId: input.replyToTelegramMessageId ?? null,
        telegramCreatedAt: new Date(),
        internalSenderUserId: user.id,
        internalSenderSessionId: user.sessionId,
        internalSenderRole: user.role === "PLATFORM_ADMIN" ? "COADMIN" : user.role,
        internalSenderName: user.name,
        sendStatus: "QUEUED"
      }
    });

    await this.app.prisma.telegramChat.update({
      where: { id: chat.id },
      data: {
        lastMessageId: pendingMessage.telegramMessageId,
        lastMessagePreview: input.text.slice(0, 500),
        lastMessageAt: pendingMessage.telegramCreatedAt
      }
    });

    const messageDto = await this.toMessageDto(pendingMessage, chat, user);
    await this.publishOutboundQueued(account.workspaceId, account.id, chat.id, messageDto, input.text, pendingMessage.telegramCreatedAt);
    const command = await this.app.prisma.telegramOutboundCommand.upsert({
      where: { idempotencyKey: input.idempotencyKey },
      update: {},
      create: {
        workspaceId: account.workspaceId,
        telegramAccountId: account.id,
        telegramChatDbId: chat.id,
        telegramChatId: chat.telegramChatId,
        telegramMessageId: pendingMessage.id,
        requestedByUserId: user.id,
        requestedBySessionId: user.sessionId,
        operation: "SEND_TEXT_MESSAGE",
        payloadJson: {
          text: input.text,
          idempotencyKey: input.idempotencyKey,
          ...(input.replyToTelegramMessageId ? { replyToTelegramMessageId: input.replyToTelegramMessageId } : {}),
          pendingMessageId: pendingMessage.id
        } as unknown as Prisma.InputJsonObject,
        idempotencyKey: input.idempotencyKey
      }
    });

    if (command.status === "QUEUED" && command.attempts === 0) {
      try {
        await this.app.queues.telegramOutbound.add("telegram-outbound", { commandId: command.id }, { jobId: command.id });
      } catch {
        throw telegramWorkerUnavailable();
      }
    }

    await this.audit.record({
      workspaceId: account.workspaceId,
      actorId: user.id,
      action: "telegram.message.queue",
      metadata: {
        telegramAccountId: account.id,
        telegramChatId: chat.telegramChatId,
        commandId: command.id,
        messageId: pendingMessage.id,
        sessionId: user.sessionId
      }
    });

    return { statusCode: 202, message: messageDto };
  }

  private async publishOutboundQueued(
    workspaceId: string,
    telegramAccountId: string,
    chatId: string,
    message: TelegramMessageDto,
    preview: string,
    sentAt: Date
  ): Promise<void> {
    const chat = await this.app.prisma.telegramChat.findUnique({
      where: { id: chatId },
      select: {
        unreadCount: true,
        title: true,
        firstName: true,
        lastName: true,
        username: true,
        peerPhone: true,
        chatType: true,
        isBot: true,
        isPinned: true,
        needsCrmAttention: true,
        telegramChatId: true,
        crmStatus: true,
        assignedUserId: true,
        assignedAt: true,
        claimedAt: true,
        assignedUser: { select: { name: true } }
      }
    });
    await this.app.redis.publish(
      "atlas.workspace-events",
      JSON.stringify({
        type: "telegram.message.created",
        eventId: crypto.randomUUID(),
        workspaceId,
        telegramAccountId,
        chatId,
        chatDbId: chatId,
        message
      })
    );
    await this.app.redis.publish(
      "atlas.workspace-events",
      JSON.stringify({
        type: "telegram.chat.updated",
        eventId: crypto.randomUUID(),
        workspaceId,
        telegramAccountId,
        chatId,
        lastMessagePreview: preview.slice(0, 500),
        lastMessageAt: sentAt.toISOString(),
        lastMessageDirection: "OUTBOUND",
        unreadCount: chat?.unreadCount ?? 0,
        ...(chat
          ? {
              title: chat.title,
              firstName: chat.firstName,
              lastName: chat.lastName,
              username: chat.username,
              phone: chat.peerPhone,
              chatType: chat.chatType,
              isBot: chat.isBot,
              isPinned: chat.isPinned,
              identityResolved: isUsableHumanDisplayTitle(chat.title, chat.telegramChatId),
              needsCrmAttention: chat.needsCrmAttention,
              telegramChatId: chat.telegramChatId,
              crmStatus: chat.crmStatus,
              assignedUserId: chat.assignedUserId,
              assignedUserName: chat.assignedUser?.name ?? null,
              assignedAt: chat.assignedAt?.toISOString() ?? null,
              claimedAt: chat.claimedAt?.toISOString() ?? null
            }
          : {})
      })
    );
  }

  /**
   * Returns Telegram queue health metrics.
   */
  public async queueHealth(): Promise<TelegramQueueHealthDto> {
    const counts = await this.app.queues.telegramOutbound.getJobCounts("waiting", "active", "delayed", "failed");
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0
    };
  }

  private async enqueue(
    workspaceId: string,
    accountId: string,
    user: RequestUser,
    operation: Prisma.TelegramOutboundCommandCreateInput["operation"],
    payload: Prisma.InputJsonObject,
    idempotencyKey: string
  ): Promise<void> {
    const command = await this.app.prisma.telegramOutboundCommand.create({
      data: {
        workspaceId,
        telegramAccountId: accountId,
        requestedByUserId: user.id,
        requestedBySessionId: user.sessionId,
        operation,
        payloadJson: payload,
        idempotencyKey
      }
    });
    await this.app.queues.telegramOutbound.add("telegram-outbound", { commandId: command.id }, { jobId: command.id });
  }

  private async storeEphemeralSecret(accountId: string, kind: "code" | "password", value: string): Promise<string> {
    const secretRef = `telegram-auth:${accountId}:${kind}:${crypto.randomUUID()}`;
    await this.app.redis.set(secretRef, value, "EX", 300);
    return secretRef;
  }

  private async clearAuthorizationRuntimeState(accountId: string): Promise<void> {
    await this.app.prisma.telegramOutboundCommand.updateMany({
      where: {
        telegramAccountId: accountId,
        operation: { in: ["START_AUTH", "SUBMIT_PHONE", "SUBMIT_CODE", "SUBMIT_PASSWORD", "REAUTHORIZE", "CANCEL_AUTH"] },
        status: { in: ["QUEUED", "SENDING", "FAILED_RETRYABLE"] }
      },
      data: { status: "CANCELLED", lastError: null, processedAt: new Date() }
    });

    await this.app.redis.del(`telegram-auth-attempt:${accountId}`);

    let cursor = "0";
    do {
      const [nextCursor, keys] = await this.app.redis.scan(cursor, "MATCH", `telegram-auth:${accountId}:*`, "COUNT", 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await this.app.redis.del(...keys);
      }
    } while (cursor !== "0");
  }

  private async assertNoInFlightAuthCommand(accountId: string, operation: "SUBMIT_CODE" | "SUBMIT_PASSWORD"): Promise<void> {
    const existing = await this.app.prisma.telegramOutboundCommand.findFirst({
      where: {
        telegramAccountId: accountId,
        operation,
        status: { in: ["QUEUED", "SENDING"] }
      },
      select: { id: true }
    });
    if (existing) {
      throw telegramAuthCommandInProgress();
    }
  }

  private assertCoadmin(user: RequestUser): void {
    if (user.role !== "COADMIN" || !user.workspaceId) {
      throw forbidden();
    }
  }

  /**
   * Coadmin and Platform Admin may delete messages. Staff is never allowed.
   */
  private assertMessageDeleteAllowed(user: RequestUser): void {
    if (!user.workspaceId || (user.role !== "COADMIN" && user.role !== "PLATFORM_ADMIN")) {
      throw forbidden();
    }
  }

  /**
   * Allows Coadmin and Staff to read/send within their own workspace. Staff need
   * inbox read/send access to work conversations they claim or are assigned via CRM.
   */
  private assertWorkspaceMember(user: RequestUser): void {
    if (!user.workspaceId || (user.role !== "COADMIN" && user.role !== "STAFF")) {
      throw forbidden();
    }
  }

  private async assertPhoneAvailable(workspaceId: string, accountId: string, phoneNumber: string): Promise<void> {
    const accounts = await this.repository.listPhoneEnvelopes(workspaceId);
    for (const account of accounts) {
      if (account.id === accountId || !account.phoneNumberEncrypted) {
        continue;
      }
      const existing = decryptSecret(account.phoneNumberEncrypted as unknown as EncryptedSecret, this.app.env.TELEGRAM_SESSION_ENCRYPTION_KEY);
      if (existing === phoneNumber) {
        throw new AppError(409, "TELEGRAM_ACCOUNT_ALREADY_CONNECTED", "This Telegram account is already connected.");
      }
    }
  }

  private assertManageable(status: TelegramAccountStatus): void {
    if (!manageableStates.includes(status)) {
      throw invalidTelegramTransition(`Account cannot start authorization while ${status}`);
    }
  }

  private assertAuthorizationState(current: TelegramAuthorizationState, allowed: readonly TelegramAuthorizationState[]): void {
    if (!allowed.includes(current)) {
      throw invalidTelegramTransition(`Authorization state ${current} cannot accept this operation`);
    }
  }

  private async auditState(
    user: RequestUser,
    workspaceId: string,
    accountId: string,
    action: string,
    nextState: TelegramAuthorizationState
  ): Promise<void> {
    await this.audit.record({
      workspaceId,
      actorId: user.id,
      action,
      metadata: { telegramAccountId: accountId, authorizationState: nextState, sessionId: user.sessionId }
    });
  }

  private toAccountDto(account: {
    id: string;
    workspaceId: string;
    developerAppId: string;
    displayName: string;
    telegramUserId: string | null;
    telegramUsername: string | null;
    status: string;
    authorizationState: string;
    syncState: string;
    lastConnectedAt: Date | null;
    lastUpdateAt: Date | null;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    createdAt: Date;
    phoneNumberEncrypted?: unknown | null;
  }, user: RequestUser): TelegramAccountDto {
    return applyAccountPrivacy(
      {
        id: account.id,
        workspaceId: account.workspaceId,
        developerAppId: account.developerAppId,
        displayName: this.safeDisplayName(account.displayName),
        maskedPhoneNumber: this.maskPhone(account.phoneNumberEncrypted),
        telegramUserId: account.telegramUserId,
        telegramUsername: account.telegramUsername,
        status: account.status,
        authorizationState: account.authorizationState,
        syncState: account.syncState,
        lastConnectedAt: account.lastConnectedAt?.toISOString() ?? null,
        lastUpdateAt: account.lastUpdateAt?.toISOString() ?? null,
        lastErrorCode: account.lastErrorCode,
        lastErrorMessage: account.lastErrorMessage,
        createdAt: account.createdAt.toISOString()
      },
      user.role as Role
    );
  }

  private maskPhone(phoneEnvelope: unknown | null | undefined): string | null {
    if (!this.isEncryptedSecret(phoneEnvelope)) {
      return null;
    }
    const phone = decryptSecret(phoneEnvelope, this.app.env.TELEGRAM_SESSION_ENCRYPTION_KEY);
    if (phone.length <= 5) {
      return "***";
    }
    return `${phone.slice(0, 3)}${"*".repeat(Math.max(3, phone.length - 6))}${phone.slice(-3)}`;
  }

  private safeDisplayName(displayName: string): string {
    return /^\+?[1-9]\d{7,14}$/.test(displayName.trim()) ? "Telegram account" : displayName;
  }

  private isEncryptedSecret(value: unknown): value is EncryptedSecret {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const candidate = value as Partial<EncryptedSecret>;
    return typeof candidate.iv === "string" && typeof candidate.tag === "string" && typeof candidate.ciphertext === "string";
  }

  private toChatDto(chat: {
    id: string;
    telegramAccountId: string;
    telegramChatId: string;
    chatType: string;
    title: string;
    username: string | null;
    firstName?: string | null;
    lastName?: string | null;
    peerPhone?: string | null;
    lastMessagePreview: string | null;
    lastMessageAt: Date | null;
    unreadCount: number;
    isPinned: boolean;
    isBot?: boolean;
    rawMetadataJson?: unknown;
    messages?: Array<{ direction: "INBOUND" | "OUTBOUND" }>;
    crmStatus?: string;
    assignedUserId?: string | null;
    assignedUser?: { name: string } | null;
    assignedAt?: Date | null;
    claimedAt?: Date | null;
    needsCrmAttention?: boolean;
    tags?: Array<{ tag: { id: string; name: string; color: string; archivedAt: Date | null } }>;
  }, user: RequestUser): TelegramChatDto {
    const firstName = chat.firstName ?? readMetaString(chat.rawMetadataJson, "firstName");
    const lastName = chat.lastName ?? readMetaString(chat.rawMetadataJson, "lastName");
    const phone = chat.peerPhone ?? readMetaString(chat.rawMetadataJson, "phone");
    const isBot = Boolean(chat.isBot) || detectBot(chat.username, chat.rawMetadataJson);
    const composedTitle = composeDisplayTitle({
      title: chat.title,
      firstName,
      lastName,
      username: chat.username,
      chatType: chat.chatType,
      isBot,
      telegramChatId: chat.telegramChatId,
      phone
    });
    return applyChatPrivacy(
      {
        id: chat.id,
        telegramAccountId: chat.telegramAccountId,
        telegramChatId: chat.telegramChatId,
        chatType: chat.chatType,
        title: composedTitle,
        username: chat.username,
        firstName,
        lastName,
        phone,
        lastMessagePreview: chat.lastMessagePreview,
        lastMessageAt: chat.lastMessageAt?.toISOString() ?? null,
        lastMessageDirection: chat.messages?.[0]?.direction ?? null,
        unreadCount: chat.unreadCount,
        isPinned: chat.isPinned,
        isBot,
        identityResolved: isUsableHumanDisplayTitle(composedTitle, chat.telegramChatId),
        crmStatus: (chat.crmStatus as TelegramChatDto["crmStatus"]) ?? "NEW",
        assignedUserId: chat.assignedUserId ?? null,
        assignedUserName: chat.assignedUser?.name ?? null,
        assignedAt: chat.assignedAt?.toISOString() ?? null,
        claimedAt: chat.claimedAt?.toISOString() ?? null,
        needsCrmAttention: chat.needsCrmAttention ?? false,
        tags: (chat.tags ?? []).map((chatTag) => ({
          id: chatTag.tag.id,
          name: chatTag.tag.name,
          color: chatTag.tag.color,
          archivedAt: chatTag.tag.archivedAt?.toISOString() ?? null
        }))
      },
      user.role as Role
    );
  }

  private async toMessageDto(
    message: {
      id: string;
      telegramAccountId: string;
      telegramChatDbId: string;
      telegramMessageId: string;
      senderTelegramUserId: string | null;
      direction: "INBOUND" | "OUTBOUND";
      contentType: string;
      textContent: string;
      caption?: string | null;
      mimeType?: string | null;
      fileName?: string | null;
      fileSizeBytes?: bigint | number | null;
      width?: number | null;
      height?: number | null;
      durationSeconds?: number | null;
      waveformJson?: unknown;
      mediaMetadataJson?: unknown;
      mediaStorageKey?: string | null;
      thumbnailStorageKey?: string | null;
      mediaDownloadState?: string | null;
      mediaUploadState?: string | null;
      mediaError?: string | null;
      replyToTelegramMessageId: string | null;
      telegramCreatedAt: Date;
      telegramEditedAt: Date | null;
      internalSenderUserId: string | null;
      internalSenderSessionId?: string | null;
      internalSenderRole?: string | null;
      internalSenderName?: string | null;
      sendStatus: string;
      workspaceId?: string;
      deletedAt?: Date | null;
      deletionScope?: string | null;
      telegramDeleteStatus?: string | null;
    },
    chat: {
      title: string;
      chatType: string;
      username: string | null;
      rawMetadataJson?: unknown;
      workspaceId?: string;
    },
    user: RequestUser
  ): Promise<TelegramMessageDto> {
    const contentType = (message.contentType || "TEXT") as TelegramContentType;
    const metadata =
      message.mediaMetadataJson && typeof message.mediaMetadataJson === "object" && !Array.isArray(message.mediaMetadataJson)
        ? (message.mediaMetadataJson as Record<string, unknown>)
        : null;
    const webPreviewRaw = metadata?.webPreview;
    const webPreview =
      webPreviewRaw && typeof webPreviewRaw === "object" && !Array.isArray(webPreviewRaw)
        ? {
            url: typeof (webPreviewRaw as { url?: unknown }).url === "string" ? (webPreviewRaw as { url: string }).url : "",
            title:
              typeof (webPreviewRaw as { title?: unknown }).title === "string"
                ? (webPreviewRaw as { title: string }).title
                : null,
            description:
              typeof (webPreviewRaw as { description?: unknown }).description === "string"
                ? (webPreviewRaw as { description: string }).description
                : null
          }
        : null;

    let mediaUrl: string | null = null;
    let thumbnailUrl: string | null = null;
    let mediaDownloadState = (message.mediaDownloadState as TelegramMessageDto["mediaDownloadState"]) ?? "NONE";
    let mediaError = message.mediaError ?? null;
    const workspaceId = message.workspaceId ?? chat.workspaceId;
    if (message.mediaStorageKey && workspaceId) {
      try {
        this.app.storage.assertWorkspaceKey(workspaceId, message.mediaStorageKey);
        const exists = await this.app.storage.objectExists(message.mediaStorageKey);
        if (!exists) {
          mediaUrl = null;
          mediaDownloadState = "UNAVAILABLE";
          mediaError = "OBJECT_MISSING";
          void this.app.prisma.telegramMessage
            .update({
              where: { id: message.id },
              data: {
                mediaDownloadState: "UNAVAILABLE",
                mediaUploadState: "UNAVAILABLE",
                mediaError: "OBJECT_MISSING"
              }
            })
            .catch(() => undefined);
        } else {
          mediaUrl = this.buildProxiedMediaUrl(user, message.id, workspaceId, "media");
        }
      } catch {
        mediaUrl = null;
      }
    }
    if (message.thumbnailStorageKey && workspaceId && mediaDownloadState !== "UNAVAILABLE") {
      try {
        this.app.storage.assertWorkspaceKey(workspaceId, message.thumbnailStorageKey);
        const thumbExists = await this.app.storage.objectExists(message.thumbnailStorageKey);
        if (thumbExists) {
          thumbnailUrl = this.buildProxiedMediaUrl(user, message.id, workspaceId, "thumbnail");
        }
      } catch {
        thumbnailUrl = null;
      }
    }

    return applyMessagePrivacy(
      {
        id: message.id,
        telegramAccountId: message.telegramAccountId,
        chatId: message.telegramChatDbId,
        telegramMessageId: message.telegramMessageId,
        direction: message.direction,
        contentType,
        mediaType: contentTypeToMediaType(contentType),
        text: message.textContent,
        caption: message.caption ?? null,
        mimeType: message.mimeType ?? null,
        fileName: message.fileName ?? null,
        fileSizeBytes: message.fileSizeBytes == null ? null : Number(message.fileSizeBytes),
        width: message.width ?? null,
        height: message.height ?? null,
        durationSeconds: message.durationSeconds ?? null,
        waveform: Array.isArray(message.waveformJson) ? (message.waveformJson as number[]) : null,
        mediaMetadata: metadata,
        mediaUrl,
        thumbnailUrl,
        mediaDownloadState,
        mediaUploadState:
          mediaDownloadState === "UNAVAILABLE"
            ? "UNAVAILABLE"
            : ((message.mediaUploadState as TelegramMessageDto["mediaUploadState"]) ?? "NONE"),
        mediaError,
        sentAt: message.telegramCreatedAt.toISOString(),
        editedAt: message.telegramEditedAt?.toISOString() ?? null,
        isEdited: Boolean(message.telegramEditedAt),
        isDeleted: Boolean(message.deletedAt),
        deletedAt: message.deletedAt?.toISOString() ?? null,
        deletionScope: (message.deletionScope as TelegramMessageDto["deletionScope"]) ?? null,
        telegramDeleteStatus: (message.telegramDeleteStatus as TelegramMessageDto["telegramDeleteStatus"]) ?? "NONE",
        senderTelegramUserId: message.senderTelegramUserId,
        senderDisplayName: resolveSenderDisplayName(message.direction, chat),
        replyToTelegramMessageId: message.replyToTelegramMessageId,
        replyPreview: null,
        webPreview: webPreview && webPreview.url ? webPreview : null,
        internalSenderUserId: message.internalSenderUserId,
        internalSenderSessionId: message.internalSenderSessionId ?? null,
        internalSenderRole: (message.internalSenderRole as TelegramMessageDto["internalSenderRole"]) ?? null,
        internalSenderName: message.internalSenderName ?? null,
        attributionSource: message.internalSenderUserId ? "ATLAS" : message.direction === "OUTBOUND" ? "TELEGRAM_EXTERNAL" : null,
        originKind: classifyMessageOrigin({
          direction: message.direction,
          internalSenderUserId: message.internalSenderUserId,
          telegramMessageId: message.telegramMessageId
        }),
        sendStatus: message.sendStatus
      },
      user.role as Role
    );
  }

  private buildProxiedMediaUrl(
    user: RequestUser,
    messageId: string,
    workspaceId: string,
    variant: "media" | "thumbnail"
  ): string {
    const path = buildTelegramMessageMediaPath(messageId, variant);
    const ticket = signMediaAccessTicket(this.app.env.JWT_ACCESS_SECRET, {
      messageId,
      workspaceId,
      userId: user.id,
      variant
    });
    return withMediaAccessTicket(path, ticket);
  }
}

function detectBot(username: string | null, rawMetadataJson: unknown): boolean {
  if (username?.toLowerCase().endsWith("bot") || username?.toLowerCase() === "botfather") return true;
  if (rawMetadataJson && typeof rawMetadataJson === "object" && !Array.isArray(rawMetadataJson)) {
    return Boolean((rawMetadataJson as { bot?: unknown }).bot);
  }
  return false;
}

function readMetaString(rawMetadataJson: unknown, key: string): string | null {
  if (!rawMetadataJson || typeof rawMetadataJson !== "object" || Array.isArray(rawMetadataJson)) return null;
  const value = (rawMetadataJson as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function composeDisplayTitle(input: {
  title: string;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  chatType: string;
  isBot: boolean;
  telegramChatId: string;
  phone?: string | null;
}): string {
  return buildCrmContactDisplayTitle({
    firstName: input.firstName,
    lastName: input.lastName,
    username: input.username,
    phone: input.phone ?? null,
    telegramChatId: input.telegramChatId,
    groupTitle: input.title,
    chatType: input.chatType,
    isBot: input.isBot
  });
}

function resolveSenderDisplayName(
  direction: "INBOUND" | "OUTBOUND",
  chat: { title: string; chatType: string; username: string | null }
): string | null {
  if (direction === "OUTBOUND") return "You";
  const title = chat.title?.trim() ?? "";
  if (!title || /^-?\d{5,}$/.test(title) || /^unknown(\s|$)/i.test(title)) return null;
  if (chat.chatType === "PRIVATE" || chat.chatType === "UNKNOWN" || detectBot(chat.username, null)) {
    return title;
  }
  return null;
}
