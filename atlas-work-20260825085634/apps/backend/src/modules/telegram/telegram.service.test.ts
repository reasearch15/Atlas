import { describe, expect, it } from "vitest";
import { canTransitionAuthorization } from "@atlas/shared";
import { decryptSecret, encryptSecret, type EncryptedSecret } from "@atlas/shared/session-encryption";
import type { RequestUser } from "../auth/auth.types";
import { TelegramService } from "./telegram.service";

describe("Telegram authorization state machine", () => {
  it("allows code authorization to advance to password or authorized", () => {
    expect(canTransitionAuthorization("CODE_REQUESTED", "PASSWORD_REQUESTED")).toBe(true);
    expect(canTransitionAuthorization("CODE_REQUESTED", "AUTHORIZED")).toBe(true);
  });

  it("rejects impossible transitions", () => {
    expect(canTransitionAuthorization("EMPTY", "AUTHORIZED")).toBe(false);
    expect(canTransitionAuthorization("AUTHORIZED", "CODE_REQUESTED")).toBe(false);
  });
});

const encryptionKey = "e".repeat(64);
const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "22222222-2222-4222-8222-222222222222";
const developerAppId = "33333333-3333-4333-8333-333333333333";
const coadmin: RequestUser = {
  id: "44444444-4444-4444-8444-444444444444",
  email: "coadmin",
  name: "Coadmin",
  role: "COADMIN",
  workspaceId,
  sessionId: "55555555-5555-4555-8555-555555555555"
};
const staff: RequestUser = { ...coadmin, id: "66666666-6666-4666-8666-666666666666", role: "STAFF" };
const otherCoadmin: RequestUser = { ...coadmin, id: "77777777-7777-4777-8777-777777777777", workspaceId: otherWorkspaceId };

interface Row {
  id: string;
  [key: string]: unknown;
}

function createState() {
  return {
    developerApps: [{ id: developerAppId, workspaceId, provider: "TELEGRAM", status: "ACTIVE", deletedAt: null }],
    accounts: [] as Row[],
    commands: [] as Row[],
    auditLogs: [] as Row[],
    redis: new Map<string, string>(),
    jobs: [] as Row[]
  };
}

function createService(state: ReturnType<typeof createState>) {
  const prisma = {
    developerApp: {
      findFirst: async ({ where }: { where: Row }) =>
        state.developerApps.find((app) => app.id === where.id && app.workspaceId === where.workspaceId && app.provider === where.provider && app.status === where.status && app.deletedAt === where.deletedAt) ?? null
    },
    telegramAccount: {
      create: async ({ data }: { data: Row }) => {
        const now = new Date("2026-08-02T00:00:00.000Z");
        const account = {
          telegramUserId: null,
          telegramUsername: null,
          phoneNumberEncrypted: null,
          sessionEncrypted: null,
          status: "PENDING",
          authorizationState: "EMPTY",
          syncState: "IDLE",
          lastConnectedAt: null,
          lastUpdateAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          createdAt: now,
          ...data,
          id: `account-${state.accounts.length + 1}`
        };
        state.accounts.push(account);
        return account;
      },
      findMany: async ({ where, select }: { where: Row; select?: Row }) => {
        const rows = state.accounts.filter((account) => {
          if (where.workspaceId && account.workspaceId !== where.workspaceId) return false;
          if (where.status && typeof where.status === "object" && account.status === (where.status as { not: string }).not) return false;
          if (where.phoneNumberEncrypted && account.phoneNumberEncrypted === null) return false;
          return true;
        });
        return select ? rows.map((row) => ({ id: row.id, phoneNumberEncrypted: row.phoneNumberEncrypted })) : rows;
      },
      findFirst: async ({ where }: { where: Row }) => state.accounts.find((account) => account.id === where.id && account.workspaceId === where.workspaceId) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const account = state.accounts.find((row) => row.id === where.id);
        if (!account) throw new Error("missing account");
        Object.assign(account, data);
        return account;
      }
    },
    telegramOutboundCommand: {
      create: async ({ data }: { data: Row }) => {
        const command = { status: "QUEUED", attempts: 0, ...data, id: `command-${state.commands.length + 1}` };
        state.commands.push(command);
        return command;
      },
      findFirst: async ({ where }: { where: Row }) => {
        return (
          state.commands.find((command) => {
            const statusFilter = where.status as { in?: string[] } | undefined;
            if (where.telegramAccountId && command.telegramAccountId !== where.telegramAccountId) return false;
            if (where.operation && command.operation !== where.operation) return false;
            if (statusFilter?.in && !statusFilter.in.includes(command.status as string)) return false;
            return true;
          }) ?? null
        );
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        let count = 0;
        for (const command of state.commands) {
          const operationFilter = where.operation as { in?: string[] } | undefined;
          const statusFilter = where.status as { in?: string[] } | undefined;
          if (where.telegramAccountId && command.telegramAccountId !== where.telegramAccountId) continue;
          if (operationFilter?.in && !operationFilter.in.includes(command.operation as string)) continue;
          if (statusFilter?.in && !statusFilter.in.includes(command.status as string)) continue;
          Object.assign(command, data);
          count += 1;
        }
        return { count };
      }
    },
    auditLog: {
      create: async ({ data }: { data: Row }) => {
        state.auditLogs.push({ ...data, id: `audit-${state.auditLogs.length + 1}` });
      }
    }
  };
  return new TelegramService({
    prisma,
    redis: {
      set: async (key: string, value: string) => state.redis.set(key, value),
      scan: async (_cursor: string, _match: string, pattern: string) => {
        const prefix = pattern.replace("*", "");
        return ["0", [...state.redis.keys()].filter((key) => key.startsWith(prefix))];
      },
      del: async (...keys: string[]) => {
        keys.forEach((key) => state.redis.delete(key));
        return keys.length;
      }
    },
    queues: {
      telegramOutbound: {
        add: async (_name: string, payload: Row) => state.jobs.push(payload),
        getJobCounts: async () => ({ waiting: 0, active: 0, delayed: 0, failed: 0 })
      }
    },
    env: { TELEGRAM_SESSION_ENCRYPTION_KEY: encryptionKey }
  } as any);
}

describe("TelegramService account connection", () => {
  it("lets a Coadmin create an account in their workspace and rejects Staff", async () => {
    const state = createState();
    const service = createService(state);
    const account = await service.createAccount(coadmin, { developerAppId, displayName: "Support" });

    expect(account).toMatchObject({ workspaceId, developerAppId, displayName: "Support", maskedPhoneNumber: null });
    await expect(service.createAccount(staff, { developerAppId, displayName: "Nope" })).rejects.toMatchObject({ statusCode: 403 });
  });

  it("denies cross-workspace access and disabled Developer Apps", async () => {
    const state = createState();
    const service = createService(state);
    const account = await service.createAccount(coadmin, { developerAppId, displayName: "Support" });
    state.developerApps[0]!.status = "DISABLED";

    await expect(service.getAccount(otherCoadmin, account.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.createAccount(coadmin, { developerAppId, displayName: "Disabled" })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("encrypts phone numbers, returns only masked phone, and stores OTP only in Redis", async () => {
    const state = createState();
    const service = createService(state);
    const account = await service.createAccount(coadmin, { developerAppId, displayName: "Support" });
    await service.startAuthorization(coadmin, account.id);
    const phoneResponse = await service.submitPhone(coadmin, account.id, { phoneNumber: "+15551234567" });

    expect(phoneResponse.maskedPhoneNumber).toBe("+15******567");
    const encryptedPhone = state.accounts[0]!.phoneNumberEncrypted as EncryptedSecret;
    expect(JSON.stringify(encryptedPhone)).not.toContain("+15551234567");
    expect(decryptSecret(encryptedPhone, encryptionKey)).toBe("+15551234567");

    await service.submitCode(coadmin, account.id, { code: "12345" });
    expect(JSON.stringify(state.commands)).not.toContain("12345");
    expect([...state.redis.values()]).toEqual(["12345"]);

    await expect(service.submitCode(coadmin, account.id, { code: "99999" })).rejects.toMatchObject({
      statusCode: 409,
      code: "TELEGRAM_AUTH_COMMAND_IN_PROGRESS"
    });
  });

  it("rejects invalid transitions and duplicate connected phones", async () => {
    const state = createState();
    const service = createService(state);
    const first = await service.createAccount(coadmin, { developerAppId, displayName: "First" });
    const second = await service.createAccount(coadmin, { developerAppId, displayName: "Second" });

    await expect(service.submitCode(coadmin, first.id, { code: "12345" })).rejects.toMatchObject({ code: "TELEGRAM_INVALID_STATE_TRANSITION" });
    state.accounts[0]!.phoneNumberEncrypted = encryptSecret("+15551234567", encryptionKey);
    state.accounts[0]!.status = "CONNECTED";
    await service.startAuthorization(coadmin, second.id);
    await expect(service.submitPhone(coadmin, second.id, { phoneNumber: "+15551234567" })).rejects.toMatchObject({
      statusCode: 409,
      code: "TELEGRAM_ACCOUNT_ALREADY_CONNECTED"
    });
  });

  it("reauthorizes and disconnects accounts without exposing session material", async () => {
    const state = createState();
    const service = createService(state);
    const account = await service.createAccount(coadmin, { developerAppId, displayName: "Support" });
    state.accounts[0]!.sessionEncrypted = encryptSecret("session", encryptionKey);

    const reauth = await service.reauthorize(coadmin, account.id);
    expect(reauth).toMatchObject({ status: "AUTHORIZING", authorizationState: "REAUTH_REQUIRED" });
    expect(JSON.stringify(reauth)).not.toContain("session");

    const disconnected = await service.disconnect(coadmin, account.id);
    expect(disconnected).toMatchObject({ status: "DISCONNECTED", syncState: "PAUSED" });
    expect(state.commands.at(-1)).toMatchObject({ operation: "DISCONNECT" });
  });

  it("restarts stuck reauthorization so submit-phone can run again", async () => {
    const state = createState();
    const service = createService(state);
    const account = await service.createAccount(coadmin, { developerAppId, displayName: "+15551234567" });
    state.accounts[0]!.status = "REAUTH_REQUIRED";
    state.accounts[0]!.authorizationState = "REAUTH_REQUIRED";
    state.accounts[0]!.syncState = "PAUSED";
    state.accounts[0]!.lastErrorCode = "TELEGRAM_INTERNAL_SERIALIZATION_ERROR";
    state.accounts[0]!.lastErrorMessage = "Telegram returned an internal response that could not be processed safely.";
    state.commands.push({ id: "command-stale", telegramAccountId: account.id, operation: "SUBMIT_PHONE", status: "FAILED_RETRYABLE" });
    state.redis.set(`telegram-auth:${account.id}:code:old`, "12345");

    await expect(service.submitPhone(coadmin, account.id, { phoneNumber: "+15551234567" })).rejects.toMatchObject({
      code: "TELEGRAM_INVALID_STATE_TRANSITION"
    });

    const restarted = await service.restartAuthorization(coadmin, account.id);
    expect(restarted).toMatchObject({
      status: "WAITING_FOR_PHONE",
      authorizationState: "PHONE_REQUESTED",
      syncState: "IDLE",
      lastErrorCode: null,
      lastErrorMessage: null,
      maskedPhoneNumber: null
    });
    expect(state.commands[0]).toMatchObject({ status: "CANCELLED", lastError: null });
    expect([...state.redis.keys()]).toHaveLength(0);

    const submitted = await service.submitPhone(coadmin, account.id, { phoneNumber: "+15551234567" });
    expect(submitted).toMatchObject({ status: "WAITING_FOR_CODE", authorizationState: "CODE_REQUESTED", maskedPhoneNumber: "+15******567" });
    expect(JSON.stringify(submitted)).not.toContain("+15551234567");
  });
});
