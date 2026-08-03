import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { classifyTelegramFailure, formatTelegramUserFallbackTitle, isRemoteTelegramMessageId, resolveSyncedUnreadCount, sanitizeTelegramError, shouldIgnoreTelegramDialog, type TelegramFailureClassification, type TelegramMessageDto } from "@atlas/shared";
import { decryptSecret, type EncryptedSecret } from "@atlas/shared/session-encryption";
import type { WorkerEnv } from "./env";
import { TelegramClientAdapter, type NormalizedTextMessage, type TelegramApiCredentials, isUsableDisplayTitle, TelegramAuthNetworkTimeoutError, SafeTelegramDeleteError } from "./telegram-client";
import { AccountLease } from "./heartbeat";
import { messageCreatedEvent, chatUpdatedEvent, chatUpdatedFieldsFromRow } from "./update-normalizer";
import { TelegramAuthorizationAttemptStore } from "./auth-attempt";
import { assertPlainSerializable } from "./plain-serialization";
import { detachLiveSyncAccount, getLiveSyncRuntime } from "./live-sync";
import {
  buildIdentityFillUpdate,
  identityUpdateImproves,
  mergeIdentityMetadata,
  needsIdentityBackfillRow,
  type IdentityBackfillCounts
} from "./chat-identity";
import { createMediaObjectStore, type MediaObjectStore } from "./media-storage";
import { runMediaBackfill } from "./media-pipeline";
import { toTelegramMessageDto } from "./message-dto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mediaPersistFields } from "./media-persist";
import { confirmOutboundDelivery, publishMessageUpdated } from "./delivery-status";
import { resolveOutgoingMediaSendMode } from "./outgoing-media";
import {
  TelegramPeerUnresolvedError,
  isPeerEntityResolutionError,
  prefetchDialogEntities,
  type PeerResolutionHints,
  type ResolvedTelegramPeer
} from "./entity-resolution";
import { applySoftDeletedMessage } from "./message-deletion";

const LEASE_ACQUIRE_TIMEOUT_MS = 3_000;

interface CommandJob {
  readonly commandId: string;
}

interface WorkerCommandResult {
  readonly ok: true;
  readonly accountId: string;
  readonly authorizationState?: "WAITING_FOR_CODE" | "WAITING_FOR_PASSWORD" | "CONNECTED";
  readonly telegramUserId?: string | null;
  readonly telegramUsername?: string | null;
  readonly occurredAt: string;
}

type CommandWithAccount = Prisma.TelegramOutboundCommandGetPayload<{
  include: { telegramAccount: { include: { developerApp: true } } };
}>;

/**
 * Consumes Telegram outbound commands from BullMQ.
 */
export function createCommandConsumer(prisma: PrismaClient, redis: Redis, env: WorkerEnv): Worker<CommandJob> {
  const adapter = new TelegramClientAdapter(env);
  const lease = new AccountLease(prisma, env);
  const attempts = new TelegramAuthorizationAttemptStore(redis, env);
  const outboundQueue = new Queue<CommandJob>("telegram-outbound", { connection: redis.duplicate() });
  const store = createMediaObjectStore(env);

  return new Worker<CommandJob>(
    "telegram-outbound",
    async (job) => {
      const command = await prisma.telegramOutboundCommand.findUnique({
        where: { id: job.data.commandId },
        include: { telegramAccount: { include: { developerApp: true } } }
      });
      if (!command || command.status === "SENT" || command.status === "CANCELLED") {
        return;
      }

      const payload = (command.payloadJson ?? {}) as { reason?: string };
      const metadataOnly = command.operation === "INITIAL_SYNC" && payload.reason === "chat-metadata-backfill";

      if (metadataOnly) {
        return processMetadataIdentityBackfillJob(prisma, redis, adapter, lease, env, command);
      }

      if (command.operation === "SEND_TEXT_MESSAGE") {
        return processSendTextJob(prisma, redis, adapter, lease, env, command);
      }

      if (command.operation === "SEND_MEDIA_MESSAGE") {
        return processSendMediaJob(prisma, redis, adapter, lease, env, store, command);
      }
      if (command.operation === "MARK_CHAT_READ") {
        return processMarkChatReadJob(prisma, redis, adapter, lease, env, command);
      }

      if (command.operation === "DELETE_MESSAGE") {
        return processDeleteMessageJob(prisma, redis, adapter, lease, env, store, command);
      }

      if (command.operation === "MEDIA_BACKFILL") {
        return processMediaBackfillJob(prisma, redis, adapter, lease, env, store, command);
      }

      const isTemporaryAuthCommand = ["SUBMIT_PHONE", "SUBMIT_CODE", "SUBMIT_PASSWORD"].includes(command.operation);
      // Temporary auth clients must not acquire the live-sync worker lease.
      if (!isTemporaryAuthCommand && !(await lease.acquireWithTimeout(command.telegramAccountId, LEASE_ACQUIRE_TIMEOUT_MS))) {
        await writeTerminalCommandFailure(prisma, redis, command, "TELEGRAM_ACCOUNT_LEASE_BUSY", "Telegram account lease is busy.");
        throw new SafeTelegramWorkerError("TELEGRAM_ACCOUNT_LEASE_BUSY", "Telegram account lease is busy.");
      }

      await prisma.telegramOutboundCommand.update({
        where: { id: command.id },
        data: { status: "SENDING", attempts: { increment: 1 } }
      });

      try {
        let result: WorkerCommandResult | undefined;
        if (command.operation === "SUBMIT_PHONE") {
          result = await processSubmitPhone(prisma, attempts, adapter, env, command);
        } else if (command.operation === "SUBMIT_CODE") {
          result = await processSubmitCode(prisma, redis, attempts, outboundQueue, adapter, env, command);
        } else if (command.operation === "SUBMIT_PASSWORD") {
          result = await processSubmitPassword(prisma, redis, attempts, outboundQueue, adapter, env, command);
        } else if (command.operation === "INITIAL_SYNC") {
          result = await processInitialSync(prisma, adapter, env, command, redis);
        } else if (command.operation === "DISCONNECT") {
          await attempts.clear(command.telegramAccountId);
          await detachLiveSyncAccount(command.telegramAccountId);
          await prisma.telegramAccount.update({
            where: { id: command.telegramAccountId },
            data: { status: "DISCONNECTED", syncState: "PAUSED", workerLeaseOwner: null, workerLeaseExpiresAt: null }
          });
        } else if (command.operation === "PERMANENT_DELETE") {
          await attempts.clear(command.telegramAccountId);
          await detachLiveSyncAccount(command.telegramAccountId);
          await lease.release(command.telegramAccountId).catch(() => undefined);
          const stillExists = await prisma.telegramAccount.findUnique({
            where: { id: command.telegramAccountId },
            select: { id: true, status: true }
          });
          if (stillExists && stillExists.status !== "DELETING") {
            await prisma.telegramAccount.update({
              where: { id: command.telegramAccountId },
              data: {
                status: "DELETING",
                syncState: "PAUSED",
                authorizationState: "CANCELLED",
                workerLeaseOwner: null,
                workerLeaseExpiresAt: null,
                sessionEncrypted: Prisma.DbNull
              }
            });
          }
        } else {
          throw new Error(`Unsupported Telegram command operation: ${command.operation}`);
        }
        await prisma.telegramOutboundCommand.update({
          where: { id: command.id },
          data: { status: "SENT", processedAt: new Date(), lastError: null }
        });
        if (!isTemporaryAuthCommand) {
          await lease.renew(command.telegramAccountId);
        }
        if (result) {
          assertPlainSerializable(result, "BULLMQ_COMMAND_RESULT");
          return result;
        }
        return { ok: true, accountId: command.telegramAccountId, occurredAt: new Date().toISOString() } satisfies WorkerCommandResult;
      } catch (error) {
        const failure = await markAccountFailure(prisma, command, error);
        await prisma.telegramOutboundCommand.update({
          where: { id: command.id },
          data: {
            status: failure.retryable && command.attempts < 4 ? "FAILED_RETRYABLE" : "FAILED_PERMANENT",
            lastError: formatSafeCommandError(failure.safeErrorCode, failure.safeUserMessage),
            processedAt: new Date()
          }
        });
        throw new SafeTelegramWorkerError(failure.safeErrorCode, failure.safeUserMessage);
      }
    },
    { connection: redis.duplicate(), concurrency: 4 }
  );
}

/**
 * Runs identity metadata backfill via the live-sync runtime when available,
 * otherwise with a hard-timed lease acquire. Never runs dialog/message sync.
 */
async function processMetadataIdentityBackfillJob(
  prisma: PrismaClient,
  redis: Redis,
  adapter: TelegramClientAdapter,
  lease: AccountLease,
  env: WorkerEnv,
  command: CommandWithAccount
): Promise<WorkerCommandResult> {
  await prisma.telegramOutboundCommand.update({
    where: { id: command.id },
    data: { status: "SENDING", attempts: { increment: 1 } }
  });

  const liveRuntime = getLiveSyncRuntime(command.telegramAccountId);
  let runtime: Awaited<ReturnType<TelegramClientAdapter["connect"]>> | null = liveRuntime;
  let ownsTemporaryRuntime = false;

  try {
    if (!runtime) {
      if (!(await lease.acquireWithTimeout(command.telegramAccountId, LEASE_ACQUIRE_TIMEOUT_MS))) {
        await writeMetadataBackfillTerminal(redis, command.telegramAccountId, {
          scanned: 0,
          updated: 0,
          unresolved: 0,
          failed: 0
        }, "TELEGRAM_ACCOUNT_LEASE_BUSY");
        await prisma.telegramOutboundCommand.update({
          where: { id: command.id },
          data: {
            status: "FAILED_PERMANENT",
            lastError: formatSafeCommandError("TELEGRAM_ACCOUNT_LEASE_BUSY", "Telegram account lease is busy."),
            processedAt: new Date()
          }
        });
        throw new SafeTelegramWorkerError("TELEGRAM_ACCOUNT_LEASE_BUSY", "Telegram account lease is busy.");
      }
      if (!command.telegramAccount.sessionEncrypted) {
        throw new Error("TELEGRAM_AUTH_CONTEXT_MISSING");
      }
      runtime = await adapter.connect(
        command.telegramAccount.sessionEncrypted as unknown as EncryptedSecret,
        developerAppCredentials(command.telegramAccount.developerApp, env),
        { mode: "authorization" }
      );
      ownsTemporaryRuntime = true;
    }

    logPlain({
      event: "telegram_sync.metadata_backfill_started",
      accountId: command.telegramAccountId,
      viaLiveSync: !ownsTemporaryRuntime
    });
    const backfill = await runIdentityBackfillBatches(prisma, adapter, runtime, command.telegramAccountId, 1, {
      redis,
      workspaceId: command.workspaceId
    });
    await writeMetadataBackfillTerminal(redis, command.telegramAccountId, backfill);
    await prisma.telegramOutboundCommand.update({
      where: { id: command.id },
      data: { status: "SENT", processedAt: new Date(), lastError: null }
    });
    if (ownsTemporaryRuntime) {
      await lease.renew(command.telegramAccountId);
    }
    logPlain({
      event: "telegram_sync.metadata_backfill_completed",
      accountId: command.telegramAccountId,
      identitiesBackfilled: backfill
    });
    return { ok: true, accountId: command.telegramAccountId, occurredAt: new Date().toISOString(), authorizationState: "CONNECTED" };
  } catch (error) {
    if (error instanceof SafeTelegramWorkerError && error.code === "TELEGRAM_ACCOUNT_LEASE_BUSY") {
      throw error;
    }
    const failure = await markAccountFailure(prisma, command, error);
    await writeMetadataBackfillTerminal(
      redis,
      command.telegramAccountId,
      { scanned: 0, updated: 0, unresolved: 0, failed: 0 },
      failure.safeErrorCode
    );
    await prisma.telegramOutboundCommand.update({
      where: { id: command.id },
      data: {
        status: "FAILED_PERMANENT",
        lastError: formatSafeCommandError(failure.safeErrorCode, failure.safeUserMessage),
        processedAt: new Date()
      }
    });
    throw new SafeTelegramWorkerError(failure.safeErrorCode, failure.safeUserMessage);
  } finally {
    if (ownsTemporaryRuntime && runtime) {
      await adapter.safeDisconnect(runtime);
    }
  }
}

async function writeTerminalCommandFailure(
  prisma: PrismaClient,
  redis: Redis,
  command: CommandWithAccount,
  code: string,
  message: string
): Promise<void> {
  await prisma.telegramOutboundCommand.update({
    where: { id: command.id },
    data: {
      status: "FAILED_PERMANENT",
      attempts: { increment: 1 },
      lastError: formatSafeCommandError(code, message),
      processedAt: new Date()
    }
  });
  if (command.operation === "INITIAL_SYNC") {
    await writeMetadataBackfillTerminal(
      redis,
      command.telegramAccountId,
      { scanned: 0, updated: 0, unresolved: 0, failed: 0 },
      code
    );
  }
}

async function writeMetadataBackfillTerminal(
  redis: Redis,
  accountId: string,
  counts: IdentityBackfillCounts,
  errorCode?: string
): Promise<void> {
  await redis.set(
    identityBackfillKey(accountId),
    JSON.stringify({
      ...counts,
      accountId,
      completedAt: new Date().toISOString(),
      ...(errorCode ? { errorCode } : {})
    }),
    "EX",
    86_400
  );
}

export async function processSubmitPhone(
  prisma: PrismaClient,
  attempts: TelegramAuthorizationAttemptStore,
  adapter: TelegramClientAdapter,
  env: WorkerEnv,
  command: Prisma.TelegramOutboundCommandGetPayload<{ include: { telegramAccount: { include: { developerApp: true } } } }>
): Promise<WorkerCommandResult> {
  if (!command.telegramAccount.phoneNumberEncrypted) {
    throw new Error("Encrypted phone number is required");
  }
  const credentials = developerAppCredentials(command.telegramAccount.developerApp, env);
  const phoneNumber = decryptSecret(command.telegramAccount.phoneNumberEncrypted as unknown as EncryptedSecret, env.TELEGRAM_SESSION_ENCRYPTION_KEY);
  const runtime = await adapter.connectForAuthorization(
    command.telegramAccount.sessionEncrypted as unknown as EncryptedSecret | null,
    credentials
  );
  try {
    const code = await adapter.sendLoginCode(runtime, phoneNumber);
    const attempt = await attempts.save({
      accountId: command.telegramAccountId,
      workspaceId: command.workspaceId,
      developerAppId: command.telegramAccount.developerAppId,
      state: "WAITING_FOR_CODE",
      temporarySession: adapter.exportSessionString(runtime, "SUBMIT_PHONE_TEMP_SESSION"),
      phoneNumber,
      phoneCodeHash: code.phoneCodeHash,
      targetDcId: adapter.sessionDcId(runtime),
      workerId: env.TELEGRAM_WORKER_ID
    });
    await prisma.telegramAccount.update({
      where: { id: command.telegramAccountId },
      data: {
        status: "WAITING_FOR_CODE",
        authorizationState: "CODE_REQUESTED",
        lastUpdateAt: new Date()
      }
    });
    logPlain({ event: "telegram_auth.phone_code_requested", accountId: command.telegramAccountId, dcId: attempt.targetDcId, attemptId: command.telegramAccountId, state: "WAITING_FOR_CODE" });
    return commandResult(command.telegramAccountId, "WAITING_FOR_CODE");
  } finally {
    await adapter.safeDisconnect(runtime);
  }
}

export async function processSubmitCode(
  prisma: PrismaClient,
  redis: Redis,
  attempts: TelegramAuthorizationAttemptStore,
  outboundQueue: Queue<CommandJob>,
  adapter: TelegramClientAdapter,
  env: WorkerEnv,
  command: Prisma.TelegramOutboundCommandGetPayload<{ include: { telegramAccount: { include: { developerApp: true } } } }>
): Promise<WorkerCommandResult> {
  const payload = command.payloadJson as { secretRef?: string };
  const code = payload.secretRef ? await redis.get(payload.secretRef) : null;
  if (!payload.secretRef || !code) {
    throw new Error("Telegram authorization code is unavailable or expired");
  }
  const attempt = await attempts.load(command.telegramAccountId);
  if (!attempt || attempt.state !== "WAITING_FOR_CODE" || !attempt.temporarySession || !attempt.phoneCodeHash) {
    throw new Error("TELEGRAM_AUTH_CONTEXT_MISSING");
  }
  logPlain({
    event: "telegram_auth.code_submission_started",
    accountId: command.telegramAccountId,
    dcId: attempt.targetDcId,
    attemptId: command.telegramAccountId,
    state: "WAITING_FOR_CODE"
  });
  const runtime = await adapter.connectForAuthorization(
    adapter.encryptSessionState({ session: attempt.temporarySession }),
    developerAppCredentials(command.telegramAccount.developerApp, env)
  );
  try {
    await adapter.signInWithCode(runtime, attempt.phoneNumber, attempt.phoneCodeHash, code);
    // Persist authorized session before disconnect so update-loop cleanup cannot race success.
    const result = await completeAuthorization(prisma, attempts, outboundQueue, adapter, runtime, command);
    await redis.del(payload.secretRef);
    return result;
  } catch (error) {
    if (error instanceof Error && /SESSION_PASSWORD_NEEDED/i.test(error.message)) {
      await attempts.save({
        ...attempt,
        state: "WAITING_FOR_PASSWORD",
        temporarySession: adapter.exportSessionString(runtime, "SUBMIT_CODE_PASSWORD_SESSION"),
        targetDcId: adapter.sessionDcId(runtime),
        workerId: env.TELEGRAM_WORKER_ID
      });
      await prisma.telegramAccount.update({
        where: { id: command.telegramAccountId },
        data: { status: "WAITING_FOR_PASSWORD", authorizationState: "PASSWORD_REQUESTED", lastUpdateAt: new Date(), lastErrorCode: null, lastErrorMessage: null }
      });
      await redis.del(payload.secretRef);
      return commandResult(command.telegramAccountId, "WAITING_FOR_PASSWORD");
    }
    // Keep Redis OTP + auth attempt for retryable network/auth timeouts so Retry can reuse them.
    const keepSecret = shouldPreserveAuthSecret(error);
    if (!keepSecret) {
      await redis.del(payload.secretRef);
    }
    throw error;
  } finally {
    await adapter.safeDisconnect(runtime);
  }
}

export async function processSubmitPassword(
  prisma: PrismaClient,
  redis: Redis,
  attempts: TelegramAuthorizationAttemptStore,
  outboundQueue: Queue<CommandJob>,
  adapter: TelegramClientAdapter,
  env: WorkerEnv,
  command: Prisma.TelegramOutboundCommandGetPayload<{ include: { telegramAccount: { include: { developerApp: true } } } }>
): Promise<WorkerCommandResult> {
  const payload = command.payloadJson as { secretRef?: string };
  const password = payload.secretRef ? await redis.get(payload.secretRef) : null;
  if (!payload.secretRef || !password) {
    throw new Error("Telegram 2FA password is unavailable or expired");
  }
  const attempt = await attempts.load(command.telegramAccountId);
  if (!attempt || attempt.state !== "WAITING_FOR_PASSWORD" || !attempt.temporarySession) {
    throw new Error("TELEGRAM_AUTH_CONTEXT_MISSING");
  }
  const runtime = await adapter.connectForAuthorization(
    adapter.encryptSessionState({ session: attempt.temporarySession }),
    developerAppCredentials(command.telegramAccount.developerApp, env)
  );
  try {
    await adapter.signInWithPassword(runtime, password);
    const result = await completeAuthorization(prisma, attempts, outboundQueue, adapter, runtime, command);
    await redis.del(payload.secretRef);
    return result;
  } catch (error) {
    if (!shouldPreserveAuthSecret(error)) {
      await redis.del(payload.secretRef);
    }
    throw error;
  } finally {
    await adapter.safeDisconnect(runtime);
  }
}

async function completeAuthorization(
  prisma: PrismaClient,
  attempts: TelegramAuthorizationAttemptStore,
  outboundQueue: Queue<CommandJob>,
  adapter: TelegramClientAdapter,
  runtime: Awaited<ReturnType<TelegramClientAdapter["connect"]>>,
  command: Prisma.TelegramOutboundCommandGetPayload<{ include: { telegramAccount: { include: { developerApp: true } } } }>
): Promise<WorkerCommandResult> {
  const identity = await adapter.getSelf(runtime);
  await prisma.telegramAccount.update({
    where: { id: command.telegramAccountId },
    data: {
      status: "SYNCING",
      authorizationState: "AUTHORIZED",
      syncState: "INITIAL_SYNC",
      sessionEncrypted: adapter.saveEncryptedSession(runtime) as unknown as Prisma.InputJsonObject,
      telegramUserId: identity.id,
      telegramUsername: identity.username,
      lastConnectedAt: new Date(),
      lastUpdateAt: new Date(),
      lastErrorCode: null,
      lastErrorMessage: null
    }
  });
  await attempts.clear(command.telegramAccountId);
  const syncCommand = await prisma.telegramOutboundCommand.create({
    data: {
      workspaceId: command.workspaceId,
      telegramAccountId: command.telegramAccountId,
      requestedByUserId: command.requestedByUserId,
      requestedBySessionId: command.requestedBySessionId,
      operation: "INITIAL_SYNC",
      payloadJson: {},
      idempotencyKey: `initial-sync:${command.telegramAccountId}:${crypto.randomUUID()}`
    }
  });
  await outboundQueue.add("telegram-outbound", { commandId: syncCommand.id }, { jobId: syncCommand.id });
  return commandResult(command.telegramAccountId, "CONNECTED", identity.id, identity.username);
}

export async function processInitialSync(
  prisma: PrismaClient,
  adapter: TelegramClientAdapter,
  env: WorkerEnv,
  command: Prisma.TelegramOutboundCommandGetPayload<{ include: { telegramAccount: { include: { developerApp: true } } } }>,
  redis?: Redis
): Promise<WorkerCommandResult> {
  if (!command.telegramAccount.sessionEncrypted) {
    throw new Error("TELEGRAM_AUTH_CONTEXT_MISSING");
  }
  logPlain({ event: "telegram_runtime.connect_started", accountId: command.telegramAccountId });
  const runtime = await adapter.connect(
    command.telegramAccount.sessionEncrypted as unknown as EncryptedSecret,
    developerAppCredentials(command.telegramAccount.developerApp, env),
    { mode: "authorization" }
  );
  try {
    const identity = await adapter.getSelf(runtime);
    logPlain({ event: "telegram_runtime.connected", accountId: command.telegramAccountId, telegramUserId: identity.id });
    logPlain({ event: "telegram_sync.initial_started", accountId: command.telegramAccountId });
    const payload = (command.payloadJson ?? {}) as { reason?: string };
    const metadataOnly = payload.reason === "chat-metadata-backfill";
    const savedDialogs = metadataOnly
      ? 0
      : await syncInitialPage(prisma, adapter, runtime, command.workspaceId, command.telegramAccountId);
    const backfill = await runIdentityBackfillBatches(
      prisma,
      adapter,
      runtime,
      command.telegramAccountId,
      5,
      redis ? { redis, workspaceId: command.workspaceId } : { workspaceId: command.workspaceId }
    );
    if (!metadataOnly && redis) {
      try {
        const store = createMediaObjectStore(env);
        await runMediaBackfill({
          prisma,
          redis,
          adapter,
          runtime,
          store,
          workspaceId: command.workspaceId,
          telegramAccountId: command.telegramAccountId,
          limit: 40
        });
      } catch (error) {
        const safe = sanitizeTelegramError(error, false);
        logPlain({
          event: "telegram_sync.media_backfill_skipped",
          accountId: command.telegramAccountId,
          code: safe.code ?? safe.name,
          message: safe.message
        });
      }
    }
    if (redis) {
      await redis.set(
        identityBackfillKey(command.telegramAccountId),
        JSON.stringify({
          ...backfill,
          accountId: command.telegramAccountId,
          completedAt: new Date().toISOString()
        }),
        "EX",
        86_400
      );
    }
    await prisma.telegramAccount.update({
      where: { id: command.telegramAccountId },
      data: {
        status: "CONNECTED",
        authorizationState: "AUTHORIZED",
        syncState: "LIVE",
        telegramUserId: identity.id,
        telegramUsername: identity.username,
        lastErrorCode: null,
        lastErrorMessage: null,
        lastUpdateAt: new Date()
      }
    });
    logPlain({
      event: "telegram_sync.initial_completed",
      accountId: command.telegramAccountId,
      dialogsSaved: savedDialogs,
      identitiesBackfilled: backfill
    });
    return commandResult(command.telegramAccountId, "CONNECTED", identity.id, identity.username);
  } finally {
    await adapter.safeDisconnect(runtime);
    logPlain({ event: "telegram_runtime.disconnected", accountId: command.telegramAccountId });
  }
}

async function markAccountFailure(
  prisma: PrismaClient,
  command: Prisma.TelegramOutboundCommandGetPayload<{ include: { telegramAccount: { include: { developerApp: true } } } }>,
  error: unknown
): Promise<TelegramFailureClassification> {
  if (isPeerEntityResolutionError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    if (/INPUT_USER_DEACTIVATED/i.test(message)) {
      return {
        nextAuthorizationState: "AUTHORIZED",
        nextSyncState: "LIVE",
        nextStatus: "CONNECTED",
        safeErrorCode: "TELEGRAM_PEER_DEACTIVATED",
        safeUserMessage: "This Telegram user account is deactivated. Messages cannot be sent to this peer.",
        retryable: false
      };
    }
    return {
      nextAuthorizationState: "AUTHORIZED",
      nextSyncState: "LIVE",
      nextStatus: "CONNECTED",
      safeErrorCode: "TELEGRAM_PEER_UNRESOLVED",
      safeUserMessage:
        error instanceof Error
          ? error.message
          : "This Telegram chat cannot be reached right now. Atlas has no access hash for this peer yet.",
      // Keep retryable: another inbound Telegram update may repair peer_type/access_hash.
      retryable: true
    };
  }

  const authorizationFailure = ["SUBMIT_PHONE", "SUBMIT_CODE", "SUBMIT_PASSWORD"].includes(command.operation);
  const hasStoredAuthorizedSession = Boolean(
    command.telegramAccount.sessionEncrypted &&
      (command.telegramAccount.authorizationState === "AUTHORIZED" || ["CONNECTED", "DEGRADED", "REAUTH_REQUIRED"].includes(command.telegramAccount.status))
  );
  const failure = classifyTelegramFailure(error, command.telegramAccount.authorizationState, hasStoredAuthorizedSession);
  await prisma.telegramAccount.update({
    where: { id: command.telegramAccountId },
    data: {
      ...(failure.safeErrorCode === "TELEGRAM_AUTH_KEY_INVALID"
        ? {
            status: "REAUTH_REQUIRED",
            authorizationState: "REAUTH_REQUIRED",
            syncState: "PAUSED"
          }
        : authorizationFailure
          ? {
              status: failure.nextStatus,
              authorizationState: failure.nextAuthorizationState,
              syncState: failure.nextSyncState
            }
        : {}),
      lastErrorCode: failure.safeErrorCode,
      lastErrorMessage: failure.safeUserMessage.slice(0, 500),
      lastUpdateAt: new Date()
    }
  });
  return failure;
}

async function clearAccountOperationalErrors(prisma: PrismaClient, accountId: string): Promise<void> {
  await prisma.telegramAccount.update({
    where: { id: accountId },
    data: {
      lastErrorCode: null,
      lastErrorMessage: null,
      lastUpdateAt: new Date()
    }
  });
}

async function processMarkChatReadJob(
  prisma: PrismaClient,
  redis: Redis,
  adapter: TelegramClientAdapter,
  lease: AccountLease,
  env: WorkerEnv,
  command: CommandWithAccount
): Promise<WorkerCommandResult> {
  await prisma.telegramOutboundCommand.update({
    where: { id: command.id },
    data: { status: "SENDING", attempts: { increment: 1 } }
  });
  const payload = (command.payloadJson ?? {}) as {
    chatDbId?: string;
    maxTelegramMessageId?: string;
  };
  if (!payload.chatDbId || !payload.maxTelegramMessageId) {
    throw new Error("TELEGRAM_MARK_READ_PAYLOAD_INVALID");
  }

  const chat = await prisma.telegramChat.findFirst({
    where: { id: payload.chatDbId, telegramAccountId: command.telegramAccountId, workspaceId: command.workspaceId }
  });
  if (!chat) {
    throw new Error("TELEGRAM_CHAT_NOT_FOUND");
  }

  const previousUnread = chat.unreadCount;
  const liveRuntime = getLiveSyncRuntime(command.telegramAccountId);
  let runtime = liveRuntime;
  let temporary = false;
  if (!runtime) {
    if (!command.telegramAccount.sessionEncrypted) {
      throw new Error("TELEGRAM_AUTH_CONTEXT_MISSING");
    }
    if (!(await lease.acquire(command.telegramAccountId))) {
      throw new Error("TELEGRAM_WORKER_LEASE_UNAVAILABLE");
    }
    temporary = true;
    runtime = await adapter.connect(command.telegramAccount.sessionEncrypted as unknown as EncryptedSecret, developerAppCredentials(command.telegramAccount.developerApp, env), {
      mode: "live"
    });
  }

  try {
    if (!isRemoteTelegramMessageId(payload.maxTelegramMessageId)) {
      logPlain({
        event: "telegram_chat.mark_read_skipped",
        conversationId: chat.id,
        telegramAccountId: command.telegramAccountId,
        peerId: chat.telegramChatId,
        reason: "invalid_or_pending_max_telegram_message_id",
        previousUnreadCount: previousUnread
      });
      await prisma.telegramChat.update({
        where: { id: chat.id },
        data: { unreadCount: 0, lastReadAt: new Date() }
      });
      await prisma.telegramOutboundCommand.update({
        where: { id: command.id },
        data: { status: "SENT", processedAt: new Date(), lastError: null }
      });
      return commandResult(command.telegramAccountId, "CONNECTED");
    }

    const ack = await adapter.markChatHistoryRead(
      runtime,
      {
        telegramChatId: chat.telegramChatId,
        chatType: chat.chatType,
        username: chat.username,
        ...(chat.accessHash != null ? { accessHash: chat.accessHash } : {}),
        ...(chat.peerType != null ? { peerType: chat.peerType } : {}),
        ...(chat.peerPhone != null ? { phone: chat.peerPhone } : {})
      },
      payload.maxTelegramMessageId
    );

    const updated = await prisma.telegramChat.update({
      where: { id: chat.id },
      data: {
        unreadCount: 0,
        lastReadTelegramMessageId: payload.maxTelegramMessageId,
        lastReadAt: new Date()
      }
    });

    logPlain({
      event: "telegram_chat.mark_read",
      conversationId: chat.id,
      telegramAccountId: command.telegramAccountId,
      peerId: chat.telegramChatId,
      previousUnreadCount: previousUnread,
      newUnreadCount: 0,
      readMaxMessageId: payload.maxTelegramMessageId,
      telegramAck: ack.ok,
      databasePersisted: true
    });

    await redis.publish(
      "atlas.workspace-events",
      JSON.stringify(chatUpdatedEvent(command.workspaceId, chatUpdatedFieldsFromRow({ ...updated, lastMessageDirection: null })))
    );

    return commandResult(command.telegramAccountId, "CONNECTED");
  } finally {
    if (temporary) {
      await adapter.safeDisconnect(runtime);
      await lease.release(command.telegramAccountId).catch(() => undefined);
    }
  }
}

async function processDeleteMessageJob(
  prisma: PrismaClient,
  redis: Redis,
  adapter: TelegramClientAdapter,
  lease: AccountLease,
  _env: WorkerEnv,
  store: MediaObjectStore,
  command: CommandWithAccount
): Promise<WorkerCommandResult> {
  await prisma.telegramOutboundCommand.update({
    where: { id: command.id },
    data: { status: "SENDING", attempts: { increment: 1 } }
  });

  const payload = (command.payloadJson ?? {}) as {
    messageDbId?: string;
    telegramMessageId?: string;
    scope?: "EVERYONE" | "ATLAS_ONLY";
    revoke?: boolean;
  };

  const messageDbId = payload.messageDbId ?? command.telegramMessageId;
  if (!messageDbId || !command.telegramChatDbId || !command.telegramChatId) {
    throw new SafeTelegramWorkerError("TELEGRAM_DELETE_PAYLOAD_INVALID", "Delete command payload is incomplete.");
  }

  const message = await prisma.telegramMessage.findFirst({
    where: { id: messageDbId, workspaceId: command.workspaceId, telegramAccountId: command.telegramAccountId }
  });
  if (!message) {
    throw new SafeTelegramWorkerError("TELEGRAM_MESSAGE_NOT_FOUND", "Message to delete was not found.");
  }

  if (message.deletedAt) {
    await prisma.telegramOutboundCommand.update({
      where: { id: command.id },
      data: { status: "SENT", processedAt: new Date(), lastError: null }
    });
    return { ok: true, accountId: command.telegramAccountId, occurredAt: new Date().toISOString(), authorizationState: "CONNECTED" };
  }

  const chat = await prisma.telegramChat.findUnique({ where: { id: command.telegramChatDbId } });
  if (!chat) {
    throw new SafeTelegramWorkerError("TELEGRAM_CHAT_NOT_FOUND", "Chat for delete was not found.");
  }

  try {
    await prisma.telegramMessage.update({
      where: { id: message.id },
      data: { telegramDeleteStatus: "DELETING", telegramDeleteError: null }
    });

    const liveRuntime = getLiveSyncRuntime(command.telegramAccountId);
    if (!liveRuntime) {
      throw new SafeTelegramWorkerError(
        "TELEGRAM_LIVE_RUNTIME_UNAVAILABLE",
        "Telegram live session is not connected for this account."
      );
    }
    if (!(await lease.isOwnedByThisWorker(command.telegramAccountId))) {
      const acquired = await lease.acquireWithTimeout(command.telegramAccountId, 3_000);
      if (!acquired) {
        throw new SafeTelegramWorkerError("TELEGRAM_ACCOUNT_LEASE_BUSY", "Telegram account lease is busy.");
      }
    }
    await lease.renew(command.telegramAccountId);

    const hints = peerHintsFromChat(chat);
    try {
      await adapter.deleteMessages(liveRuntime, hints, [message.telegramMessageId], {
        revoke: payload.revoke !== false
      });
    } catch (error) {
      if (error instanceof SafeTelegramDeleteError) {
        throw new SafeTelegramWorkerError(error.code, error.message);
      }
      throwAsSafePeerError(error);
    }

    const deletedBy = await prisma.user.findUnique({
      where: { id: command.requestedByUserId },
      select: { id: true, name: true }
    });

    await applySoftDeletedMessage(prisma, redis, store, {
      messageId: message.id,
      workspaceId: command.workspaceId,
      telegramAccountId: command.telegramAccountId,
      chatDbId: chat.id,
      telegramMessageId: message.telegramMessageId,
      scope: "EVERYONE",
      deletedByUserId: command.requestedByUserId,
      deletedByName: deletedBy?.name ?? null,
      originalContentType: message.contentType,
      priorMediaStorageKey: message.mediaStorageKey,
      priorThumbnailStorageKey: message.thumbnailStorageKey
    });

    await prisma.telegramOutboundCommand.update({
      where: { id: command.id },
      data: { status: "SENT", processedAt: new Date(), lastError: null, telegramMessageId: message.id }
    });
    await clearAccountOperationalErrors(prisma, command.telegramAccountId);
    return { ok: true, accountId: command.telegramAccountId, occurredAt: new Date().toISOString(), authorizationState: "CONNECTED" };
  } catch (error) {
    const failure =
      error instanceof SafeTelegramWorkerError
        ? {
            safeErrorCode: error.code,
            safeUserMessage: error.message,
            retryable: isSafeWorkerErrorRetryable(error.code)
          }
        : await markAccountFailure(prisma, command, error);

    // Never convert a failed Telegram deletion into a local soft-delete.
    await prisma.telegramMessage.updateMany({
      where: { id: message.id, deletedAt: null },
      data: {
        telegramDeleteStatus: "FAILED",
        telegramDeleteError: formatSafeCommandError(failure.safeErrorCode, failure.safeUserMessage)
      }
    });
    await prisma.telegramOutboundCommand.update({
      where: { id: command.id },
      data: {
        status: failure.retryable && command.attempts < 4 ? "FAILED_RETRYABLE" : "FAILED_PERMANENT",
        lastError: formatSafeCommandError(failure.safeErrorCode, failure.safeUserMessage),
        processedAt: new Date()
      }
    });
    throw new SafeTelegramWorkerError(failure.safeErrorCode, failure.safeUserMessage);
  }
}

async function processSendMediaJob(
  prisma: PrismaClient,
  redis: Redis,
  adapter: TelegramClientAdapter,
  lease: AccountLease,
  env: WorkerEnv,
  store: ReturnType<typeof createMediaObjectStore>,
  command: CommandWithAccount
): Promise<WorkerCommandResult> {
  await prisma.telegramOutboundCommand.update({
    where: { id: command.id },
    data: { status: "SENDING", attempts: { increment: 1 } }
  });

  const payload = (command.payloadJson ?? {}) as {
    contentType?: string;
    caption?: string;
    storageKey?: string;
    mimeType?: string;
    fileName?: string;
    pendingMessageId?: string;
    replyToTelegramMessageId?: string;
    voiceNote?: boolean;
    videoNote?: boolean;
    forceDocument?: boolean;
    latitude?: number;
    longitude?: number;
    contactPhone?: string;
    contactFirstName?: string;
    contactLastName?: string;
  };
  const pendingMessageId = payload.pendingMessageId ?? command.telegramMessageId ?? null;

  try {
    if (!command.telegramChatDbId || !command.telegramChatId) {
      throw new Error("Telegram send media payload is incomplete");
    }
    const liveRuntime = getLiveSyncRuntime(command.telegramAccountId);
    if (!liveRuntime) {
      throw new SafeTelegramWorkerError(
        "TELEGRAM_LIVE_RUNTIME_UNAVAILABLE",
        "Telegram live session is not connected for this account."
      );
    }
    if (!(await lease.isOwnedByThisWorker(command.telegramAccountId))) {
      const acquired = await lease.acquireWithTimeout(command.telegramAccountId, 3_000);
      if (!acquired) {
        throw new SafeTelegramWorkerError("TELEGRAM_ACCOUNT_LEASE_BUSY", "Telegram account lease is busy.");
      }
    }
    await lease.renew(command.telegramAccountId);

    if (pendingMessageId) {
      await prisma.telegramMessage.updateMany({
        where: { id: pendingMessageId },
        data: { sendStatus: "SENDING", mediaUploadState: "DOWNLOADING", updatedAt: new Date() }
      });
      const sendingRow = await prisma.telegramMessage.findUnique({ where: { id: pendingMessageId } });
      if (sendingRow) {
        await publishMessageUpdated(
          redis,
          command.workspaceId,
          toTelegramMessageDto(sendingRow, {
            direction: "OUTBOUND",
            chatTitle: null,
            chatType: "UNKNOWN",
            chatUsername: null
          })
        );
      }
    }

    const chatRow = await prisma.telegramChat.findUnique({ where: { id: command.telegramChatDbId } });
    const hints = await resolveAndPersistPeerBeforeSend(
      prisma,
      adapter,
      liveRuntime,
      command.telegramChatDbId,
      command.telegramChatId,
      chatRow
    );

    let sent;
    try {
      if (payload.contentType === "LOCATION" && payload.latitude != null && payload.longitude != null) {
        sent = await adapter.sendText(
          liveRuntime,
          command.telegramChatId,
          `📍 ${payload.latitude.toFixed(5)}, ${payload.longitude.toFixed(5)}`,
          undefined,
          hints
        );
      } else if (payload.contentType === "CONTACT" && payload.contactPhone) {
        sent = await adapter.sendText(
          liveRuntime,
          command.telegramChatId,
          `👤 ${[payload.contactFirstName, payload.contactLastName].filter(Boolean).join(" ")} ${payload.contactPhone}`.trim(),
          undefined,
          hints
        );
      } else {
        if (!payload.storageKey) {
          throw new Error("Telegram send media requires storageKey");
        }
        const buffer = await downloadObjectBuffer(env, payload.storageKey);
        const mode = resolveOutgoingMediaSendMode({
          contentType: payload.contentType ?? "DOCUMENT",
          mimeType: payload.mimeType ?? null,
          fileName: payload.fileName ?? null,
          fileSizeBytes: buffer.byteLength,
          forceDocument: payload.forceDocument ?? null
        });
        logPlain({
          event: "telegram_media.send_mode",
          accountId: command.telegramAccountId,
          contentType: payload.contentType ?? null,
          mimeType: payload.mimeType ?? null,
          fileName: payload.fileName ?? null,
          ...mode
        });
        sent = await adapter.sendMediaFile(liveRuntime, command.telegramChatId, {
          buffer,
          fileName: payload.fileName || "attachment.bin",
          voiceNote: payload.voiceNote || payload.contentType === "VOICE",
          videoNote: payload.videoNote || payload.contentType === "VIDEO_NOTE",
          forceDocument: mode.forceDocument,
          asPhoto: mode.asPhoto,
          asAnimation: mode.asAnimation,
          supportsStreaming: payload.contentType === "VIDEO" && !mode.forceDocument,
          peerHints: hints,
          ...(payload.mimeType ? { mimeType: payload.mimeType } : {}),
          ...(payload.caption ? { caption: payload.caption } : {}),
          ...(payload.replyToTelegramMessageId ? { replyToTelegramMessageId: payload.replyToTelegramMessageId } : {})
        });
      }
    } catch (error) {
      throwAsSafePeerError(error);
    }

    await persistResolvedPeer(prisma, command.telegramChatDbId, sent.resolvedPeer);

    const message = await persistOutboundDelivery(prisma, command, payload, pendingMessageId, sent);
    if (payload.storageKey) {
      await prisma.telegramMessage.update({
        where: { id: message.id },
        data: {
          mediaStorageKey: payload.storageKey,
          mediaDownloadState: "STORED",
          mediaUploadState: "STORED",
          mimeType: payload.mimeType ?? message.mimeType,
          fileName: payload.fileName ?? message.fileName
        }
      });
    }
    const refreshed = await prisma.telegramMessage.findUniqueOrThrow({ where: { id: message.id } });
    await publishMessage(
      prisma,
      redis,
      command.workspaceId,
      toTelegramMessageDto(refreshed, {
        direction: "OUTBOUND",
        chatTitle: null,
        chatType: "UNKNOWN",
        chatUsername: null
      })
    );
    await confirmOutboundDelivery({
      prisma,
      redis,
      workspaceId: command.workspaceId,
      messageId: refreshed.id,
      telegramMessageId: refreshed.telegramMessageId
    });
    await prisma.telegramOutboundCommand.update({
      where: { id: command.id },
      data: {
        status: "SENT",
        processedAt: new Date(),
        lastError: null,
        telegramMessageId: refreshed.telegramMessageId
      }
    });
    await clearAccountOperationalErrors(prisma, command.telegramAccountId);
    return { ok: true, accountId: command.telegramAccountId, occurredAt: new Date().toISOString(), authorizationState: "CONNECTED" };
  } catch (error) {
    const failure =
      error instanceof SafeTelegramWorkerError
        ? {
            safeErrorCode: error.code,
            safeUserMessage: error.message,
            retryable: isSafeWorkerErrorRetryable(error.code)
          }
        : await markAccountFailure(prisma, command, error);
    if (pendingMessageId) {
      await prisma.telegramMessage.updateMany({
        where: { id: pendingMessageId },
        data: {
          sendStatus: failure.retryable ? "FAILED_RETRYABLE" : "FAILED_PERMANENT",
          mediaUploadState: "FAILED",
          mediaError: formatSafeCommandError(failure.safeErrorCode, failure.safeUserMessage),
          updatedAt: new Date()
        }
      });
      const failedRow = await prisma.telegramMessage.findUnique({ where: { id: pendingMessageId } });
      if (failedRow) {
        await publishMessageUpdated(
          redis,
          command.workspaceId,
          toTelegramMessageDto(failedRow, {
            direction: "OUTBOUND",
            chatTitle: null,
            chatType: "UNKNOWN",
            chatUsername: null
          })
        );
      }
    }
    await prisma.telegramOutboundCommand.update({
      where: { id: command.id },
      data: {
        // Peer unresolved stays FAILED_RETRYABLE even after attempt budget — needs explicit Retry after repair.
        status:
          failure.safeErrorCode === "TELEGRAM_PEER_UNRESOLVED" || (failure.retryable && command.attempts < 4)
            ? "FAILED_RETRYABLE"
            : "FAILED_PERMANENT",
        lastError: formatSafeCommandError(failure.safeErrorCode, failure.safeUserMessage),
        processedAt: new Date()
      }
    });
    throw new SafeTelegramWorkerError(failure.safeErrorCode, failure.safeUserMessage);
  }
}

async function processMediaBackfillJob(
  prisma: PrismaClient,
  redis: Redis,
  adapter: TelegramClientAdapter,
  lease: AccountLease,
  env: WorkerEnv,
  store: ReturnType<typeof createMediaObjectStore>,
  command: CommandWithAccount
): Promise<WorkerCommandResult> {
  await prisma.telegramOutboundCommand.update({
    where: { id: command.id },
    data: { status: "SENDING", attempts: { increment: 1 } }
  });
  const liveRuntime = getLiveSyncRuntime(command.telegramAccountId);
  if (!liveRuntime) {
    throw new SafeTelegramWorkerError(
      "TELEGRAM_LIVE_RUNTIME_UNAVAILABLE",
      "Telegram live session is not connected for this account."
    );
  }
  if (!(await lease.isOwnedByThisWorker(command.telegramAccountId))) {
    const acquired = await lease.acquireWithTimeout(command.telegramAccountId, 3_000);
    if (!acquired) {
      throw new SafeTelegramWorkerError("TELEGRAM_ACCOUNT_LEASE_BUSY", "Telegram account lease is busy.");
    }
  }
  const result = await runMediaBackfill({
    prisma,
    redis,
    adapter,
    runtime: liveRuntime,
    store,
    workspaceId: command.workspaceId,
    telegramAccountId: command.telegramAccountId,
    limit: 25
  });
  await redis.set(
    `telegram-media-backfill:${command.telegramAccountId}`,
    JSON.stringify({
      ...result,
      accountId: command.telegramAccountId,
      completedAt: new Date().toISOString()
    }),
    "EX",
    86_400
  );
  await prisma.telegramOutboundCommand.update({
    where: { id: command.id },
    data: { status: "SENT", processedAt: new Date(), lastError: null }
  });
  return { ok: true, accountId: command.telegramAccountId, occurredAt: new Date().toISOString(), authorizationState: "CONNECTED" };
}

async function downloadObjectBuffer(env: WorkerEnv, key: string): Promise<Buffer> {
  const client = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY
    }
  });
  const response = await client.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  const body = response.Body;
  if (!body) throw new Error("Empty media object");
  const bytes = await body.transformToByteArray();
  return Buffer.from(bytes);
}

async function processSendTextJob(
  prisma: PrismaClient,
  redis: Redis,
  adapter: TelegramClientAdapter,
  lease: AccountLease,
  env: WorkerEnv,
  command: CommandWithAccount
): Promise<WorkerCommandResult> {
  await prisma.telegramOutboundCommand.update({
    where: { id: command.id },
    data: { status: "SENDING", attempts: { increment: 1 } }
  });

  const payload = (command.payloadJson ?? {}) as {
    text?: string;
    replyToTelegramMessageId?: string;
    pendingMessageId?: string;
  };
  const pendingMessageId = payload.pendingMessageId ?? command.telegramMessageId ?? null;

  try {
    if (!command.telegramChatDbId || !command.telegramChatId || typeof payload.text !== "string" || !payload.text.trim()) {
      throw new Error("Telegram send payload is incomplete");
    }

    const liveRuntime = getLiveSyncRuntime(command.telegramAccountId);
    if (!liveRuntime) {
      throw new SafeTelegramWorkerError(
        "TELEGRAM_LIVE_RUNTIME_UNAVAILABLE",
        "Telegram live session is not connected for this account."
      );
    }
    if (!(await lease.isOwnedByThisWorker(command.telegramAccountId))) {
      const acquired = await lease.acquireWithTimeout(command.telegramAccountId, 3_000);
      if (!acquired) {
        throw new SafeTelegramWorkerError("TELEGRAM_ACCOUNT_LEASE_BUSY", "Telegram account lease is busy.");
      }
    }
    await lease.renew(command.telegramAccountId);

    if (pendingMessageId) {
      await prisma.telegramMessage.updateMany({
        where: { id: pendingMessageId },
        data: { sendStatus: "SENDING", updatedAt: new Date() }
      });
      const sendingRow = await prisma.telegramMessage.findUnique({ where: { id: pendingMessageId } });
      if (sendingRow) {
        await publishMessageUpdated(
          redis,
          command.workspaceId,
          toTelegramMessageDto(sendingRow, {
            direction: "OUTBOUND",
            chatTitle: null,
            chatType: "UNKNOWN",
            chatUsername: null
          })
        );
      }
    }

    const chatRow = await prisma.telegramChat.findUnique({ where: { id: command.telegramChatDbId } });
    const hints = await resolveAndPersistPeerBeforeSend(
      prisma,
      adapter,
      liveRuntime,
      command.telegramChatDbId,
      command.telegramChatId,
      chatRow
    );

    let sent;
    try {
      sent = await adapter.sendText(
        liveRuntime,
        command.telegramChatId,
        payload.text,
        payload.replyToTelegramMessageId,
        hints
      );
    } catch (error) {
      throwAsSafePeerError(error);
    }
    await persistResolvedPeer(prisma, command.telegramChatDbId, sent.resolvedPeer);
    const message = await persistOutboundDelivery(prisma, command, payload, pendingMessageId, sent);
    await publishMessage(prisma, redis, command.workspaceId, toTelegramMessageDto(message, {
      direction: "OUTBOUND",
      chatTitle: null,
      chatType: "UNKNOWN",
      chatUsername: null
    }));
    await confirmOutboundDelivery({
      prisma,
      redis,
      workspaceId: command.workspaceId,
      messageId: message.id,
      telegramMessageId: message.telegramMessageId
    });
    await prisma.telegramOutboundCommand.update({
      where: { id: command.id },
      data: {
        status: "SENT",
        processedAt: new Date(),
        lastError: null,
        telegramMessageId: message.telegramMessageId
      }
    });
    await clearAccountOperationalErrors(prisma, command.telegramAccountId);
    return { ok: true, accountId: command.telegramAccountId, occurredAt: new Date().toISOString(), authorizationState: "CONNECTED" };
  } catch (error) {
    const failure =
      error instanceof SafeTelegramWorkerError
        ? {
            safeErrorCode: error.code,
            safeUserMessage: error.message,
            retryable: isSafeWorkerErrorRetryable(error.code)
          }
        : await markAccountFailure(prisma, command, error);

    if (pendingMessageId) {
      await prisma.telegramMessage.updateMany({
        where: { id: pendingMessageId },
        data: {
          sendStatus: failure.retryable ? "FAILED_RETRYABLE" : "FAILED_PERMANENT",
          mediaError: formatSafeCommandError(failure.safeErrorCode, failure.safeUserMessage),
          updatedAt: new Date()
        }
      });
      const failedRow = await prisma.telegramMessage.findUnique({ where: { id: pendingMessageId } });
      if (failedRow) {
        await publishMessageUpdated(
          redis,
          command.workspaceId,
          toTelegramMessageDto(failedRow, {
            direction: "OUTBOUND",
            chatTitle: null,
            chatType: "UNKNOWN",
            chatUsername: null
          })
        );
      }
    }
    await prisma.telegramOutboundCommand.update({
      where: { id: command.id },
      data: {
        status:
          failure.safeErrorCode === "TELEGRAM_PEER_UNRESOLVED" || (failure.retryable && command.attempts < 4)
            ? "FAILED_RETRYABLE"
            : "FAILED_PERMANENT",
        lastError: formatSafeCommandError(failure.safeErrorCode, failure.safeUserMessage),
        processedAt: new Date()
      }
    });
    throw new SafeTelegramWorkerError(failure.safeErrorCode, failure.safeUserMessage);
  }
}

async function persistOutboundDelivery(
  prisma: PrismaClient,
  command: CommandWithAccount,
  payload: { text?: string; replyToTelegramMessageId?: string },
  pendingMessageId: string | null,
  sent: NormalizedTextMessage
) {
  if (pendingMessageId) {
    try {
      const updated = await prisma.telegramMessage.update({
        where: { id: pendingMessageId },
        data: {
          telegramMessageId: sent.telegramMessageId,
          senderTelegramUserId: sent.senderTelegramUserId,
          contentType: sent.contentType,
          textContent: sent.text,
          ...mediaPersistFields(sent),
          replyToTelegramMessageId: sent.replyToTelegramMessageId,
          telegramCreatedAt: sent.sentAt,
          telegramEditedAt: sent.editedAt,
          sendStatus: "SENT",
          mediaError: null,
          updatedAt: new Date()
        }
      });
      await prisma.telegramChat.update({
        where: { id: command.telegramChatDbId! },
        data: {
          lastMessageId: sent.telegramMessageId,
          lastMessagePreview: sent.previewText.slice(0, 500),
          lastMessageAt: sent.sentAt
        }
      });
      return updated;
    } catch {
      // Fall through to upsert if the pending row was removed or collided.
    }
  }

  const message = await prisma.telegramMessage.upsert({
    where: {
      telegramAccountId_telegramChatId_telegramMessageId: {
        telegramAccountId: command.telegramAccountId,
        telegramChatId: command.telegramChatId!,
        telegramMessageId: sent.telegramMessageId
      }
    },
    update: {
      direction: "OUTBOUND",
      sendStatus: "SENT",
      mediaError: null,
      contentType: sent.contentType,
      textContent: sent.text,
      caption: sent.caption,
      internalSenderUserId: command.requestedByUserId,
      internalSenderSessionId: command.requestedBySessionId,
      updatedAt: new Date()
    },
    create: {
      workspaceId: command.workspaceId,
      telegramAccountId: command.telegramAccountId,
      telegramChatDbId: command.telegramChatDbId!,
      telegramChatId: command.telegramChatId!,
      telegramMessageId: sent.telegramMessageId,
      senderTelegramUserId: sent.senderTelegramUserId,
      direction: "OUTBOUND",
      contentType: sent.contentType,
      textContent: sent.text,
      ...mediaPersistFields(sent),
      replyToTelegramMessageId: sent.replyToTelegramMessageId,
      telegramCreatedAt: sent.sentAt,
      telegramEditedAt: sent.editedAt,
      internalSenderUserId: command.requestedByUserId,
      internalSenderSessionId: command.requestedBySessionId,
      sendStatus: "SENT"
    }
  });

  // Backfill role/name snapshot when the echo path created the row first.
  if (command.requestedByUserId) {
    const sender = await prisma.user.findUnique({
      where: { id: command.requestedByUserId },
      select: { name: true, role: true }
    });
    if (sender && (!message.internalSenderName || !message.internalSenderRole || !message.internalSenderUserId)) {
      return prisma.telegramMessage.update({
        where: { id: message.id },
        data: {
          internalSenderUserId: command.requestedByUserId,
          internalSenderSessionId: command.requestedBySessionId,
          internalSenderName: sender.name,
          internalSenderRole: sender.role === "PLATFORM_ADMIN" ? "COADMIN" : sender.role
        }
      });
    }
  }

  if (pendingMessageId && pendingMessageId !== message.id) {
    await prisma.telegramMessage.deleteMany({ where: { id: pendingMessageId } }).catch(() => undefined);
  }

  await prisma.telegramChat.update({
    where: { id: command.telegramChatDbId! },
    data: {
      lastMessageId: sent.telegramMessageId,
      lastMessagePreview: sent.previewText.slice(0, 500),
      lastMessageAt: sent.sentAt
    }
  });

  return message;
}

async function syncInitialPage(
  prisma: PrismaClient,
  adapter: TelegramClientAdapter,
  runtime: Awaited<ReturnType<TelegramClientAdapter["connect"]>>,
  workspaceId: string,
  telegramAccountId: string
): Promise<number> {
  const selfTelegramUserId = await adapter.resolveSelfUserId(runtime);
  await quarantineIgnoredChats(prisma, telegramAccountId, selfTelegramUserId);

  const dialogs = await adapter.listDialogs(runtime, 100);
  let savedDialogs = 0;
  for (const dialog of dialogs) {
    if (
      adapter.isIgnorableDialog(dialog, selfTelegramUserId) ||
      shouldIgnoreTelegramDialog({
        telegramChatId: dialog.telegramChatId,
        chatType: dialog.chatType,
        title: dialog.title,
        username: dialog.username,
        firstName: dialog.firstName,
        lastName: dialog.lastName,
        isSelf: dialog.isSelf,
        isSupport: dialog.isSupport,
        isArchived: dialog.isArchived,
        selfTelegramUserId
      })
    ) {
      await quarantineChatByPeerId(prisma, telegramAccountId, dialog.telegramChatId);
      continue;
    }
    try {
      const existing = await prisma.telegramChat.findUnique({
        where: { telegramAccountId_telegramChatId: { telegramAccountId, telegramChatId: dialog.telegramChatId } }
      });
      const chat = await prisma.telegramChat.upsert({
        where: { telegramAccountId_telegramChatId: { telegramAccountId, telegramChatId: dialog.telegramChatId } },
        update: {
          unreadCount: resolveSyncedUnreadCount({
            dialogUnreadCount: dialog.unreadCount,
            existingUnreadCount: existing?.unreadCount,
            lastReadTelegramMessageId: existing?.lastReadTelegramMessageId,
            dialogTopMessageId: dialog.topMessageId,
            isCreate: false
          }),
          isPinned: dialog.isPinned,
          isArchived: false,
          ...buildIdentityFillUpdate(
            {
              title: existing?.title ?? "",
              telegramChatId: dialog.telegramChatId,
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
            dialog
          )
        },
        create: {
          workspaceId,
          telegramAccountId,
          telegramChatId: dialog.telegramChatId,
          chatType: dialog.chatType,
          title: dialog.title,
          username: dialog.username,
          firstName: dialog.firstName,
          lastName: dialog.lastName,
          isBot: dialog.isBot,
          unreadCount: resolveSyncedUnreadCount({
            dialogUnreadCount: dialog.unreadCount,
            existingUnreadCount: null,
            lastReadTelegramMessageId: null,
            dialogTopMessageId: dialog.topMessageId,
            isCreate: true
          }),
          isPinned: dialog.isPinned,
          isArchived: false,
          accessHash: dialog.accessHash,
          peerType: dialog.peerType,
          peerPhone: dialog.phone,
          rawMetadataJson: dialog.raw as Prisma.InputJsonObject
        }
      });
      savedDialogs += 1;
      const messages = await adapter.listRecentTextMessages(runtime, dialog.telegramChatId, 10, {
        chatType: dialog.chatType,
        username: dialog.username,
        accessHash: dialog.accessHash,
        peerType: dialog.peerType,
        phone: dialog.phone
      });
      for (const message of messages) {
        await persistInboundMessage(prisma, workspaceId, telegramAccountId, chat.id, message);
      }
    } catch (error) {
      const safe = sanitizeTelegramError(error, false);
      logPlain({
        event: "telegram_sync.dialog_skipped",
        accountId: telegramAccountId,
        telegramChatId: dialog.telegramChatId,
        code: safe.code ?? safe.name,
        message: safe.message
      });
    }
  }
  logPlain({ event: "telegram_sync.dialogs_saved", accountId: telegramAccountId, count: savedDialogs });
  return savedDialogs;
}

/**
 * Archives previously imported official/service/self dialogs so they leave CRM counts and inbox.
 */
async function quarantineIgnoredChats(
  prisma: PrismaClient,
  telegramAccountId: string,
  selfTelegramUserId: string | null
): Promise<void> {
  const chats = await prisma.telegramChat.findMany({
    where: { telegramAccountId, isArchived: false },
    select: {
      id: true,
      telegramChatId: true,
      chatType: true,
      title: true,
      username: true,
      firstName: true,
      lastName: true,
      rawMetadataJson: true
    },
    take: 500
  });
  for (const chat of chats) {
    const meta = chat.rawMetadataJson && typeof chat.rawMetadataJson === "object" && !Array.isArray(chat.rawMetadataJson)
      ? (chat.rawMetadataJson as Record<string, unknown>)
      : {};
    if (
      shouldIgnoreTelegramDialog({
        telegramChatId: chat.telegramChatId,
        chatType: chat.chatType,
        title: chat.title,
        username: chat.username,
        firstName: chat.firstName,
        lastName: chat.lastName,
        isSelf: Boolean(meta.self),
        isSupport: Boolean(meta.support),
        isArchived: Boolean(meta.archived),
        selfTelegramUserId
      })
    ) {
      await prisma.telegramChat.update({
        where: { id: chat.id },
        data: {
          isArchived: true,
          unreadCount: 0,
          needsCrmAttention: false,
          isPinned: false,
          rawMetadataJson: mergeIdentityMetadata(chat.rawMetadataJson, {
            crmIgnored: true,
            crmIgnoredReason: "telegram_service_or_system_dialog",
            identityResolvedAt: new Date().toISOString()
          })
        }
      });
    }
  }
}

async function quarantineChatByPeerId(
  prisma: PrismaClient,
  telegramAccountId: string,
  telegramChatId: string
): Promise<void> {
  await prisma.telegramChat.updateMany({
    where: { telegramAccountId, telegramChatId, isArchived: false },
    data: {
      isArchived: true,
      unreadCount: 0,
      needsCrmAttention: false,
      isPinned: false
    }
  });
}

/**
 * Re-resolves Telegram entities for chats that still lack usable titles.
 * Updates the existing row and publishes telegram.chat.updated (no duplicates).
 */
async function backfillMissingChatIdentities(
  prisma: PrismaClient,
  adapter: TelegramClientAdapter,
  runtime: Awaited<ReturnType<TelegramClientAdapter["connect"]>>,
  telegramAccountId: string,
  options?: { readonly redis?: Redis; readonly workspaceId?: string }
): Promise<IdentityBackfillCounts> {
  const batchSize = 40;
  const candidates = await prisma.telegramChat.findMany({
    where: {
      telegramAccountId,
      isArchived: false,
      OR: [
        { chatType: "UNKNOWN" },
        { title: "" },
        { title: { startsWith: "Unknown", mode: "insensitive" } },
        { title: { startsWith: "Telegram user ", mode: "insensitive" } },
        { chatType: "PRIVATE", firstName: null, lastName: null, username: null },
        { chatType: "PRIVATE", firstName: null, lastName: null, username: "" },
        { chatType: { in: ["PRIVATE", "CHANNEL", "SUPERGROUP"] }, accessHash: null }
      ]
    },
    take: batchSize * 3,
    orderBy: { updatedAt: "asc" }
  });
  // Also catch rows whose title is still the raw telegram id / unusable even if typed.
  const recent = await prisma.telegramChat.findMany({
    where: { telegramAccountId, isArchived: false },
    take: batchSize * 2,
    orderBy: { updatedAt: "asc" }
  });
  const byId = new Map<string, (typeof candidates)[number]>();
  for (const chat of [...candidates, ...recent]) {
    byId.set(chat.id, chat);
  }
  const chats = [...byId.values()].filter(needsIdentityBackfillRow).slice(0, batchSize);
  let scanned = 0;
  let updated = 0;
  let unresolved = 0;
  let failed = 0;

  // One GetDialogs for the whole batch — never per-chat.
  if (chats.length > 0) {
    try {
      await prefetchDialogEntities(runtime, false);
    } catch (error) {
      const safe = sanitizeTelegramError(error, false);
      logPlain({
        event: "telegram_sync.dialog_prefetch_failed",
        accountId: telegramAccountId,
        code: safe.code ?? safe.name,
        message: safe.message
      });
    }
  }

  for (const chat of chats) {
    scanned += 1;
    try {
      const identity = await adapter.resolveChatIdentity(runtime, chat.telegramChatId, {
        chatType: chat.chatType,
        username: chat.username,
        ...(chat.accessHash != null ? { accessHash: chat.accessHash } : {}),
        ...(chat.peerType != null ? { peerType: chat.peerType } : {}),
        ...(chat.peerPhone != null ? { phone: chat.peerPhone } : {})
      });
      const data = buildIdentityFillUpdate(chat, identity);
      const row = await prisma.telegramChat.update({
        where: { id: chat.id },
        data
      });
      const improved =
        identityUpdateImproves(chat, data) === "updated" ||
        isUsableDisplayTitle(identity.title, identity.telegramChatId);
      if (improved) {
        updated += 1;
        if (options?.redis && options.workspaceId) {
          await options.redis.publish(
            "atlas.workspace-events",
            JSON.stringify(
              chatUpdatedEvent(
                options.workspaceId,
                chatUpdatedFieldsFromRow({
                  ...row,
                  lastMessageDirection: null
                })
              )
            )
          );
        }
      } else {
        unresolved += 1;
      }
    } catch (error) {
      failed += 1;
      const safe = sanitizeTelegramError(error, false);
      logPlain({
        event: "telegram_sync.identity_backfill_skipped",
        accountId: telegramAccountId,
        telegramChatId: chat.telegramChatId,
        code: safe.code ?? safe.name,
        message: safe.message
      });
      // Normalize naked numeric titles even when entity resolve fails.
      if (/^-?\d{5,}$/.test(chat.title.trim())) {
        await prisma.telegramChat
          .update({
            where: { id: chat.id },
            data: {
              title: formatTelegramUserFallbackTitle(chat.telegramChatId),
              rawMetadataJson: mergeIdentityMetadata(chat.rawMetadataJson, {
                identityResolved: false,
                identityResolutionError: safe.code ?? safe.name,
                identityResolvedAt: new Date().toISOString()
              })
            }
          })
          .catch(() => undefined);
      } else {
        await prisma.telegramChat
          .update({
            where: { id: chat.id },
            data: {
              rawMetadataJson: mergeIdentityMetadata(chat.rawMetadataJson, {
                identityResolved: false,
                identityResolutionError: safe.code ?? safe.name,
                identityResolvedAt: new Date().toISOString()
              })
            }
          })
          .catch(() => undefined);
      }
    }
  }

  const counts = { scanned, updated, unresolved, failed };
  logPlain({ event: "telegram_sync.identities_backfilled", accountId: telegramAccountId, ...counts });
  return counts;
}

export function identityBackfillKey(accountId: string): string {
  return `telegram-identity-backfill:${accountId}`;
}

async function persistInboundMessage(
  prisma: PrismaClient,
  workspaceId: string,
  telegramAccountId: string,
  chatDbId: string,
  message: NormalizedTextMessage
): Promise<void> {
  const direction = message.isOutgoing ? "OUTBOUND" : "INBOUND";
  const sendStatus = message.isOutgoing ? "SENT" : "RECEIVED";
  await prisma.telegramMessage.upsert({
    where: {
      telegramAccountId_telegramChatId_telegramMessageId: {
        telegramAccountId,
        telegramChatId: message.telegramChatId,
        telegramMessageId: message.telegramMessageId
      }
    },
    update: {
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
  await prisma.telegramChat.update({
    where: { id: chatDbId },
    data: {
      lastMessageId: message.telegramMessageId,
      lastMessagePreview: sanitizeMessagePreview(message.previewText),
      lastMessageAt: message.sentAt
    }
  });
}

/**
 * Runs several bounded identity-backfill batches until none remain or the cap is hit.
 */
async function runIdentityBackfillBatches(
  prisma: PrismaClient,
  adapter: TelegramClientAdapter,
  runtime: Awaited<ReturnType<TelegramClientAdapter["connect"]>>,
  telegramAccountId: string,
  maxBatches = 5,
  options?: { readonly redis?: Redis; readonly workspaceId?: string }
): Promise<IdentityBackfillCounts> {
  let scanned = 0;
  let updated = 0;
  let unresolved = 0;
  let failed = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    const batch = await backfillMissingChatIdentities(prisma, adapter, runtime, telegramAccountId, options);
    scanned += batch.scanned;
    updated += batch.updated;
    unresolved += batch.unresolved;
    failed += batch.failed;
    if (batch.scanned === 0) break;
  }
  return { scanned, updated, unresolved, failed };
}

function sanitizeMessagePreview(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/[\uD800-\uDFFF]/g, "\uFFFD")
    .slice(0, 500);
}

async function publishMessage(prisma: PrismaClient, redis: Redis, workspaceId: string, message: TelegramMessageDto): Promise<void> {
  await prisma.auditLog.create({
    data: {
      workspaceId,
      actorId: message.internalSenderUserId,
      action: "telegram.message.sent",
      metadata: {
        telegramAccountId: message.telegramAccountId,
        telegramChatId: message.chatId,
        telegramMessageId: message.telegramMessageId,
        result: message.sendStatus
      }
    }
  });
  await redis.publish("atlas.workspace-events", JSON.stringify(messageCreatedEvent(workspaceId, message)));
  const chat = await prisma.telegramChat.findUnique({ where: { id: message.chatId } });
  if (chat) {
    await redis.publish(
      "atlas.workspace-events",
      JSON.stringify(
        chatUpdatedEvent(
          workspaceId,
          chatUpdatedFieldsFromRow({
            ...chat,
            lastMessageDirection: message.direction
          })
        )
      )
    );
  }
}

function commandResult(
  accountId: string,
  authorizationState: WorkerCommandResult["authorizationState"],
  telegramUserId?: string | null,
  telegramUsername?: string | null
): WorkerCommandResult {
  const result: WorkerCommandResult = {
    ok: true,
    accountId,
    ...(authorizationState !== undefined ? { authorizationState } : {}),
    ...(telegramUserId !== undefined ? { telegramUserId } : {}),
    ...(telegramUsername !== undefined ? { telegramUsername } : {}),
    occurredAt: new Date().toISOString()
  };
  assertPlainSerializable(result, "WORKER_COMMAND_RESULT");
  return result;
}

/**
 * Retryable auth network failures keep the Redis OTP/password secret so Retry can reuse the same attempt.
 */
function shouldPreserveAuthSecret(error: unknown): boolean {
  if (error instanceof TelegramAuthNetworkTimeoutError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /TELEGRAM_AUTH_NETWORK_TIMEOUT|ECONN|ETIMEDOUT|ENOTFOUND|NETWORK|\bTIMEOUT\b/i.test(message) && !/PHONE_CODE_|PASSWORD_|SESSION_PASSWORD/i.test(message);
}

function logPlain(value: Record<string, unknown>): void {
  assertPlainSerializable(value, "TELEGRAM_STRUCTURED_LOG");
  console.info(JSON.stringify(value));
}

function formatSafeCommandError(code: string, message: string): string {
  return `${code}: ${message}`.slice(0, 500);
}

/** Safe worker errors that should leave the Atlas message FAILED_RETRYABLE (never stuck pending). */
function isSafeWorkerErrorRetryable(code: string): boolean {
  return (
    code === "TELEGRAM_ACCOUNT_LEASE_BUSY" ||
    code === "TELEGRAM_LIVE_RUNTIME_UNAVAILABLE" ||
    code === "TELEGRAM_PEER_UNRESOLVED"
  );
}

function peerHintsFromChat(chat: {
  telegramChatId: string;
  chatType: string;
  username: string | null;
  accessHash: string | null;
  peerType: string | null;
  peerPhone: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): PeerResolutionHints {
  return {
    telegramChatId: chat.telegramChatId,
    chatType: chat.chatType,
    username: chat.username,
    accessHash: chat.accessHash,
    peerType: chat.peerType,
    phone: chat.peerPhone,
    firstName: chat.firstName ?? null,
    lastName: chat.lastName ?? null
  };
}

/**
 * Resolve InputPeer before GramJS send: stored peer_type/access_hash → live cache/dialogs → persist repair.
 * Throws TELEGRAM_PEER_UNRESOLVED (retryable) when the peer still cannot be built.
 */
async function resolveAndPersistPeerBeforeSend(
  prisma: PrismaClient,
  adapter: TelegramClientAdapter,
  runtime: Parameters<TelegramClientAdapter["resolvePeer"]>[0],
  chatDbId: string,
  telegramChatId: string,
  chatRow: {
    telegramChatId: string;
    chatType: string;
    username: string | null;
    accessHash: string | null;
    peerType: string | null;
    peerPhone: string | null;
    firstName?: string | null;
    lastName?: string | null;
  } | null
): Promise<Omit<PeerResolutionHints, "telegramChatId">> {
  const baseHints = peerHintsFromChat(
    chatRow ?? {
      telegramChatId,
      chatType: "UNKNOWN",
      username: null,
      accessHash: null,
      peerType: null,
      peerPhone: null
    }
  );

  let resolved;
  try {
    resolved = await adapter.resolvePeer(runtime, baseHints);
  } catch (error) {
    throwAsSafePeerError(error);
  }

  await persistResolvedPeer(prisma, chatDbId, resolved);
  return {
    chatType: chatRow?.chatType ?? baseHints.chatType ?? null,
    username: resolved.username ?? baseHints.username ?? null,
    accessHash: resolved.accessHash ?? baseHints.accessHash ?? null,
    peerType: resolved.peerType ?? baseHints.peerType ?? null,
    phone: resolved.phone ?? baseHints.phone ?? null,
    firstName: resolved.firstName ?? baseHints.firstName ?? null,
    lastName: resolved.lastName ?? baseHints.lastName ?? null
  };
}

async function persistResolvedPeer(
  prisma: PrismaClient,
  chatDbId: string,
  peer: ResolvedTelegramPeer
): Promise<void> {
  const existing = await prisma.telegramChat.findUnique({ where: { id: chatDbId } });
  if (!existing) return;
  await prisma.telegramChat.update({
    where: { id: chatDbId },
    data: {
      ...(peer.accessHash ? { accessHash: peer.accessHash } : {}),
      peerType: peer.peerType,
      ...(peer.username && !existing.username ? { username: peer.username } : {}),
      ...(peer.phone ? { peerPhone: peer.phone } : {}),
      ...(peer.firstName && !existing.firstName ? { firstName: peer.firstName } : {}),
      ...(peer.lastName && !existing.lastName ? { lastName: peer.lastName } : {}),
      rawMetadataJson: mergeIdentityMetadata(existing.rawMetadataJson, {
        accessHash: peer.accessHash,
        peerType: peer.peerType,
        peerId: peer.telegramChatId,
        phone: peer.phone,
        username: peer.username,
        firstName: peer.firstName,
        lastName: peer.lastName,
        peerResolvedAt: new Date().toISOString()
      })
    }
  });
}

function throwAsSafePeerError(error: unknown): never {
  if (error instanceof TelegramPeerUnresolvedError) {
    throw new SafeTelegramWorkerError(error.code, error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/INPUT_USER_DEACTIVATED/i.test(message)) {
    throw new SafeTelegramWorkerError(
      "TELEGRAM_PEER_DEACTIVATED",
      "This Telegram user account is deactivated. Messages cannot be sent to this peer."
    );
  }
  if (isPeerEntityResolutionError(error)) {
    throw new SafeTelegramWorkerError(
      "TELEGRAM_PEER_UNRESOLVED",
      "This Telegram chat cannot be reached right now. Atlas has no access hash for this peer yet — open or message the chat from Telegram once, then sync again."
    );
  }
  throw error;
}

class SafeTelegramWorkerError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "SafeTelegramWorkerError";
    this.code = code;
    const safe = sanitizeTelegramError(this, false);
    this.message = safe.message;
  }
}

function developerAppCredentials(
  developerApp: { apiId: number; encryptedApiHash: unknown; status: string; deletedAt: Date | null },
  env: WorkerEnv
): TelegramApiCredentials {
  if (developerApp.status !== "ACTIVE" || developerApp.deletedAt) {
    throw new Error("Developer app is not active");
  }
  return {
    apiId: developerApp.apiId,
    apiHash: decryptSecret(developerApp.encryptedApiHash as EncryptedSecret, env.TELEGRAM_SESSION_ENCRYPTION_KEY)
  };
}
