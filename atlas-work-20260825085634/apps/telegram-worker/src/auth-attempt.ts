import Redis from "ioredis";
import { decryptSecret, encryptSecret, type EncryptedSecret } from "@atlas/shared/session-encryption";
import type { WorkerEnv } from "./env";
import { assertPlainSerializable } from "./plain-serialization";

const attemptTtlSeconds = 15 * 60;
const attemptVersion = 1;

export interface TelegramAuthorizationAttemptState {
  readonly accountId: string;
  readonly workspaceId: string;
  readonly developerAppId: string;
  readonly state: "WAITING_FOR_CODE" | "WAITING_FOR_PASSWORD";
  readonly temporarySession: string;
  readonly phoneNumber: string;
  readonly phoneCodeHash: string;
  readonly targetDcId: number | null;
  readonly workerId: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredTelegramAuthAttempt {
  readonly version: 1;
  readonly accountId: string;
  readonly workspaceId: string;
  readonly developerAppId: string;
  readonly state: "WAITING_FOR_CODE" | "WAITING_FOR_PASSWORD";
  readonly encryptedTemporarySession: string;
  readonly encryptedPhoneCodeHash: string;
  readonly encryptedPhoneNumber: string;
  readonly targetDcId: number | null;
  readonly workerId: string;
  readonly expiresAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class TelegramAuthorizationAttemptStore {
  private readonly redis: Redis;
  private readonly env: WorkerEnv;

  public constructor(redis: Redis, env: WorkerEnv) {
    this.redis = redis;
    this.env = env;
  }

  public async save(input: Omit<TelegramAuthorizationAttemptState, "expiresAt" | "createdAt" | "updatedAt">): Promise<TelegramAuthorizationAttemptState> {
    assertString(input.temporarySession, "TELEGRAM_TEMP_SESSION_EXPORT_INVALID");
    assertString(input.phoneCodeHash, "TELEGRAM_PHONE_CODE_HASH_INVALID");
    assertString(input.phoneNumber, "TELEGRAM_PHONE_NUMBER_CONTEXT_INVALID");
    const existing = await this.load(input.accountId);
    const now = new Date();
    const attempt: TelegramAuthorizationAttemptState = {
      ...input,
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + attemptTtlSeconds * 1000).toISOString()
    };
    const stored: StoredTelegramAuthAttempt = {
      version: attemptVersion,
      accountId: attempt.accountId,
      workspaceId: attempt.workspaceId,
      developerAppId: attempt.developerAppId,
      state: attempt.state,
      encryptedTemporarySession: encryptedScalar(attempt.temporarySession, this.env),
      encryptedPhoneCodeHash: encryptedScalar(attempt.phoneCodeHash, this.env),
      encryptedPhoneNumber: encryptedScalar(attempt.phoneNumber, this.env),
      targetDcId: attempt.targetDcId,
      workerId: attempt.workerId,
      expiresAt: attempt.expiresAt,
      createdAt: attempt.createdAt,
      updatedAt: attempt.updatedAt
    };
    assertPlainSerializable(stored, "REDIS_AUTH_ATTEMPT");
    await this.redis.set(this.key(input.accountId), JSON.stringify(stored), "EX", attemptTtlSeconds);
    return attempt;
  }

  public async load(accountId: string): Promise<TelegramAuthorizationAttemptState | null> {
    const raw = await this.redis.get(this.key(accountId));
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredTelegramAuthAttempt;
    assertPlainSerializable(stored, "REDIS_AUTH_ATTEMPT_LOADED");
    return {
      accountId: stored.accountId,
      workspaceId: stored.workspaceId,
      developerAppId: stored.developerAppId,
      state: stored.state,
      temporarySession: decryptScalar(stored.encryptedTemporarySession, this.env),
      phoneCodeHash: decryptScalar(stored.encryptedPhoneCodeHash, this.env),
      phoneNumber: decryptScalar(stored.encryptedPhoneNumber, this.env),
      targetDcId: stored.targetDcId,
      workerId: stored.workerId,
      expiresAt: stored.expiresAt,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt
    };
  }

  public async clear(accountId: string): Promise<void> {
    await this.redis.del(this.key(accountId));
  }

  private key(accountId: string): string {
    return `telegram-auth-attempt:${accountId}`;
  }
}

export function telegramAuthorizationAttemptTtlSeconds(): number {
  return attemptTtlSeconds;
}

function encryptedScalar(value: string, env: WorkerEnv): string {
  return JSON.stringify(encryptSecret(value, env.TELEGRAM_SESSION_ENCRYPTION_KEY));
}

function decryptScalar(value: string, env: WorkerEnv): string {
  return decryptSecret(JSON.parse(value) as EncryptedSecret, env.TELEGRAM_SESSION_ENCRYPTION_KEY);
}

function assertString(value: unknown, code: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(code);
  }
}
