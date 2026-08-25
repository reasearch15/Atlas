import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import type Redis from "ioredis";
import type { PrismaClient } from "@prisma/client";
import { AdminAuthService } from "./admin-auth.service";

const env = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://atlas:atlas@localhost:5432/atlas",
  REDIS_URL: "redis://localhost:6379",
  S3_ENDPOINT: "http://localhost:9000",
  S3_REGION: "us-east-1",
  S3_BUCKET: "atlas",
  S3_ACCESS_KEY_ID: "atlas",
  S3_SECRET_ACCESS_KEY: "secret",
  TELEGRAM_SESSION_ENCRYPTION_KEY: "x".repeat(64),
  JWT_ACCESS_SECRET: "a".repeat(64),
  JWT_REFRESH_SECRET: "r".repeat(64),
  ACCESS_TOKEN_TTL_SECONDS: 900,
  REFRESH_TOKEN_TTL_SECONDS: 2_592_000,
  COOKIE_DOMAIN: "localhost",
  COOKIE_SECURE: true,
  FRONTEND_ORIGIN: "http://localhost:3000",
  BACKEND_HOST: "0.0.0.0",
  BACKEND_PORT: 4000,
  ADMIN_VERIFICATION_TTL_SECONDS: 600,
  ADMIN_VERIFICATION_RESEND_COOLDOWN_SECONDS: 1,
  ADMIN_TRUSTED_DEVICE_TTL_SECONDS: 2_592_000,
  EMAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re_test",
  EMAIL_FROM: "Atlas Security <security@atlasapp.io>",
  ENABLE_DEV_FIXTURES: false
} as const;

interface StoredUser {
  id: string;
  email: string;
  name: string;
  role: "PLATFORM_ADMIN";
  status: "ACTIVE" | "DISABLED";
  workspaceId: null;
}

interface Store {
  user: StoredUser;
  admin: { id: string; userId: string; email: string; passwordHash: string; status: "ACTIVE" | "DISABLED"; user: StoredUser };
  challenges: Array<Record<string, any>>;
  devices: Array<Record<string, any>>;
  sessions: Array<Record<string, any>>;
  auditLogs: Array<Record<string, any>>;
}

class CapturingEmailService {
  public codes: string[] = [];
  public shouldFail = false;

  /**
   * Captures the verification code without logging it.
   */
  public async sendVerificationCode(_to: string, code: string): Promise<void> {
    if (this.shouldFail) {
      throw new Error("Resend send failed");
    }
    this.codes.push(code);
  }
}

function request(body: unknown, cookies: Record<string, string> = {}): FastifyRequest {
  return {
    body,
    cookies,
    ip: "127.0.0.1",
    headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0) AppleWebKit Chrome/126.0 Safari/537.36" }
  } as FastifyRequest;
}

function reply() {
  const cookies: Record<string, string> = {};
  return {
    cookies,
    setCookie: (name: string, value: string) => {
      cookies[name] = value;
    },
    clearCookie: (name: string) => {
      delete cookies[name];
    }
  } as unknown as FastifyReply & { cookies: Record<string, string> };
}

function redis(): Redis {
  const values = new Map<string, number>();
  return {
    incr: async (key: string) => {
      const next = (values.get(key) ?? 0) + 1;
      values.set(key, next);
      return next;
    },
    expire: async () => 1
  } as unknown as Redis;
}

function prisma(store: Store): PrismaClient {
  return {
    platformAdmin: {
      findUnique: async ({ where }: any) => {
        if (where.email === store.admin.email || where.userId === store.admin.userId || where.id === store.admin.id) return store.admin;
        return null;
      },
      findUniqueOrThrow: async () => store.admin,
      update: async ({ data }: any) => Object.assign(store.admin, data)
    },
    adminLoginChallenge: {
      create: async ({ data }: any) => {
        const challenge = { id: randomUUID(), failedAttempts: 0, maxAttempts: 5, consumedAt: null, createdAt: new Date(), ...data };
        store.challenges.push(challenge);
        return challenge;
      },
      findUnique: async ({ where, include }: any) => {
        const challenge = store.challenges.find((item) => item.id === where.id) ?? null;
        return challenge && include ? { ...challenge, admin: store.admin } : challenge;
      },
      update: async ({ where, data }: any) => {
        const challenge = store.challenges.find((item) => item.id === where.id);
        if (!challenge) return null;
        if (data.failedAttempts?.increment) challenge.failedAttempts += data.failedAttempts.increment;
        Object.assign(challenge, { ...data, failedAttempts: challenge.failedAttempts });
        return challenge;
      },
      delete: async ({ where }: any) => {
        const index = store.challenges.findIndex((item) => item.id === where.id);
        if (index >= 0) {
          return store.challenges.splice(index, 1)[0];
        }
        return null;
      },
      updateMany: async ({ where, data }: any) => {
        for (const challenge of store.challenges) {
          if (challenge.adminId === where.adminId && challenge.consumedAt === where.consumedAt) Object.assign(challenge, data);
        }
        return { count: 1 };
      }
    },
    adminTrustedDevice: {
      create: async ({ data }: any) => {
        const device = { id: randomUUID(), revokedAt: null, createdAt: new Date(), updatedAt: new Date(), firstTrustedAt: new Date(), lastUsedAt: new Date(), ...data };
        store.devices.push(device);
        return device;
      },
      findUnique: async ({ where }: any) => store.devices.find((device) => device.tokenHash === where.tokenHash || device.id === where.id) ?? null,
      findMany: async () => store.devices,
      update: async ({ where, data }: any) => Object.assign(store.devices.find((device) => device.id === where.id)!, data),
      updateMany: async ({ where, data }: any) => {
        for (const device of store.devices) {
          if ((!where.id || device.id === where.id) && device.adminId === where.adminId) Object.assign(device, data);
        }
        return { count: 1 };
      }
    },
    session: {
      create: async ({ data }: any) => {
        const session = { id: randomUUID(), revokedAt: null, createdAt: new Date(), lastSeenAt: new Date(), ...data };
        store.sessions.push(session);
        return session;
      },
      update: async ({ where, data }: any) => Object.assign(store.sessions.find((session) => session.id === where.id)!, data),
      updateMany: async ({ where, data }: any) => {
        for (const session of store.sessions) {
          if ((!where.adminTrustedDeviceId || session.adminTrustedDeviceId === where.adminTrustedDeviceId) && (!where.userId || session.userId === where.userId)) {
            Object.assign(session, data);
          }
        }
        return { count: 1 };
      },
      findUnique: async ({ where }: any) => store.sessions.find((session) => session.id === where.id) ?? null
    },
    auditLog: {
      create: async ({ data }: any) => {
        store.auditLogs.push(data);
        return data;
      }
    }
  } as unknown as PrismaClient;
}

async function buildStore(status: "ACTIVE" | "DISABLED" = "ACTIVE"): Promise<Store> {
  const user = {
    id: randomUUID(),
    email: "admin@example.com",
    name: "Platform Admin",
    role: "PLATFORM_ADMIN",
    status,
    workspaceId: null
  } satisfies StoredUser;
  return {
    user,
    admin: {
      id: randomUUID(),
      userId: user.id,
      email: "admin@example.com",
      passwordHash: await bcrypt.hash("CorrectHorse123!", 12),
      status,
      user
    },
    challenges: [],
    devices: [],
    sessions: [],
    auditLogs: []
  };
}

describe("AdminAuthService", () => {
  let email: CapturingEmailService;

  beforeEach(() => {
    email = new CapturingEmailService();
  });

  it("requires verification for correct credentials on a new device and never returns the code", async () => {
    const store = await buildStore();
    const service = new AdminAuthService(prisma(store), redis(), env, email as any);
    const response = await service.login(request({ email: "ADMIN@EXAMPLE.COM", password: "CorrectHorse123!" }), reply());

    expect("requiresVerification" in response).toBe(true);
    expect(JSON.stringify(response)).not.toContain(email.codes[0]);
    expect(store.challenges).toHaveLength(1);
    const challenge = store.challenges[0];
    if (!challenge) throw new Error("Expected a stored challenge");
    expect(await bcrypt.compare(email.codes[0]!, challenge.codeHash)).toBe(true);
  });

  it("rejects wrong passwords generically", async () => {
    const store = await buildStore();
    const service = new AdminAuthService(prisma(store), redis(), env, email as any);

    await expect(service.login(request({ email: "admin@example.com", password: "wrong" }), reply())).rejects.toThrow("Invalid email or password.");
  });

  it("creates a trusted device after correct verification and skips verification after the password on that device", async () => {
    const store = await buildStore();
    const service = new AdminAuthService(prisma(store), redis(), env, email as any);
    const loginResponse = await service.login(request({ email: "admin@example.com", password: "CorrectHorse123!" }), reply());
    if (!("requiresVerification" in loginResponse)) throw new Error("Expected verification challenge");

    const firstReply = reply();
    const verified = await service.verifyDevice(request({ challengeId: loginResponse.challengeId, code: email.codes[0]! }), firstReply);
    expect(verified.accessToken).toBeTruthy();
    expect(store.devices).toHaveLength(1);
    const challenge = store.challenges[0];
    if (!challenge) throw new Error("Expected a stored challenge");
    expect(challenge.consumedAt).toBeInstanceOf(Date);

    const secondReply = reply();
    const trustedLogin = await service.login(
      request({ email: "admin@example.com", password: "CorrectHorse123!" }, { atlas_admin_device: firstReply.cookies.atlas_admin_device! }),
      secondReply
    );
    expect("accessToken" in trustedLogin).toBe(true);
    expect(email.codes).toHaveLength(1);
  });

  it("increments failed attempts and rejects reused or expired codes", async () => {
    const store = await buildStore();
    const service = new AdminAuthService(prisma(store), redis(), env, email as any);
    const loginResponse = await service.login(request({ email: "admin@example.com", password: "CorrectHorse123!" }), reply());
    if (!("requiresVerification" in loginResponse)) throw new Error("Expected verification challenge");

    await expect(service.verifyDevice(request({ challengeId: loginResponse.challengeId, code: "000000" }), reply())).rejects.toThrow(
      "Verification code is invalid or expired."
    );
    const challenge = store.challenges[0];
    if (!challenge) throw new Error("Expected a stored challenge");
    expect(challenge.failedAttempts).toBe(1);

    await service.verifyDevice(request({ challengeId: loginResponse.challengeId, code: email.codes[0]! }), reply());
    await expect(service.verifyDevice(request({ challengeId: loginResponse.challengeId, code: email.codes[0]! }), reply())).rejects.toThrow(
      "Verification code is invalid or expired."
    );
  });

  it("rejects inactive admins", async () => {
    const store = await buildStore("DISABLED");
    const service = new AdminAuthService(prisma(store), redis(), env, email as any);

    await expect(service.login(request({ email: "admin@example.com", password: "CorrectHorse123!" }), reply())).rejects.toThrow(
      "Invalid email or password."
    );
  });

  it("deletes the new challenge when email delivery fails", async () => {
    const store = await buildStore();
    email.shouldFail = true;
    const service = new AdminAuthService(prisma(store), redis(), env, email as any);

    await expect(service.login(request({ email: "admin@example.com", password: "CorrectHorse123!" }), reply())).rejects.toThrow(
      "Verification email could not be delivered: Resend send failed"
    );
    expect(store.challenges).toHaveLength(0);
    expect(store.auditLogs.some((log) => log.action === "admin_auth.verification.email_failed")).toBe(true);
  });
});
