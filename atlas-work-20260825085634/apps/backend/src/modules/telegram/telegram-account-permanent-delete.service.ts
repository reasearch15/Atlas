import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import type { TelegramAccountPermanentDeleteResponse } from "@atlas/shared";
import {
  buildTelegramAccountDeleteConfirmation,
  telegramAccountPermanentDeleteEligibleStatuses
} from "@atlas/shared";
import { z } from "zod";
import { AuditService } from "../audit/audit.service";
import type { RequestUser } from "../auth/auth.types";
import { AppError, forbidden } from "../../utils/errors";
import { telegramAccountMustDisconnectFirst, telegramNotFound } from "./telegram.errors";

const permanentDeleteBodySchema = z.object({
  confirmation: z.string().trim().min(8).max(200)
});

/**
 * Durable Coadmin workflow that permanently deletes one Telegram account and its exclusive data.
 */
export class TelegramAccountPermanentDeleteService {
  private readonly audit: AuditService;

  public constructor(private readonly app: FastifyInstance) {
    this.audit = new AuditService(app.prisma);
  }

  /**
   * Permanently deletes a disconnected (or otherwise inactive) Telegram account for a Coadmin.
   */
  public async permanentDelete(user: RequestUser, accountId: string, body: unknown): Promise<TelegramAccountPermanentDeleteResponse> {
    if (user.role !== "COADMIN" || !user.workspaceId) {
      throw forbidden();
    }
    const input = permanentDeleteBodySchema.parse(body);

    const existingDeletion = await this.app.prisma.telegramAccountDeletion.findUnique({
      where: { telegramAccountId: accountId }
    });
    if (existingDeletion?.stage === "COMPLETED" && existingDeletion.outcome === "COMPLETED") {
      return {
        telegramAccountId: accountId,
        safeDisplayName: existingDeletion.safeDisplayName,
        conversationCount: existingDeletion.conversationCount,
        messageCount: existingDeletion.messageCount,
        mediaCount: existingDeletion.mediaCount,
        outcome: "ALREADY_DELETED",
        developerAppId: ""
      };
    }

    const account = await this.app.prisma.telegramAccount.findFirst({
      where: { id: accountId, workspaceId: user.workspaceId }
    });
    if (!account) {
      if (existingDeletion?.stage === "COMPLETED") {
        return {
          telegramAccountId: accountId,
          safeDisplayName: existingDeletion.safeDisplayName,
          conversationCount: existingDeletion.conversationCount,
          messageCount: existingDeletion.messageCount,
          mediaCount: existingDeletion.mediaCount,
          outcome: "ALREADY_DELETED",
          developerAppId: ""
        };
      }
      throw telegramNotFound("Telegram account was not found");
    }

    const eligible = (telegramAccountPermanentDeleteEligibleStatuses as readonly string[]).includes(account.status);
    if (!eligible) {
      throw telegramAccountMustDisconnectFirst();
    }

    const expected = buildTelegramAccountDeleteConfirmation({
      telegramUsername: account.telegramUsername,
      displayName: account.displayName
    });
    if (input.confirmation !== expected) {
      throw new AppError(400, "TELEGRAM_ACCOUNT_DELETE_CONFIRMATION_MISMATCH", `Type ${expected} to confirm permanent deletion.`);
    }

    const safeDisplayName = account.telegramUsername ? `@${account.telegramUsername}` : account.displayName;
    const developerAppId = account.developerAppId;

    const deletion = await this.app.prisma.telegramAccountDeletion.upsert({
      where: { telegramAccountId: account.id },
      create: {
        workspaceId: account.workspaceId,
        telegramAccountId: account.id,
        safeDisplayName,
        actorUserId: user.id,
        stage: "REQUESTED"
      },
      update: {
        stage: "REQUESTED",
        lastError: null,
        outcome: null,
        completedAt: null,
        actorUserId: user.id,
        safeDisplayName
      }
    });

    await this.publish(account.workspaceId, {
      type: "telegram_account.deletion_started",
      eventId: crypto.randomUUID(),
      workspaceId: account.workspaceId,
      telegramAccountId: account.id,
      safeDisplayName
    });

    await this.app.prisma.telegramAccount.update({
      where: { id: account.id },
      data: {
        status: "DELETING" as never,
        authorizationState: "CANCELLED",
        syncState: "PAUSED",
        sessionEncrypted: Prisma.DbNull,
        phoneNumberEncrypted: Prisma.DbNull,
        workerLeaseOwner: null,
        workerLeaseExpiresAt: null,
        lastErrorCode: null,
        lastErrorMessage: null
      }
    });

    await this.app.prisma.telegramAccountDeletion.update({
      where: { id: deletion.id },
      data: { stage: "STOPPING_WORKER" }
    });

    await this.cancelOutboundAndClearRedis(account.id);
    await this.enqueueWorkerStop(account.workspaceId, account.id, user);

    await this.app.prisma.telegramAccountDeletion.update({
      where: { id: deletion.id },
      data: { stage: "DELETING_DATABASE" }
    });

    const chats = await this.app.prisma.telegramChat.findMany({
      where: { telegramAccountId: account.id },
      select: { id: true, crmContactId: true }
    });
    const chatIds = chats.map((chat) => chat.id);
    const contactIds = [...new Set(chats.map((chat) => chat.crmContactId).filter(Boolean))] as string[];

    const messageCount = await this.app.prisma.telegramMessage.count({ where: { telegramAccountId: account.id } });
    const mediaRows = await this.app.prisma.telegramMessage.findMany({
      where: {
        telegramAccountId: account.id,
        OR: [{ mediaStorageKey: { not: null } }, { thumbnailStorageKey: { not: null } }]
      },
      select: { mediaStorageKey: true, thumbnailStorageKey: true }
    });
    const mediaKeys = new Set<string>();
    for (const row of mediaRows) {
      if (row.mediaStorageKey) mediaKeys.add(row.mediaStorageKey);
      if (row.thumbnailStorageKey) mediaKeys.add(row.thumbnailStorageKey);
    }
    const prefixKeys = await this.app.storage
      .listObjectKeys(`workspaces/${account.workspaceId}/telegram/${account.id}/`)
      .catch(() => [] as string[]);
    for (const key of prefixKeys) mediaKeys.add(key);

    await this.app.prisma.$transaction(async (tx) => {
      // Cascade deletes chats, messages, outbound commands, tags joins, notes, activity, status history.
      await tx.telegramAccount.delete({ where: { id: account.id } });

      if (contactIds.length > 0) {
        const stillReferenced = await tx.telegramChat.findMany({
          where: { crmContactId: { in: contactIds } },
          select: { crmContactId: true }
        });
        const keep = new Set(stillReferenced.map((row) => row.crmContactId).filter(Boolean));
        const orphanIds = contactIds.filter((id) => !keep.has(id));
        if (orphanIds.length > 0) {
          await tx.crmContact.deleteMany({ where: { id: { in: orphanIds }, workspaceId: account.workspaceId } });
        }
      }
    });

    await this.app.prisma.telegramAccountDeletion.update({
      where: { id: deletion.id },
      data: {
        stage: "DELETING_MEDIA",
        conversationCount: chatIds.length,
        messageCount,
        mediaCount: mediaKeys.size,
        chatIdsJson: chatIds,
        mediaKeysJson: [...mediaKeys]
      }
    });

    await this.publish(account.workspaceId, {
      type: "conversations.deleted",
      eventId: crypto.randomUUID(),
      workspaceId: account.workspaceId,
      telegramAccountId: account.id,
      chatIds
    });
    await this.publish(account.workspaceId, {
      type: "telegram_account.deleted",
      eventId: crypto.randomUUID(),
      workspaceId: account.workspaceId,
      telegramAccountId: account.id,
      safeDisplayName,
      conversationCount: chatIds.length,
      messageCount,
      mediaCount: mediaKeys.size
    });

    let deletedMedia = 0;
    for (const key of mediaKeys) {
      const stillUsed = await this.app.prisma.telegramMessage.count({
        where: {
          OR: [{ mediaStorageKey: key }, { thumbnailStorageKey: key }]
        }
      });
      if (stillUsed > 0) continue;
      try {
        await this.app.storage.deleteObject(key);
        deletedMedia += 1;
      } catch {
        // Media cleanup is best-effort; deletion job records remaining keys for retry.
      }
    }

    await this.app.prisma.telegramAccountDeletion.update({
      where: { id: deletion.id },
      data: {
        stage: "COMPLETED",
        outcome: "COMPLETED",
        completedAt: new Date(),
        mediaCount: deletedMedia || mediaKeys.size,
        mediaKeysJson: []
      }
    });

    await this.audit.record({
      workspaceId: account.workspaceId,
      actorId: user.id,
      action: "telegram.account.permanent_delete",
      metadata: {
        telegramAccountId: account.id,
        safeDisplayName,
        conversationCount: chatIds.length,
        messageCount,
        mediaCount: mediaKeys.size,
        developerAppId,
        requestedAt: deletion.requestedAt.toISOString(),
        completedAt: new Date().toISOString(),
        outcome: "COMPLETED"
      }
    });

    return {
      telegramAccountId: account.id,
      safeDisplayName,
      conversationCount: chatIds.length,
      messageCount,
      mediaCount: mediaKeys.size,
      outcome: "COMPLETED",
      developerAppId
    };
  }

  private async cancelOutboundAndClearRedis(accountId: string): Promise<void> {
    await this.app.prisma.telegramOutboundCommand.updateMany({
      where: {
        telegramAccountId: accountId,
        status: { in: ["QUEUED", "SENDING", "FAILED_RETRYABLE"] }
      },
      data: { status: "CANCELLED", lastError: null, processedAt: new Date() }
    });

    await this.app.redis.del(`telegram-auth-attempt:${accountId}`);
    await this.app.redis.del(`telegram-identity-backfill:${accountId}`);
    await this.app.redis.del(`telegram-media-backfill:${accountId}`);

    let cursor = "0";
    do {
      const [nextCursor, keys] = await this.app.redis.scan(cursor, "MATCH", `telegram-auth:${accountId}:*`, "COUNT", 100);
      cursor = nextCursor;
      if (keys.length > 0) {
        await this.app.redis.del(...keys);
      }
    } while (cursor !== "0");
  }

  private async enqueueWorkerStop(workspaceId: string, accountId: string, user: RequestUser): Promise<void> {
    try {
      const command = await this.app.prisma.telegramOutboundCommand.create({
        data: {
          workspaceId,
          telegramAccountId: accountId,
          requestedByUserId: user.id,
          requestedBySessionId: user.sessionId,
          operation: "PERMANENT_DELETE" as never,
          payloadJson: {},
          idempotencyKey: `permanent-delete:${accountId}:${crypto.randomUUID()}`
        }
      });
      await this.app.queues.telegramOutbound.add("telegram-outbound", { commandId: command.id }, { jobId: command.id });
    } catch {
      // Account may already be gone / queue unavailable — DB deletion continues.
    }
  }

  private async publish(workspaceId: string, event: Record<string, unknown>): Promise<void> {
    await this.app.redis.publish("atlas.workspace-events", JSON.stringify(event));
  }
}
