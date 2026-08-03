import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";
import type Redis from "ioredis";
import { describe, expect, it } from "vitest";
import type { Env } from "../../config/env";
import { CoadminAuthService } from "./coadmin-auth.service";

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
} satisfies Env;

interface TenantStore {
  user: Record<string, any>;
  sessions: Array<Record<string, any>>;
  trustedDevices: Array<Record<string, any>>;
  auditLogs: Array<Record<string, any>>;
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
  const counters = new Map<string, number>();
  const values = new Map<string, string>();
  return {
    incr: async (key: string) => {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    },
    expire: async () => 1,
    set: async (key: string, value: string) => {
      values.set(key, value);
      return "OK";
    },
    get: async (key: string) => values.get(key) ?? null,
    del: async (key: string) => {
      const existed = values.delete(key);
      return existed ? 1 : 0;
    }
  } as unknown as Redis;
}

function prisma(store: TenantStore): PrismaClient {
  const client = {
    user: {
      findUnique: async ({ where }: any) => (where.username === store.user.username || where.id === store.user.id ? store.user : null),
      findUniqueOrThrow: async ({ where }: any) => {
        if (where.id === store.user.id) return store.user;
        throw new Error("User not found");
      },
      update: async ({ where, data }: any) => {
        if (where.id !== store.user.id) throw new Error("User not found");
        Object.assign(store.user, data);
        return store.user;
      }
    },
    session: {
      count: async () => store.sessions.filter((session) => !session.revokedAt).length,
      create: async ({ data }: any) => {
        const session = { id: randomUUID(), revokedAt: null, createdAt: new Date(), lastSeenAt: new Date(), ...data };
        store.sessions.push(session);
        return session;
      },
      update: async ({ where, data }: any) => {
        const session = store.sessions.find((item) => item.id === where.id);
        if (!session) throw new Error("Session not found");
        Object.assign(session, data);
        return session;
      },
      updateMany: async ({ where, data }: any) => {
        for (const session of store.sessions) {
          if ((!where.userId || session.userId === where.userId) && (!where.userTrustedDeviceId || session.userTrustedDeviceId === where.userTrustedDeviceId)) {
            Object.assign(session, data);
          }
        }
        return { count: store.sessions.length };
      },
      findUnique: async ({ where, include }: any) => {
        const session = store.sessions.find((item) => item.id === where.id) ?? null;
        if (!session) return null;
        if (include?.user) {
          return { ...session, user: store.user };
        }
        return session;
      }
    },
    userTrustedDevice: {
      count: async () => store.trustedDevices.filter((device) => !device.revokedAt).length,
      create: async ({ data }: any) => {
        const device = { id: randomUUID(), revokedAt: null, createdAt: new Date(), updatedAt: new Date(), firstTrustedAt: new Date(), lastUsedAt: new Date(), ...data };
        store.trustedDevices.push(device);
        return device;
      },
      findUnique: async ({ where }: any) => store.trustedDevices.find((device) => device.tokenHash === where.tokenHash || device.id === where.id) ?? null,
      update: async ({ where, data }: any) => Object.assign(store.trustedDevices.find((device) => device.id === where.id)!, data),
      updateMany: async ({ where, data }: any) => {
        for (const device of store.trustedDevices) {
          if ((!where.userId || device.userId === where.userId) && (!where.id || device.id === where.id)) Object.assign(device, data);
        }
        return { count: store.trustedDevices.length };
      }
    },
    auditLog: {
      create: async ({ data }: any) => {
        store.auditLogs.push(data);
        return data;
      }
    },
    telegramAccount: { count: async () => 0 },
    developerApp: { count: async () => 0 },
    $transaction: async (callback: any) => callback(client)
  };
  return client as unknown as PrismaClient;
}

async function storeFor(role: "COADMIN" | "STAFF" = "COADMIN"): Promise<TenantStore> {
  return {
    user: {
      id: randomUUID(),
      email: null,
      username: role === "COADMIN" ? "north-coadmin" : "north-staff",
      name: role === "COADMIN" ? "North Coadmin" : "North Staff",
      role,
      status: "ACTIVE",
      workspaceId: randomUUID(),
      workspace: { id: randomUUID(), name: "North", slug: "north", status: "ACTIVE" },
      passwordHash: await bcrypt.hash("TempPassword123!", 12),
      mustChangePassword: true,
      passwordChangedAt: null,
      temporaryPasswordIssuedAt: new Date()
    },
    sessions: [],
    trustedDevices: [],
    auditLogs: []
  };
}

describe("CoadminAuthService tenant password onboarding", () => {
  it("requires password change for temporary credentials without creating a session", async () => {
    const store = await storeFor();
    const service = new CoadminAuthService(prisma(store), redis(), env);
    const response = await service.login(request({ username: "north-coadmin", password: "TempPassword123!" }), reply());

    expect("requiresPasswordChange" in response).toBe(true);
    expect(store.sessions).toHaveLength(0);
    expect(store.trustedDevices).toHaveLength(0);
  });

  it("blocks dashboard access until the temporary password is changed", async () => {
    const store = await storeFor();
    const service = new CoadminAuthService(prisma(store), redis(), env);

    await expect(
      service.me({ id: store.user.id, email: store.user.username, name: store.user.name, role: "COADMIN", workspaceId: store.user.workspaceId, sessionId: randomUUID() })
    ).rejects.toThrow("Password change is required before accessing this area.");
  });

  it("changes the temporary password once and creates the first normal Coadmin session", async () => {
    const store = await storeFor();
    const fakeRedis = redis();
    const service = new CoadminAuthService(prisma(store), fakeRedis, env);
    const login = await service.login(request({ username: "north-coadmin", password: "TempPassword123!" }), reply());
    if (!("requiresPasswordChange" in login)) throw new Error("Expected password change response.");

    const response = await service.changePassword(
      request({ changeToken: login.changeToken, password: "PermanentPass123!", confirmPassword: "PermanentPass123!" }),
      reply()
    );

    expect(response.accessToken).toBeTruthy();
    expect(store.user.mustChangePassword).toBe(false);
    expect(store.user.passwordChangedAt).toBeInstanceOf(Date);
    expect(store.sessions).toHaveLength(1);
    expect(store.trustedDevices).toHaveLength(1);
    expect(store.auditLogs.some((entry) => entry.action === "first_login.password_changed")).toBe(true);
  });

  it("uses the same temporary-password flow for Staff without Coadmin email verification", async () => {
    const store = await storeFor("STAFF");
    const service = new CoadminAuthService(prisma(store), redis(), env, "STAFF");
    const response = await service.login(request({ username: "north-staff", password: "TempPassword123!" }), reply());

    expect("requiresPasswordChange" in response).toBe(true);
    expect(store.sessions).toHaveLength(0);
    expect(store.auditLogs.every((entry) => !String(entry.action).includes("verification"))).toBe(true);
  });
});

describe("CoadminAuthService refresh session continuity", () => {
  async function establishSession(role: "COADMIN" | "STAFF" = "COADMIN") {
    const store = await storeFor(role);
    store.user.mustChangePassword = false;
    store.user.status = "ACTIVE";
    store.user.passwordHash = await bcrypt.hash("PermanentPass123!", 12);
    const service = new CoadminAuthService(prisma(store), redis(), env, role);
    const loginReply = reply();
    const login = await service.login(
      request({ username: store.user.username, password: "PermanentPass123!" }),
      loginReply
    );
    if ("requiresPasswordChange" in login) throw new Error("Expected authenticated session.");
    const cookieName = role === "COADMIN" ? "atlas_coadmin_refresh" : "atlas_staff_refresh";
    return { store, service, refreshToken: loginReply.cookies[cookieName]!, cookieName, user: login.user };
  }

  it("restores access from a valid refresh cookie", async () => {
    const { service, refreshToken, cookieName, user } = await establishSession("COADMIN");
    const refreshed = await service.refresh(request({}, { [cookieName]: refreshToken }), reply());
    expect(refreshed.accessToken).toBeTruthy();
    expect(refreshed.user.role).toBe("COADMIN");
    expect(refreshed.user.id).toBe(user.id);
  });

  it("rejects an expired refresh session", async () => {
    const { store, service, refreshToken, cookieName } = await establishSession("COADMIN");
    store.sessions[0]!.expiresAt = new Date(Date.now() - 1_000);
    await expect(service.refresh(request({}, { [cookieName]: refreshToken }), reply())).rejects.toThrow();
  });

  it("rejects a revoked refresh session", async () => {
    const { store, service, refreshToken, cookieName } = await establishSession("COADMIN");
    store.sessions[0]!.revokedAt = new Date();
    await expect(service.refresh(request({}, { [cookieName]: refreshToken }), reply())).rejects.toThrow();
  });

  it("returns staff role from staff refresh sessions", async () => {
    const { service, refreshToken, cookieName } = await establishSession("STAFF");
    const refreshed = await service.refresh(request({}, { [cookieName]: refreshToken }), reply());
    expect(refreshed.user.role).toBe("STAFF");
  });
});
