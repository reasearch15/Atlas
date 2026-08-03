import { describe, expect, it } from "vitest";
import { encryptSecret, decryptSecret, type EncryptedSecret } from "@atlas/shared/session-encryption";
import { TelegramAuthorizationAttemptStore } from "./auth-attempt";
import { processInitialSync, processSubmitCode, processSubmitPhone } from "./command-consumer";
import type { WorkerEnv } from "./env";
import { TelegramClientAdapter } from "./telegram-client";

const encryptionKey = "a".repeat(64);
const env: WorkerEnv = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/atlas",
  REDIS_URL: "redis://localhost:6379",
  TELEGRAM_SESSION_ENCRYPTION_KEY: encryptionKey,
  TELEGRAM_WORKER_ID: "worker-test",
  TELEGRAM_LEASE_SECONDS: 45,
  S3_ENDPOINT: "http://localhost:9000",
  S3_REGION: "us-east-1",
  S3_BUCKET: "atlas",
  S3_ACCESS_KEY_ID: "atlas",
  S3_SECRET_ACCESS_KEY: "change-me-minio-secret"
};

class FakeRedis {
  public readonly values = new Map<string, string>();
  public readonly expiries = new Map<string, number>();

  public async set(key: string, value: string, mode?: string, ttl?: number): Promise<"OK"> {
    this.values.set(key, value);
    if (mode === "EX" && ttl) this.expiries.set(key, ttl);
    return "OK";
  }

  public async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  public async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.values.delete(key)) deleted += 1;
      this.expiries.delete(key);
    }
    return deleted;
  }
}

function createCommand(overrides: Record<string, unknown> = {}) {
  return {
    id: "command-1",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    telegramAccountId: "22222222-2222-4222-8222-222222222222",
    payloadJson: {},
    telegramAccount: {
      id: "22222222-2222-4222-8222-222222222222",
      developerAppId: "33333333-3333-4333-8333-333333333333",
      phoneNumberEncrypted: encryptSecret("+15551234567", encryptionKey),
      sessionEncrypted: null,
      authorizationState: "PHONE_REQUESTED",
      status: "WAITING_FOR_PHONE",
      developerApp: {
        apiId: 12345,
        encryptedApiHash: encryptSecret("api-hash", encryptionKey),
        status: "ACTIVE",
        deletedAt: null
      }
    },
    ...overrides
  } as any;
}

describe("Telegram authorization continuity", () => {
  it("normalizes SentCode-like GramJS responses without copying circular internals", async () => {
    class SentCode {
      public readonly phoneCodeHash = "hash-from-telegram";
      public readonly timeout = 60;
      public readonly type = { className: "SentCodeTypeApp" };
      public readonly connection: Record<string, unknown>;

      public constructor() {
        const connection: Record<string, unknown> = {};
        const codec = { _conn: connection };
        connection._codec = codec;
        this.connection = connection;
      }
    }
    const adapter = new TelegramClientAdapter(env);
    const normalized = await adapter.sendLoginCode(
      {
        credentials: { apiId: 12345, apiHash: "api-hash" },
        client: {
          sendCode: async () => new SentCode()
        }
      } as any,
      "+15551234567"
    );

    expect(normalized).toEqual({ phoneCodeHash: "hash-from-telegram", timeoutSeconds: 60, type: "SentCodeTypeApp" });
    expect(JSON.stringify(normalized)).not.toContain("_codec");
    expect(structuredClone(normalized)).toEqual(normalized);
  });

  it("submit-phone stores encrypted phoneCodeHash and migrated temporary StringSession", async () => {
    const redis = new FakeRedis();
    const attempts = new TelegramAuthorizationAttemptStore(redis as any, env);
    const updates: unknown[] = [];
    const prisma = { telegramAccount: { update: async (input: unknown) => updates.push(input) } } as any;
    const adapter = {
      connect: async () => ({ mode: "authorization", client: { session: { dcId: 5, save: () => "dc5-temp-session" } } }),
      connectForAuthorization: async () => ({ mode: "authorization", client: { session: { dcId: 5, save: () => "dc5-temp-session" } } }),
      sendLoginCode: async () => ({ phoneCodeHash: "hash-from-telegram", isCodeViaApp: false }),
      exportSessionString: () => "dc5-temp-session",
      sessionDcId: () => 5,
      safeDisconnect: async () => undefined
    } as any;

    await processSubmitPhone(prisma, attempts, adapter, env, createCommand());

    const attempt = await attempts.load("22222222-2222-4222-8222-222222222222");
    expect(attempt).toMatchObject({
      accountId: "22222222-2222-4222-8222-222222222222",
      state: "WAITING_FOR_CODE",
      temporarySession: "dc5-temp-session",
      phoneCodeHash: "hash-from-telegram",
      targetDcId: 5
    });
    const stored = redis.values.get("telegram-auth-attempt:22222222-2222-4222-8222-222222222222") ?? "";
    expect(stored).not.toContain("+15551234567");
    expect(stored).not.toContain("hash-from-telegram");
    expect(stored).not.toContain("dc5-temp-session");
    expect(redis.expiries.get("telegram-auth-attempt:22222222-2222-4222-8222-222222222222")).toBe(900);
    expect(JSON.stringify(updates)).toContain("WAITING_FOR_CODE");
  });

  it("submit-code loads the same attempt and exact phoneCodeHash without storing OTP", async () => {
    const redis = new FakeRedis();
    const attempts = new TelegramAuthorizationAttemptStore(redis as any, env);
    await attempts.save({
      accountId: "22222222-2222-4222-8222-222222222222",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      developerAppId: "33333333-3333-4333-8333-333333333333",
      state: "WAITING_FOR_CODE",
      temporarySession: "dc5-temp-session",
      phoneNumber: "+15551234567",
      phoneCodeHash: "hash-from-telegram",
      targetDcId: 5,
      workerId: "worker-test"
    });
    await redis.set("otp-secret", "12345", "EX", 300);
    const updates: unknown[] = [];
    const queuedJobs: unknown[] = [];
    const command = createCommand({
      payloadJson: { secretRef: "otp-secret" },
      telegramAccount: {
        ...createCommand().telegramAccount,
        authorizationState: "CODE_REQUESTED",
        status: "WAITING_FOR_CODE"
      }
    });
    let connectedSession = "";
    let signInArgs: unknown[] = [];
    const adapter = {
      encryptSessionState: (state: { session: string }) => encryptSecret(JSON.stringify(state), encryptionKey),
      connect: async (envelope: EncryptedSecret) => {
        connectedSession = JSON.parse(decryptSecret(envelope, encryptionKey)).session;
        return { mode: "authorization", client: { session: { dcId: 5, save: () => "final-session" } } };
      },
      connectForAuthorization: async (envelope: EncryptedSecret) => {
        connectedSession = JSON.parse(decryptSecret(envelope, encryptionKey)).session;
        return { mode: "authorization", client: { session: { dcId: 5, save: () => "final-session" } } };
      },
      signInWithCode: async (_runtime: unknown, phoneNumber: string, phoneCodeHash: string, code: string) => {
        signInArgs = [phoneNumber, phoneCodeHash, code];
      },
      getSelf: async () => ({ id: "42", username: "atlasuser" }),
      saveEncryptedSession: () => encryptSecret(JSON.stringify({ session: "final-session" }), encryptionKey),
      exportSessionString: () => "final-session",
      listDialogs: async () => [],
      safeDisconnect: async () => undefined
    } as any;
    const prisma = {
      telegramAccount: {
        update: async (input: unknown) => updates.push(input)
      },
      telegramOutboundCommand: {
        create: async () => ({ id: "initial-sync-command" })
      }
    } as any;
    const queue = { add: async (_name: string, payload: unknown) => queuedJobs.push(payload) } as any;

    await processSubmitCode(prisma, redis as any, attempts, queue, adapter, env, command);

    expect(connectedSession).toBe("dc5-temp-session");
    expect(signInArgs).toEqual(["+15551234567", "hash-from-telegram", "12345"]);
    expect(await redis.get("otp-secret")).toBeNull();
    expect(await attempts.load("22222222-2222-4222-8222-222222222222")).toBeNull();
    expect(JSON.stringify(updates)).toContain("AUTHORIZED");
    expect(JSON.stringify(updates)).toContain("INITIAL_SYNC");
    expect(queuedJobs).toEqual([{ commandId: "initial-sync-command" }]);
    expect(JSON.stringify(updates)).not.toContain("12345");
  });

  it("runs initial sync with the persisted final session and skips one failed dialog", async () => {
    const updates: unknown[] = [];
    const upsertedChats: unknown[] = [];
    const messages: unknown[] = [];
    const command = createCommand({
      operation: "INITIAL_SYNC",
      telegramAccount: {
        ...createCommand().telegramAccount,
        sessionEncrypted: encryptSecret(JSON.stringify({ session: "final-session" }), encryptionKey),
        authorizationState: "AUTHORIZED",
        status: "SYNCING"
      }
    });
    let connectedSession = "";
    const adapter = {
      connect: async (envelope: EncryptedSecret) => {
        connectedSession = JSON.parse(decryptSecret(envelope, encryptionKey)).session;
        return { mode: "authorization", client: { session: { dcId: 5, save: () => "final-session" } } };
      },
      getSelf: async () => ({ id: "42", username: "Piccaso47" }),
      listDialogs: async () => [
        { telegramChatId: "chat-ok", title: "Saved Chat", username: null, chatType: "PRIVATE", unreadCount: 0, isPinned: false, isBot: false, firstName: "Saved", lastName: "Chat", raw: {} },
        { telegramChatId: "chat-bad", title: "Bad Chat", username: null, chatType: "PRIVATE", unreadCount: 0, isPinned: false, isBot: false, firstName: "Bad", lastName: "Chat", raw: {} }
      ],
      listRecentTextMessages: async (_runtime: unknown, chatId: string) => {
        if (chatId === "chat-bad") throw new Error("dialog fetch failed");
        return [
          {
            telegramChatId: "chat-ok",
            telegramMessageId: "msg-1",
            senderTelegramUserId: "42",
            text: "hello",
            sentAt: new Date("2026-08-02T00:00:00.000Z"),
            editedAt: null,
            replyToTelegramMessageId: null,
            raw: {}
          }
        ];
      },
      resolveChatIdentity: async (_runtime: unknown, chatId: string) => ({
        telegramChatId: chatId,
        title: chatId === "chat-ok" ? "Saved Chat" : "Bad Chat",
        username: null,
        chatType: "PRIVATE",
        unreadCount: 0,
        isPinned: false,
        isBot: false,
        firstName: "Resolved",
        lastName: "Name",
        accessHash: "123456789",
        peerType: "USER",
        phone: null,
        raw: {}
      }),
      safeDisconnect: async () => undefined
    } as any;
    const prisma = {
      telegramAccount: {
        update: async (input: unknown) => updates.push(input)
      },
      telegramChat: {
        findUnique: async () => null,
        findMany: async () => [],
        upsert: async (input: any) => {
          upsertedChats.push(input);
          return {
            id: input.create.telegramChatId === "chat-ok" ? "chat-db-ok" : "chat-db-bad",
            firstName: null,
            lastName: null,
            isBot: false
          };
        },
        update: async () => undefined
      },
      telegramMessage: {
        upsert: async (input: unknown) => messages.push(input)
      }
    } as any;

    const result = await processInitialSync(prisma, adapter, env, command);

    expect(connectedSession).toBe("final-session");
    expect(result).toMatchObject({ ok: true, accountId: command.telegramAccountId, authorizationState: "CONNECTED", telegramUsername: "Piccaso47" });
    expect(upsertedChats).toHaveLength(2);
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(updates)).toContain("CONNECTED");
    expect(JSON.stringify(updates)).toContain("LIVE");
  });
});
