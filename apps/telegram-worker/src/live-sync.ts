import { Prisma, type CrmContactKind, type PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import {
  buildCrmContactDisplayTitle,
  buildIncomingCallDedupeKey,
  contactDisplayTitleQuality,
  isOfficialTelegramServicePeer,
  isTemporaryTelegramUserTitle,
  normalizeMarkedTelegramChatId,
  reopenStatusOnInbound,
  shouldIgnoreTelegramDialog,
  type CrmConversationStatus,
  type TelegramMessageDto
} from "@atlas/shared";
import { decryptSecret, type EncryptedSecret } from "@atlas/shared/session-encryption";
import type { WorkerEnv } from "./env";
import { AccountLease } from "./heartbeat";
import {
  TelegramClientAdapter,
  type NormalizedDialog,
  type NormalizedTextMessage,
  type TelegramRuntime,
  isUsableDisplayTitle
} from "./telegram-client";
import { messageCreatedEvent, chatUpdatedEvent, chatUpdatedFieldsFromRow, callIncomingEvent } from "./update-normalizer";
import { toTelegramMessageDto } from "./message-dto";
import { buildIdentityFillUpdate } from "./chat-identity";
import { createMediaObjectStore } from "./media-storage";
import { enqueueMediaDownload } from "./media-pipeline";
import { mediaPersistFields } from "./media-persist";
import { confirmOutboundDelivery, isRemoteTelegramMessageId } from "./delivery-status";
import {
  coalescePeerPersistenceFields,
  isIncompletePrivatePeer,
  isPrivatePeerMetadataComplete,
  normalizePeerType
} from "./entity-resolution";
import { applySoftDeletedMessage } from "./message-deletion";
import { buildCallerDisplayName } from "./phone-call";
const activeAccounts = new Map<string, TelegramRuntime>();
/** In-process guard against reconnect/replay of the same PhoneCallRequested. */
const publishedIncomingCalls = new Set<string>();
const MAX_PUBLISHED_INCOMING_CALLS = 5_000;
/**
 * Publishes a workspace realtime event with bounded retries.
 * Persistence already committed — this only closes the publish-after-write gap.
 */
async function publishWorkspaceEventWithRetry(
  redis: Redis,
  event: unknown,
  attempts = 3
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await redis.publish("atlas.workspace-events", JSON.stringify(event));
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error("workspace event publish failed");
}

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
    adapter.listenForTextMessages(runtime, async (message, liveIdentity, liveMeta) => {
      if (isOfficialTelegramServicePeer(message.telegramChatId)) {
        return;
      }
      if (selfTelegramUserId && message.telegramChatId === selfTelegramUserId) {
        return;
      }
      const chat = await upsertChat(
        prisma,
        adapter,
        runtime,
        account.workspaceId,
        account.id,
        message,
        selfTelegramUserId,
        liveIdentity,
        liveMeta
      );
      if (!chat) {
        return;
      }
      const persisted = await persistInboundMessage(prisma, redis, account.workspaceId, account.id, chat.id, message);
      const refreshed = await prisma.telegramChat.findUnique({ where: { id: chat.id } });
      await publishWorkspaceEventWithRetry(redis, messageCreatedEvent(account.workspaceId, persisted));
      if (refreshed) {
        await publishWorkspaceEventWithRetry(
          redis,
          chatUpdatedEvent(
            account.workspaceId,
            chatUpdatedFieldsFromRow({
              ...refreshed,
              lastMessageDirection: persisted.direction
            })
          )
        );
      }
      if (refreshed && (!isUsableDisplayTitle(refreshed.title, refreshed.telegramChatId) || !refreshed.accessHash)) {
        void improveChatIdentityLater({
          prisma,
          redis,
          adapter,
          runtime,
          workspaceId: account.workspaceId,
          chatId: refreshed.id,
          telegramAccountId: account.id
        });
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

    adapter.listenForDeletedMessages(runtime, async ({ telegramMessageIds, channelId }) => {
      const where =
        channelId != null
          ? {
              telegramAccountId: account.id,
              telegramMessageId: { in: [...telegramMessageIds] },
              telegramChatId: {
                in: [
                  channelId,
                  normalizeMarkedTelegramChatId(channelId, "CHANNEL"),
                  `-100${channelId}`,
                  channelId.startsWith("-100") ? channelId.slice(4) : channelId
                ]
              },
              deletedAt: null
            }
          : {
              telegramAccountId: account.id,
              telegramMessageId: { in: [...telegramMessageIds] },
              deletedAt: null
            };

      const rows = await prisma.telegramMessage.findMany({ where, take: 50 });
      for (const row of rows) {
        await applySoftDeletedMessage(prisma, redis, store, {
          messageId: row.id,
          workspaceId: account.workspaceId,
          telegramAccountId: account.id,
          chatDbId: row.telegramChatDbId,
          telegramMessageId: row.telegramMessageId,
          scope: "EVERYONE",
          deletedByUserId: null,
          deletedByName: null,
          originalContentType: row.contentType,
          priorMediaStorageKey: row.mediaStorageKey,
          priorThumbnailStorageKey: row.thumbnailStorageKey
        });
      }
    });

    adapter.listenForPhoneCalls(runtime, async (call) => {
      if (selfTelegramUserId && call.participantTelegramUserId && call.participantTelegramUserId !== selfTelegramUserId) {
        return;
      }
      if (selfTelegramUserId && call.callerTelegramUserId === selfTelegramUserId) {
        return;
      }

      const dedupeKey = buildIncomingCallDedupeKey(account.id, call.callId);
      if (publishedIncomingCalls.has(dedupeKey)) {
        return;
      }
      rememberIncomingCall(dedupeKey);

      const resolved = await resolveIncomingCallCaller(prisma, adapter, runtime, {
        workspaceId: account.workspaceId,
        telegramAccountId: account.id,
        callerTelegramUserId: call.callerTelegramUserId
      });

      console.info(
        JSON.stringify({
          event: "telegram_live.incoming_call",
          workspaceId: account.workspaceId,
          telegramAccountId: account.id,
          callId: call.callId,
          callerTelegramUserId: call.callerTelegramUserId,
          video: call.video,
          state: "PhoneCallRequested"
        })
      );

      try {
        await publishWorkspaceEventWithRetry(
          redis,
          callIncomingEvent({
            workspaceId: account.workspaceId,
            telegramAccountId: account.id,
            callId: call.callId,
            callerTelegramUserId: call.callerTelegramUserId,
            callerName: resolved.callerName,
            callerUsername: resolved.callerUsername,
            video: call.video,
            timestamp: new Date(call.dateUnix * 1000).toISOString(),
            chatId: resolved.chatId
          })
        );
      } catch (error) {
        publishedIncomingCalls.delete(dedupeKey);
        throw error;
      }
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
  selfTelegramUserId: string | null,
  liveIdentity: NormalizedDialog | null = null,
  liveMeta: {
    readonly hadLiveEntity: boolean;
    readonly hadInputPeerHash: boolean;
    readonly entitySource?: string | null;
  } = {
    hadLiveEntity: false,
    hadInputPeerHash: false,
    entitySource: null
  }
) {
  const existing = await prisma.telegramChat.findUnique({
    where: { telegramAccountId_telegramChatId: { telegramAccountId, telegramChatId: message.telegramChatId } }
  });

  if (existing?.isArchived) {
    return null;
  }

  const metadataCompleteBefore = Boolean(
    existing &&
      isPrivatePeerMetadataComplete({
        chatType: existing.chatType,
        peerType: existing.peerType,
        accessHash: existing.accessHash,
        telegramChatId: existing.telegramChatId,
        title: existing.title,
        firstName: existing.firstName,
        lastName: existing.lastName,
        username: existing.username
      })
  );

  let identity = liveIdentity;
  let entitySource: string | null = liveMeta.entitySource ?? (liveIdentity ? "live_event" : null);

  // Complete private peers: preserve existing metadata, skip expensive resolveChatIdentity.
  // Incomplete: repair from live update first; only then fall back to entity resolve.
  if (!metadataCompleteBefore) {
    const liveStillIncomplete =
      !identity ||
      isIncompletePrivatePeer({
        chatType: identity.chatType,
        peerType: identity.peerType,
        accessHash: identity.accessHash,
        telegramChatId: identity.telegramChatId || message.telegramChatId,
        title: identity.title,
        firstName: identity.firstName,
        lastName: identity.lastName,
        username: identity.username
      });

    if (liveStillIncomplete) {
      try {
        const resolved = await adapter.resolveChatIdentity(runtime, message.telegramChatId, {
          ...(identity?.chatType && identity.chatType !== "UNKNOWN"
            ? { chatType: identity.chatType }
            : existing?.chatType
              ? { chatType: existing.chatType }
              : { chatType: "PRIVATE" }),
          ...(identity?.username ?? existing?.username ? { username: identity?.username ?? existing?.username ?? null } : {}),
          ...(identity?.accessHash ?? existing?.accessHash
            ? { accessHash: identity?.accessHash ?? existing?.accessHash ?? null }
            : {}),
          ...(identity?.peerType ?? existing?.peerType ? { peerType: identity?.peerType ?? existing?.peerType ?? null } : {}),
          ...(identity?.phone ?? existing?.peerPhone ? { phone: identity?.phone ?? existing?.peerPhone ?? null } : {}),
          ...(identity?.firstName ?? existing?.firstName
            ? { firstName: identity?.firstName ?? existing?.firstName ?? null }
            : {}),
          ...(identity?.lastName ?? existing?.lastName ? { lastName: identity?.lastName ?? existing?.lastName ?? null } : {})
        });
        entitySource = entitySource ? `${entitySource}+resolveChatIdentity` : "resolveChatIdentity";
        if (!identity) {
          identity = resolved;
        } else {
          // Merge: never drop a live accessHash; prefer richer titles/names.
          identity = {
            ...resolved,
            accessHash: resolved.accessHash || identity.accessHash,
            peerType: resolved.peerType || identity.peerType,
            firstName: resolved.firstName || identity.firstName,
            lastName: resolved.lastName || identity.lastName,
            username: resolved.username || identity.username,
            phone: resolved.phone || identity.phone,
            title:
              contactDisplayTitleQuality(resolved.title, resolved.telegramChatId) >=
              contactDisplayTitleQuality(identity.title, identity.telegramChatId)
                ? resolved.title
                : identity.title,
            chatType:
              resolved.chatType !== "UNKNOWN"
                ? resolved.chatType
                : identity.chatType !== "UNKNOWN"
                  ? identity.chatType
                  : "PRIVATE"
          };
        }
      } catch {
        // Keep live identity when full resolve fails.
      }
    }
  }

  if (identity && adapter.isIgnorableDialog(identity, selfTelegramUserId)) {
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

  const peerFields = coalescePeerPersistenceFields(
    {
      accessHash: existing?.accessHash ?? null,
      peerType: existing?.peerType ?? null,
      firstName: existing?.firstName ?? null,
      lastName: existing?.lastName ?? null,
      username: existing?.username ?? null,
      peerPhone: existing?.peerPhone ?? null,
      chatType: existing?.chatType ?? null
    },
    {
      accessHash: identity?.accessHash ?? null,
      peerType: identity?.peerType ?? normalizePeerType(null, identity?.chatType ?? "PRIVATE", message.telegramChatId),
      firstName: identity?.firstName ?? null,
      lastName: identity?.lastName ?? null,
      username: identity?.username ?? null,
      phone: identity?.phone ?? null,
      chatType: identity?.chatType ?? existing?.chatType ?? "PRIVATE"
    }
  );

  const createTitle = buildCrmContactDisplayTitle({
    firstName: peerFields.firstName,
    lastName: peerFields.lastName,
    username: peerFields.username,
    phone: peerFields.peerPhone,
    telegramChatId: message.telegramChatId,
    groupTitle: identity?.title ?? existing?.title ?? null,
    chatType: peerFields.chatType,
    isBot: identity?.isBot ?? existing?.isBot ?? false
  });

  // Live event produced durable peer material — refuse silent incomplete creates.
  if (
    !existing &&
    (liveMeta.hadInputPeerHash || liveMeta.hadLiveEntity) &&
    isIncompletePrivatePeer({
      chatType: peerFields.chatType,
      peerType: peerFields.peerType,
      accessHash: peerFields.accessHash,
      telegramChatId: message.telegramChatId,
      title: createTitle,
      firstName: peerFields.firstName,
      lastName: peerFields.lastName,
      username: peerFields.username
    })
  ) {
    console.error(
      JSON.stringify({
        event: "telegram_live.incomplete_peer_refused",
        accountId: telegramAccountId,
        peerId: message.telegramChatId,
        hadLiveEntity: liveMeta.hadLiveEntity,
        hadInputPeerHash: liveMeta.hadInputPeerHash,
        accessHashPresent: Boolean(peerFields.accessHash),
        peerTypeResolved: peerFields.peerType,
        entitySource
      })
    );
    throw new Error(
      `Refusing to create incomplete private peer ${message.telegramChatId}: live entity available but access_hash was not persisted.`
    );
  }

  if (
    !metadataCompleteBefore &&
    isIncompletePrivatePeer({
      chatType: peerFields.chatType,
      peerType: peerFields.peerType,
      accessHash: peerFields.accessHash,
      telegramChatId: message.telegramChatId,
      title: createTitle,
      firstName: peerFields.firstName,
      lastName: peerFields.lastName,
      username: peerFields.username
    })
  ) {
    console.warn(
      JSON.stringify({
        event: "telegram_live.incomplete_private_peer",
        accountId: telegramAccountId,
        peerId: message.telegramChatId,
        chatDbId: existing?.id ?? null,
        metadataCompleteBefore,
        existing: Boolean(existing),
        hadLiveEntity: liveMeta.hadLiveEntity,
        hadInputPeerHash: liveMeta.hadInputPeerHash,
        entitySource,
        peerTypeResolved: peerFields.peerType,
        accessHashPresent: Boolean(peerFields.accessHash)
      })
    );
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
        {
          ...identity,
          accessHash: peerFields.accessHash,
          peerType: (peerFields.peerType as NormalizedDialog["peerType"]) ?? identity.peerType,
          firstName: peerFields.firstName,
          lastName: peerFields.lastName,
          username: peerFields.username,
          phone: peerFields.peerPhone,
          chatType: (peerFields.chatType as NormalizedDialog["chatType"]) || identity.chatType,
          title: createTitle
        }
      )
    );
  }

  // Explicit durable peer fields — never write null over an existing access_hash / peer_type.
  if (peerFields.accessHash) {
    updateData.accessHash = peerFields.accessHash;
  }
  if (peerFields.peerType) {
    updateData.peerType = peerFields.peerType;
  }
  if (peerFields.firstName && !existing?.firstName) {
    updateData.firstName = peerFields.firstName;
  }
  if (peerFields.lastName && !existing?.lastName) {
    updateData.lastName = peerFields.lastName;
  }
  if (peerFields.username && !existing?.username) {
    updateData.username = peerFields.username;
  }
  if (peerFields.peerPhone && !existing?.peerPhone) {
    updateData.peerPhone = peerFields.peerPhone;
  }
  if (peerFields.chatType && peerFields.chatType !== "UNKNOWN") {
    updateData.chatType = peerFields.chatType as "PRIVATE" | "GROUP" | "SUPERGROUP" | "CHANNEL" | "UNKNOWN";
  }
  if (
    contactDisplayTitleQuality(createTitle, message.telegramChatId) >
    contactDisplayTitleQuality(existing?.title ?? "", message.telegramChatId)
  ) {
    updateData.title = createTitle;
  }

  const createChatType = (
    peerFields.chatType === "UNKNOWN" ? "PRIVATE" : peerFields.chatType
  ) as "PRIVATE" | "GROUP" | "SUPERGROUP" | "CHANNEL" | "UNKNOWN";

  const chat = await prisma.telegramChat.upsert({
    where: { telegramAccountId_telegramChatId: { telegramAccountId, telegramChatId: message.telegramChatId } },
    update: updateData,
    create: {
      workspaceId,
      telegramAccountId,
      telegramChatId: message.telegramChatId,
      chatType: createChatType,
      title: createTitle,
      username: peerFields.username,
      firstName: peerFields.firstName,
      lastName: peerFields.lastName,
      isBot: identity?.isBot ?? false,
      lastMessageId: message.telegramMessageId,
      lastMessagePreview: sanitizeMessagePreview(message.previewText),
      lastMessageAt: message.sentAt,
      unreadCount: message.isOutgoing ? 0 : 1,
      accessHash: peerFields.accessHash,
      peerType: peerFields.peerType ?? normalizePeerType(null, peerFields.chatType, message.telegramChatId),
      peerPhone: peerFields.peerPhone,
      rawMetadataJson: (identity?.raw as Prisma.InputJsonObject | undefined) ?? {},
      crmContactId,
      crmStatus: "NEW",
      needsCrmAttention: true,
      crmAttentionAt: attentionAt
    }
  });

  // Invariant: if live hash was available, the row must now carry it.
  if ((liveMeta.hadInputPeerHash || peerFields.accessHash) && !chat.accessHash) {
    console.error(
      JSON.stringify({
        event: "telegram_live.access_hash_persist_failed",
        accountId: telegramAccountId,
        chatDbId: chat.id,
        peerId: message.telegramChatId
      })
    );
    throw new Error(`access_hash failed to persist for chat ${chat.id}`);
  }

  const identityUpdated =
    !metadataCompleteBefore &&
    Boolean(
      (peerFields.accessHash && peerFields.accessHash !== existing?.accessHash) ||
        (peerFields.peerType && peerFields.peerType !== existing?.peerType) ||
        (updateData.title && updateData.title !== existing?.title) ||
        (peerFields.firstName && peerFields.firstName !== existing?.firstName) ||
        (peerFields.lastName && peerFields.lastName !== existing?.lastName) ||
        (peerFields.username && peerFields.username !== existing?.username)
    );

  console.info(
    JSON.stringify({
      event: "telegram_live.peer_metadata_repair",
      accountId: telegramAccountId,
      chatDbId: chat.id,
      peerId: message.telegramChatId,
      metadataCompleteBefore,
      entitySource,
      peerTypeResolved: chat.peerType ?? peerFields.peerType,
      accessHashPresent: Boolean(chat.accessHash),
      identityUpdated
    })
  );

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

  // Upgrade placeholder / temporary CRM names without overwriting curated contact names.
  if (
    (isTemporaryTelegramUserTitle(contact.displayName) || /^unknown(\s|$)/i.test(contact.displayName)) &&
    !isTemporaryTelegramUserTitle(displayName) &&
    !/^unknown(\s|$)/i.test(displayName)
  ) {
    await prisma.crmContact.update({
      where: { id: contact.id },
      data: { displayName }
    });
  }

  return contact.id;
}

/**
 * Background identity improve for chats that were created with a temporary title.
 * Updates the same row and emits telegram.chat.updated — never creates a duplicate.
 */
async function improveChatIdentityLater(input: {
  readonly prisma: PrismaClient;
  readonly redis: Redis;
  readonly adapter: TelegramClientAdapter;
  readonly runtime: TelegramRuntime;
  readonly workspaceId: string;
  readonly chatId: string;
  readonly telegramAccountId: string;
}): Promise<void> {
  const { prisma, redis, adapter, runtime, workspaceId, chatId, telegramAccountId } = input;
  try {
    const chat = await prisma.telegramChat.findFirst({
      where: { id: chatId, telegramAccountId, isArchived: false }
    });
    if (!chat || isUsableDisplayTitle(chat.title, chat.telegramChatId)) return;

    const identity = await adapter.resolveChatIdentity(runtime, chat.telegramChatId, {
      chatType: chat.chatType,
      username: chat.username,
      ...(chat.accessHash != null ? { accessHash: chat.accessHash } : {}),
      ...(chat.peerType != null ? { peerType: chat.peerType } : {}),
      ...(chat.peerPhone != null ? { phone: chat.peerPhone } : {}),
      ...(chat.firstName != null ? { firstName: chat.firstName } : {}),
      ...(chat.lastName != null ? { lastName: chat.lastName } : {})
    });
    const data = buildIdentityFillUpdate(chat, identity);
    if (!data.title && !data.firstName && !data.lastName && !data.username) return;

    const updated = await prisma.telegramChat.update({
      where: { id: chat.id },
      data
    });

    if (chat.crmContactId) {
      const nextName = typeof data.title === "string" ? data.title : updated.title;
      if (isUsableDisplayTitle(nextName, chat.telegramChatId)) {
        await prisma.crmContact
          .updateMany({
            where: {
              id: chat.crmContactId,
              OR: [
                { displayName: { startsWith: "Unknown", mode: "insensitive" } },
                { displayName: { startsWith: "Telegram user ", mode: "insensitive" } },
                { displayName: chat.telegramChatId }
              ]
            },
            data: { displayName: nextName }
          })
          .catch(() => undefined);
      }
    }

    await redis.publish(
      "atlas.workspace-events",
      JSON.stringify(
        chatUpdatedEvent(
          workspaceId,
          chatUpdatedFieldsFromRow({
            ...updated,
            lastMessageDirection: null
          })
        )
      )
    );
  } catch {
    // Best-effort; INITIAL_SYNC / metadata backfill remains the safety net.
  }
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

function rememberIncomingCall(dedupeKey: string): void {
  publishedIncomingCalls.add(dedupeKey);
  if (publishedIncomingCalls.size <= MAX_PUBLISHED_INCOMING_CALLS) {
    return;
  }
  const oldest = publishedIncomingCalls.values().next().value;
  if (typeof oldest === "string") {
    publishedIncomingCalls.delete(oldest);
  }
}

/**
 * Resolves caller display fields for an incoming call notification.
 * Prefers persisted chat identity, then GramJS entity resolution; never throws.
 */
async function resolveIncomingCallCaller(
  prisma: PrismaClient,
  adapter: TelegramClientAdapter,
  runtime: TelegramRuntime,
  input: {
    readonly workspaceId: string;
    readonly telegramAccountId: string;
    readonly callerTelegramUserId: string;
  }
): Promise<{
  readonly callerName: string | null;
  readonly callerUsername: string | null;
  readonly chatId: string | null;
}> {
  const markedId = normalizeMarkedTelegramChatId(input.callerTelegramUserId, "PRIVATE");
  const chat = await prisma.telegramChat.findFirst({
    where: {
      workspaceId: input.workspaceId,
      telegramAccountId: input.telegramAccountId,
      telegramChatId: { in: [input.callerTelegramUserId, markedId] }
    },
    select: {
      id: true,
      title: true,
      firstName: true,
      lastName: true,
      username: true,
      accessHash: true,
      peerType: true,
      chatType: true,
      peerPhone: true
    }
  });

  let callerName = chat
    ? buildCallerDisplayName({
        firstName: chat.firstName,
        lastName: chat.lastName,
        title: chat.title
      })
    : null;
  let callerUsername = chat?.username?.trim() || null;

  if (callerName && callerUsername) {
    return { callerName, callerUsername, chatId: chat?.id ?? null };
  }

  try {
    const identity = await adapter.resolveChatIdentity(runtime, input.callerTelegramUserId, {
      peerType: "USER",
      chatType: chat?.chatType ?? "PRIVATE",
      accessHash: chat?.accessHash ?? null,
      username: chat?.username ?? null,
      phone: chat?.peerPhone ?? null,
      firstName: chat?.firstName ?? null,
      lastName: chat?.lastName ?? null
    });
    callerName =
      buildCallerDisplayName({
        firstName: identity.firstName,
        lastName: identity.lastName,
        title: identity.title
      }) ?? callerName;
    callerUsername = identity.username?.trim() || callerUsername;
  } catch {
    // Entity resolution is best-effort for notifications.
  }

  return {
    callerName,
    callerUsername,
    chatId: chat?.id ?? null
  };
}
