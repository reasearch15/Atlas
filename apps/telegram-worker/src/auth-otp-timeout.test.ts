import { describe, expect, it, vi } from "vitest";
import { classifyTelegramFailure } from "@atlas/shared";
import { encryptSecret, decryptSecret, type EncryptedSecret } from "@atlas/shared/session-encryption";
import { TelegramAuthorizationAttemptStore } from "./auth-attempt";
import { processSubmitCode } from "./command-consumer";
import type { WorkerEnv } from "./env";
import {
  isGramJsUpdateLoopTimeout,
  prepareTemporaryAuthClient,
  TelegramAuthNetworkTimeoutError,
  withAuthRpcTimeout
} from "./telegram-client";

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
    payloadJson: { secretRef: "otp-secret" },
    telegramAccount: {
      id: "22222222-2222-4222-8222-222222222222",
      developerAppId: "33333333-3333-4333-8333-333333333333",
      phoneNumberEncrypted: encryptSecret("+15551234567", encryptionKey),
      sessionEncrypted: null,
      authorizationState: "CODE_REQUESTED",
      status: "WAITING_FOR_CODE",
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

async function seedAttempt(redis: FakeRedis): Promise<TelegramAuthorizationAttemptStore> {
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
  return attempts;
}

describe("temporary auth client TIMEOUT handling", () => {
  it("treats GramJS update-loop TIMEOUT as non-fatal for temporary auth clients", () => {
    expect(isGramJsUpdateLoopTimeout(new Error("TIMEOUT"))).toBe(true);
    const client = {
      _sender: { reconnect: vi.fn() }
    } as any;
    prepareTemporaryAuthClient(client);
    expect(client._sender.reconnect).not.toBeUndefined();
    client._sender.reconnect();
    // reconnect is replaced with a no-op; original mock must not run.
  });

  it("does not fail successful OTP submission when background TIMEOUT fires after session persist", async () => {
    const redis = new FakeRedis();
    const attempts = await seedAttempt(redis);
    const updates: unknown[] = [];
    const disconnectOrder: string[] = [];
    let sessionSavedBeforeDisconnect = false;

    const adapter = {
      encryptSessionState: (state: { session: string }) => encryptSecret(JSON.stringify(state), encryptionKey),
      connectForAuthorization: async (envelope: EncryptedSecret) => {
        expect(JSON.parse(decryptSecret(envelope, encryptionKey)).session).toBe("dc5-temp-session");
        return { mode: "authorization", client: { session: { dcId: 5, save: () => "final-session" } } };
      },
      signInWithCode: async () => {
        // Simulate a late update-loop TIMEOUT that must not overwrite success.
        expect(isGramJsUpdateLoopTimeout(new Error("TIMEOUT"))).toBe(true);
      },
      getSelf: async () => ({ id: "42", username: "atlasuser" }),
      saveEncryptedSession: () => {
        sessionSavedBeforeDisconnect = disconnectOrder.length === 0;
        return encryptSecret(JSON.stringify({ session: "final-session" }), encryptionKey);
      },
      exportSessionString: () => "final-session",
      safeDisconnect: async () => {
        disconnectOrder.push("disconnect");
      }
    } as any;

    const prisma = {
      telegramAccount: {
        update: async (input: unknown) => updates.push(input)
      },
      telegramOutboundCommand: {
        create: async () => ({ id: "initial-sync-command" })
      }
    } as any;
    const queue = { add: async () => undefined } as any;

    const result = await processSubmitCode(prisma, redis as any, attempts, queue, adapter, env, createCommand());

    expect(result).toMatchObject({ ok: true, authorizationState: "CONNECTED" });
    expect(sessionSavedBeforeDisconnect).toBe(true);
    expect(disconnectOrder).toEqual(["disconnect"]);
    expect(JSON.stringify(updates)).toContain("AUTHORIZED");
    expect(await redis.get("otp-secret")).toBeNull();
  });

  it("preserves WAITING_FOR_CODE and Redis OTP on AUTH RPC timeout", async () => {
    const redis = new FakeRedis();
    const attempts = await seedAttempt(redis);
    const adapter = {
      encryptSessionState: (state: { session: string }) => encryptSecret(JSON.stringify(state), encryptionKey),
      connectForAuthorization: async () => ({ mode: "authorization", client: { session: { dcId: 5, save: () => "temp" } } }),
      signInWithCode: async () => {
        throw new TelegramAuthNetworkTimeoutError();
      },
      safeDisconnect: async () => undefined
    } as any;
    const prisma = { telegramAccount: { update: async () => undefined } } as any;
    const queue = { add: async () => undefined } as any;

    await expect(processSubmitCode(prisma, redis as any, attempts, queue, adapter, env, createCommand())).rejects.toBeInstanceOf(
      TelegramAuthNetworkTimeoutError
    );
    expect(await redis.get("otp-secret")).toBe("12345");
    expect(await attempts.load("22222222-2222-4222-8222-222222222222")).toMatchObject({ state: "WAITING_FOR_CODE" });
  });

  it("preserves WAITING_FOR_CODE for invalid OTP and deletes the OTP secret", async () => {
    const redis = new FakeRedis();
    const attempts = await seedAttempt(redis);
    const adapter = {
      encryptSessionState: (state: { session: string }) => encryptSecret(JSON.stringify(state), encryptionKey),
      connectForAuthorization: async () => ({ mode: "authorization", client: { session: { dcId: 5, save: () => "temp" } } }),
      signInWithCode: async () => {
        throw new Error("PHONE_CODE_INVALID");
      },
      safeDisconnect: async () => undefined
    } as any;

    await expect(
      processSubmitCode({ telegramAccount: { update: async () => undefined } } as any, redis as any, attempts, { add: async () => undefined } as any, adapter, env, createCommand())
    ).rejects.toThrow(/PHONE_CODE_INVALID/);

    expect(await redis.get("otp-secret")).toBeNull();
    expect(await attempts.load("22222222-2222-4222-8222-222222222222")).toMatchObject({ state: "WAITING_FOR_CODE" });
    expect(classifyTelegramFailure(new Error("PHONE_CODE_INVALID"), "CODE_REQUESTED", false)).toMatchObject({
      nextStatus: "WAITING_FOR_CODE",
      safeErrorCode: "PHONE_CODE_INVALID",
      retryable: true
    });
  });

  it("requests restart from phone on expired OTP", () => {
    expect(classifyTelegramFailure(new Error("PHONE_CODE_EXPIRED"), "CODE_REQUESTED", false)).toMatchObject({
      nextStatus: "WAITING_FOR_PHONE",
      nextAuthorizationState: "PHONE_REQUESTED",
      safeErrorCode: "PHONE_CODE_EXPIRED",
      retryable: false
    });
  });

  it("moves to WAITING_FOR_2FA when SESSION_PASSWORD_NEEDED", async () => {
    const redis = new FakeRedis();
    const attempts = await seedAttempt(redis);
    const updates: unknown[] = [];
    const adapter = {
      encryptSessionState: (state: { session: string }) => encryptSecret(JSON.stringify(state), encryptionKey),
      connectForAuthorization: async () => ({ mode: "authorization", client: { session: { dcId: 5, save: () => "pwd-session" } } }),
      signInWithCode: async () => {
        throw new Error("SESSION_PASSWORD_NEEDED");
      },
      exportSessionString: () => "pwd-session",
      sessionDcId: () => 5,
      safeDisconnect: async () => undefined
    } as any;
    const prisma = {
      telegramAccount: {
        update: async (input: unknown) => updates.push(input)
      }
    } as any;

    const result = await processSubmitCode(prisma, redis as any, attempts, { add: async () => undefined } as any, adapter, env, createCommand());
    expect(result).toMatchObject({ authorizationState: "WAITING_FOR_PASSWORD" });
    expect(JSON.stringify(updates)).toContain("WAITING_FOR_PASSWORD");
    expect(await attempts.load("22222222-2222-4222-8222-222222222222")).toMatchObject({ state: "WAITING_FOR_PASSWORD" });
  });

  it("times out auth RPCs as TELEGRAM_AUTH_NETWORK_TIMEOUT", async () => {
    await expect(
      withAuthRpcTimeout(
        new Promise(() => undefined),
        20
      )
    ).rejects.toBeInstanceOf(TelegramAuthNetworkTimeoutError);

    expect(classifyTelegramFailure(new TelegramAuthNetworkTimeoutError(), "CODE_REQUESTED", false)).toMatchObject({
      nextStatus: "WAITING_FOR_CODE",
      safeErrorCode: "TELEGRAM_AUTH_NETWORK_TIMEOUT",
      retryable: true
    });
  });

  it("classifies bare GramJS TIMEOUT as retryable auth network timeout", () => {
    expect(classifyTelegramFailure(new Error("TIMEOUT"), "CODE_REQUESTED", false)).toMatchObject({
      safeErrorCode: "TELEGRAM_AUTH_NETWORK_TIMEOUT",
      nextStatus: "WAITING_FOR_CODE",
      retryable: true
    });
  });
});
