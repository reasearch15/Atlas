import { Prisma, type CrmContactKind, type PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import {
  buildCrmContactDisplayTitle,
  isOfficialTelegramServicePeer,
  reopenStatusOnInbound,
  shouldIgnoreTelegramDialog,
  type CrmConversationStatus,
  type TelegramMessageDto
} from "@atlas/shared";
import { decryptSecret, type EncryptedSecret } from "@atlas/shared/session-encryption";
import type { WorkerEnv } from "./env";
import { AccountLease } from "./heartbeat";
import { TelegramClientAdapter, type NormalizedTextMessage, type TelegramRuntime, isUsableDisplayTitle } from "./telegram-client";
import { messageCreatedEvent, chatUpdatedEvent, chatUpdatedFieldsFromRow } from "./update-normalizer";
import { toTelegramMessageDto } from "./message-dto";
import { buildIdentityFillUpdate } from "./chat-identity";
import { createMediaObjectStore } from "./media-storage";
import { enqueueMediaDownload } from "./media-pipeline";
import { mediaPersistFields } from "./media-persist";
import { confirmOutboundDelivery, isRemoteTelegramMessageId } from "./delivery-status";

const activeAccounts = new Map<string, TelegramRuntime>();

/**
 * Periodically attaches live Telegram update handlers for connected accounts.
 */
export function startLiveSync(prisma: PrismaClient, redis: Redis, env: WorkerEnv): NodeJS.Timeout {
  const adapter = new TelegramClientAdapter(env);
  const lease = new AccountLease(prisma, env);
  const store = createMediaObjectStore(env);
  const timer = setInterval(() => {
    void attachConnectedAccounts(prisma, redis, adapter, lease, env, store);
  }, 10_000);
  void attachConnectedAccounts(prisma, redis, adapter, lease, env, store);
  return timer;
}

/**
 * Returns the in-process live-sync runtime for an account, if attached.
 */
export function getLiveSyncRuntime(accountId: string): TelegramRuntime | null {
  return activeAccounts.get(accountId) ?? null;
}

/**
 * Detaches and disconnects a single live-sync runtime (permanent delete / stop).
 */
export async function detachLiveSyncAccount(accountId: string): Promise<void> {
  const runtime = activeAccounts.get(accountId);
  if (!runtime) return;
  activeAccounts.delete(accountId);
  try {
    await runtime.client.disconnect();
  } catch {
    // ignore disconnect errors during teardown
  }
}

/**
 * Disconnects all active Telegram runtimes.
 */
export async function stopLiveSync(): Promise<void> {
  for (const runtime of activeAccounts.values()) {
    await runtime.client.disconnect();
  }
  activeAccounts.clear();
}

async function attachConnectedAccounts(
  prisma: PrismaClient,
  redis: Redis,
  adapter: TelegramClientAdapter,
  lease: AccountLease,
  env: WorkerEnv,
  store: ReturnType<typeof createMediaObjectStore>
): Promise<void> {
  const accounts = await prisma.telegramAccount.findMany({
    where: { status: { in: ["CONNECTED", "SYNCING", "DEGRADED"] }, sessionEncrypted: { not: Prisma.JsonNull }, developerApp: { status: "ACTIVE", deletedAt: null } },
    include: { developerApp: true },
    take: 5
  });

  for (const account of accounts) {
    if (activeAccounts.has(account.id) || !(await lease.acquire(account.id)) || !account.sessionEncrypted) {
      continue;
    }
    const runtime = await adapter.connect(account.sessionEncrypted as unknown as EncryptedSecret, {
      apiId: account.developerApp.apiId,
      apiHash: decryptSecret(account.developerApp.encryptedApiHash as unknown as EncryptedSecret, env.TELEGRAM_SESSION_ENCRYPTION_KEY)
    }, { mode: "live" });
    activeAccounts.set(account.id, runtime);
    const selfTelegramUserId = await adapter.resolveSelfUserId(runtime);
    adapter.listenForTextMessages(runtime, async (message) => {
      if (isOfficialTelegramServicePeer(message.telegramChatId)) {
        return;
      }
      if (selfTelegramUserId && message.telegramChatId === selfTelegramUserId) {
        return;
      }
      const chat = await upsertChat(prisma, adapter, runtime, account.workspaceId, account.id, message, selfTelegramUserId);
      if (!chat) {
        return;
      }
      const persisted = await persistInboundMessage(prisma, redis, account.workspaceId, account.id, chat.id, message);
      const refreshed = await prisma.telegramChat.findUnique({ where: { id: chat.id } });
      await redis.publish("atlas.workspace-events", JSON.stringify(messageCreatedEvent(account.workspaceId, persisted)));
      if (refreshed) {
        await redis.publish(
          "atlas.workspace-events",
          JSON.stringify(
            chatUpdatedEvent(
              account.workspaceId,
              chatUpdatedFieldsFromRow({
                ...refreshed,
                lastMessageDirection: persisted.direction
              })
            )
          )
        );
      }
      if (message.needsBinaryDownload && persisted.mediaDownloadState === "PENDING") {
        void enqueueMediaDownload({
          prisma,
          redis,
          adapter,
          runtime,
          store,
          workspaceId: account.workspaceId,
          messageId: persisted.id,
          telegramMessage: message
        });
      }
      await prisma.telegramAccount.update({
        where: { id: account.id },
        data: {
          lastUpdateAt: new Date(),
          status: "CONNECTED",
          syncState: "LIVE",
          lastErrorCode: null,
          lastErrorMessage: null
        }
      });
    });
  }
}

async function upsertChat(
  prisma: PrismaClient,
  adapter: TelegramClientAdapter,
  runtime: TelegramRuntime,
  workspaceId: string,
  telegramAccountId: string,
  message: NormalizedTextMessage,
  selfTelegramUserId: string | null
) {
  const existing = await prisma.telegramChat.findUnique({
    where: { telegramAccountId_telegramChatId: { telegramAccountId, telegramChatId: message.telegramChatId } }
  });

  if (existing?.isArchived) {
    return null;
  }

  let identity = null as Awaited<ReturnType<TelegramClientAdapter["resolveChatIdentity"]>> | null;
  const needsIdentity =
    !existing ||
    existing.chatType === "UNKNOWN" ||
    !existing.accessHash ||
    !isUsableDisplayTitle(existing.title, existing.telegramChatId) ||
    (!existing.firstName && !existing.lastName && !existing.username);

  if (needsIdentity) {
    try {
      identity = await adapter.resolveChatIdentity(runtime, message.telegramChatId, {
        ...(existing?.chatType ? { chatType: existing.chatType } : {}),
        ...(existing?.username != null ? { username: existing.username } : {}),
        ...(existing?.accessHash != null ? { accessHash: existing.accessHash } : {}),
        ...(existing?.peerType != null ? { peerType: existing.peerType } : {}),
        ...(existing?.peerPhone != null ? { phone: existing.peerPhone } : {})
      });
    } catch {
      identity = null;
    }
  }

  if (
    identity &&
    adapter.isIgnorableDialog(identity, selfTelegramUserId)
  ) {
    if (existing) {
      await prisma.telegramChat.update({
        where: { id: existing.id },
        data: { isArchived: true, unreadCount: 0, needsCrmAttention: false, isPinned: false }
      });
    }
    return null;
  }

  if (
    shouldIgnoreTelegramDialog({
      telegramChatId: message.telegramChatId,
      chatType: identity?.chatType ?? existing?.chatType ?? "UNKNOWN",
      title: identity?.title ?? existing?.title ?? null,
      username: identity?.username ?? existing?.username ?? null,
      firstName: identity?.firstName ?? existing?.firstName ?? null,
      lastName: identity?.lastName ?? existing?.lastName ?? null,
      isSelf: identity?.isSelf ?? false,
      isSupport: identity?.isSupport ?? false,
      isArchived: identity?.isArchived ?? false,
      selfTelegramUserId
    })
  ) {
    if (existing) {
      await prisma.telegramChat.update({
        where: { id: existing.id },
        data: { isArchived: true, unreadCount: 0, needsCrmAttention: false, isPinned: false }
      });
    }
    return null;
  }

  const crmContactId = existing?.crmContactId ?? (await linkCrmContact(prisma, workspaceId, message, identity));
  const reopenedStatus =
    existing && !message.isOutgoing ? reopenStatusOnInbound(existing.crmStatus as CrmConversationStatus) : null;
  const attentionAt = new Date();

  const updateData: Prisma.TelegramChatUncheckedUpdateInput = {
    lastMessageId: message.telegramMessageId,
    lastMessagePreview: sanitizeMessagePreview(message.previewText),
    lastMessageAt: message.sentAt
  };
  if (existing && !existing.crmContactId && crmContactId) {
    updateData.crmContactId = crmContactId;
  }
  if (!message.isOutgoing) {
    updateData.unreadCount = { increment: 1 };
    updateData.needsCrmAttention = true;
    updateData.crmAttentionAt = attentionAt;
    if (reopenedStatus) {
      updateData.crmStatus = reopenedStatus;
    }
  }
  if (identity) {
    Object.assign(
      updateData,
      buildIdentityFillUpdate(
        {
          title: existing?.title ?? "",
          telegramChatId: message.telegramChatId,
          username: existing?.username ?? null,
          firstName: existing?.firstName ?? null,
          lastName: existing?.lastName ?? null,
          chatType: existing?.chatType ?? "UNKNOWN",
          isBot: existing?.isBot ?? false,
          photoMetadata: existing?.photoMetadata ?? null,
          rawMetadataJson: existing?.rawMetadataJson ?? null,
          accessHash: existing?.accessHash ?? null,
          peerType: existing?.peerType ?? null,
          peerPhone: existing?.peerPhone ?? null
        },
        identity
      )
    );
  }

  const createTitle =
    identity?.title ??
    buildCrmContactDisplayTitle({
      firstName: identity?.firstName ?? null,
      lastName: identity?.lastName ?? null,
      username: identity?.username ?? null,
      phone: identity?.phone ?? null,
      telegramChatId: message.telegramChatId,
      chatType: identity?.chatType ?? "UNKNOWN",
      isBot: identity?.isBot ?? false
    });

  const chat = await prisma.telegramChat.upsert({
    where: { telegramAccountId_telegramChatId: { telegramAccountId, telegramChatId: message.telegramChatId } },
    update: updateData,
    create: {
      workspaceId,
      telegramAccountId,
      telegramChatId: message.telegramChatId,
      chatType: identity?.chatType ?? "UNKNOWN",
      title: createTitle,
      username: identity?.username ?? null,
      firstName: identity?.firstName ?? null,
      lastName: identity?.lastName ?? null,
      isBot: identity?.isBot ?? false,
      lastMessageId: message.telegramMessageId,
      lastMessagePreview: sanitizeMessagePreview(message.previewText),
      lastMessageAt: message.sentAt,
      unreadCount: message.isOutgoing ? 0 : 1,
      accessHash: identity?.accessHash ?? null,
      peerType: identity?.peerType ?? null,
      peerPhone: identity?.phone ?? null,
      rawMetadataJson: (identity?.raw as Prisma.InputJsonObject | undefined) ?? {},
      crmContactId,
      crmStatus: "NEW",
      needsCrmAttention: true,
      crmAttentionAt: attentionAt
    }
  });

  if (existing && reopenedStatus) {
    await prisma.crmStatusHistory.create({
      data: {
        workspaceId,
        chatId: chat.id,
        fromStatus: existing.crmStatus,
        toStatus: reopenedStatus,
        actorUserId: null,
        reason: "inbound_reopen"
      }
    });
  }

  return chat;
}

/**
 * Ensures a CRM contact exists for the peer and returns its id. Reused across
 * inbound messages for the same peer via the workspaceId + telegramPeerId unique key.
 */
async function linkCrmContact(
  prisma: PrismaClient,
  workspaceId: string,
  message: NormalizedTextMessage,
  identity: {
    chatType: string;
    title: string;
    username: string | null;
    firstName: string | null;
    lastName: string | null;
    phone?: string | null;
  } | null
): Promise<string> {
  const displayName = buildCrmContactDisplayTitle({
    firstName: identity?.firstName ?? null,
    lastName: identity?.lastName ?? null,
    username: identity?.username ?? null,
    phone: identity?.phone ?? null,
    telegramChatId: message.telegramChatId,
    groupTitle: identity?.title ?? null,
    chatType: identity?.chatType ?? "PRIVATE"
  });

  const contact = await prisma.crmContact.upsert({
    where: { workspaceId_telegramPeerId: { workspaceId, telegramPeerId: message.telegramChatId } },
    update: {
      lastSeenAt: new Date(),
      ...(identity?.username ? { username: identity.username } : {})
    },
    create: {
      workspaceId,
      telegramPeerId: message.telegramChatId,
      kind: mapContactKind(identity?.chatType),
      displayName,
      username: identity?.username ?? null
    }
  });

  // Upgrade placeholder CRM names without overwriting curated contact names.
  if (/^unknown(\s|$)/i.test(contact.displayName) && !/^unknown(\s|$)/i.test(displayName)) {
    await prisma.crmContact.update({
      where: { id: contact.id },
      data: { displayName }
    });
  }

  return contact.id;
}

function mapContactKind(chatType: string | undefined): CrmContactKind {
  if (chatType === "PRIVATE") return "PRIVATE";
  if (chatType === "GROUP" || chatType === "SUPERGROUP") return "GROUP";
  if (chatType === "CHANNEL") return "CHANNEL";
  return "UNKNOWN";
}

function sanitizeMessagePreview(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/[\uD800-\uDFFF]/g, "\uFFFD")
    .slice(0, 500);
}

async function persistInboundMessage(
  prisma: PrismaClient,
  redis: Redis,
  workspaceId: string,
  telegramAccountId: string,
  chatDbId: string,
  message: NormalizedTextMessage
): Promise<TelegramMessageDto> {
  const direction = message.isOutgoing ? "OUTBOUND" : "INBOUND";
  const sendStatus = message.isOutgoing ? "SENT" : "RECEIVED";
  const persisted = await prisma.telegramMessage.upsert({
    where: {
      telegramAccountId_telegramChatId_telegramMessageId: {
        telegramAccountId,
        telegramChatId: message.telegramChatId,
        telegramMessageId: message.telegramMessageId
      }
    },
    update: {
      // Correct direction if a race created the row before outbound delivery finished.
      // Never regress DELIVERED/READ back to SENT when Telegram echoes our own message.
      ...(message.isOutgoing
        ? {
            direction: "OUTBOUND" as const,
            ...(isRemoteTelegramMessageId(message.telegramMessageId) ? {} : { sendStatus: "SENT" as const })
          }
        : {})
    },
    create: {
      workspaceId,
      telegramAccountId,
      telegramChatDbId: chatDbId,
      telegramChatId: message.telegramChatId,
      telegramMessageId: message.telegramMessageId,
      senderTelegramUserId: message.senderTelegramUserId,
      direction,
      contentType: message.contentType,
      textContent: message.text,
      ...mediaPersistFields(message),
      replyToTelegramMessageId: message.replyToTelegramMessageId,
      telegramCreatedAt: message.sentAt,
      telegramEditedAt: message.editedAt,
      sendStatus:
        message.isOutgoing && isRemoteTelegramMessageId(message.telegramMessageId) ? "DELIVERED" : sendStatus
    }
  });

  if (
    message.isOutgoing &&
    isRemoteTelegramMessageId(message.telegramMessageId) &&
    (persisted.sendStatus === "SENT" || persisted.sendStatus === "SENDING")
  ) {
    await confirmOutboundDelivery({
      prisma,
      redis,
      workspaceId,
      messageId: persisted.id,
      telegramMessageId: message.telegramMessageId
    });
    const delivered = await prisma.telegramMessage.findUnique({ where: { id: persisted.id } });
    if (delivered) {
      const chat = await prisma.telegramChat.findUnique({ where: { id: chatDbId } });
      return toTelegramMessageDto(delivered, {
        direction: "OUTBOUND",
        chatTitle: chat?.title ?? null,
        chatType: chat?.chatType ?? "UNKNOWN",
        chatUsername: chat?.username ?? null
      });
    }
  }

  const chat = await prisma.telegramChat.findUnique({ where: { id: chatDbId } });
  return toTelegramMessageDto(persisted, {
    direction: persisted.direction === "OUTBOUND" ? "OUTBOUND" : "INBOUND",
    chatTitle: chat?.title ?? null,
    chatType: chat?.chatType ?? "UNKNOWN",
    chatUsername: chat?.username ?? null
  });
}
