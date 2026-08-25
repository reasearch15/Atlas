import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { loadPlatformAdminSummary, resetPlatformAdminCredentials } from "./admin-recovery.service";

interface RecoveryStore {
  readonly userId: string;
  readonly adminId: string;
  userEmail: string;
  userPasswordHash: string;
  adminEmail: string;
  adminPasswordHash: string;
  passwordChangedAt: Date;
  sessions: Array<{ userId: string; revokedAt: Date | null }>;
  devices: Array<{ adminId: string; revokedAt: Date | null }>;
  challenges: Array<{ adminId: string; consumedAt: Date | null }>;
  auditLogs: Array<Record<string, unknown>>;
  summarySelect?: Record<string, unknown>;
  adminCount?: number;
}

function prisma(store: RecoveryStore) {
  const client: Record<string, any> = {
    platformAdmin: {
      findMany: async (args: any) => {
        if (args?.select) {
          store.summarySelect = args.select;
          return [
            {
              id: store.adminId,
              email: store.adminEmail,
              status: "ACTIVE",
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              lastLoginAt: null
            }
          ];
        }
        const admin = {
          id: store.adminId,
          userId: store.userId,
          email: store.adminEmail,
          passwordHash: store.adminPasswordHash,
          status: "ACTIVE",
          user: { id: store.userId, email: store.userEmail }
        };
        return Array.from({ length: store.adminCount ?? 1 }, (_, index) => ({ ...admin, id: index === 0 ? store.adminId : randomUUID() }));
      },
      update: async ({ data }: any) => {
        store.adminEmail = data.email;
        store.adminPasswordHash = data.passwordHash;
        store.passwordChangedAt = data.passwordChangedAt;
        return {};
      }
    },
    user: {
      update: async ({ data }: any) => {
        store.userEmail = data.email;
        store.userPasswordHash = data.passwordHash;
        return {};
      }
    },
    session: {
      updateMany: async ({ data }: any) => {
        let count = 0;
        for (const session of store.sessions) {
          if (session.userId === store.userId && !session.revokedAt) {
            session.revokedAt = data.revokedAt;
            count += 1;
          }
        }
        return { count };
      }
    },
    adminTrustedDevice: {
      updateMany: async ({ data }: any) => {
        let count = 0;
        for (const device of store.devices) {
          if (device.adminId === store.adminId && !device.revokedAt) {
            device.revokedAt = data.revokedAt;
            count += 1;
          }
        }
        return { count };
      }
    },
    adminLoginChallenge: {
      updateMany: async ({ data }: any) => {
        let count = 0;
        for (const challenge of store.challenges) {
          if (challenge.adminId === store.adminId && !challenge.consumedAt) {
            challenge.consumedAt = data.consumedAt;
            count += 1;
          }
        }
        return { count };
      }
    },
    auditLog: {
      create: async ({ data }: any) => {
        store.auditLogs.push(data);
        return data;
      }
    },
    $transaction: async (callback: (tx: Record<string, any>) => Promise<unknown>) => callback(client)
  };
  return client as any;
}

async function store(): Promise<RecoveryStore> {
  const userId = randomUUID();
  const adminId = randomUUID();
  const hash = await bcrypt.hash("OldPassword123!", 12);
  return {
    userId,
    adminId,
    userEmail: "admin@example.com",
    userPasswordHash: hash,
    adminEmail: "admin@example.com",
    adminPasswordHash: hash,
    passwordChangedAt: new Date("2026-01-01T00:00:00.000Z"),
    sessions: [{ userId, revokedAt: null }, { userId, revokedAt: new Date() }],
    devices: [{ adminId, revokedAt: null }, { adminId, revokedAt: new Date() }],
    challenges: [{ adminId, consumedAt: null }, { adminId, consumedAt: new Date() }],
    auditLogs: []
  };
}

describe("admin recovery service", () => {
  it("loads only non-secret admin summary fields", async () => {
    const recoveryStore = await store();
    const summary = await loadPlatformAdminSummary(prisma(recoveryStore));

    expect(summary.email).toBe("admin@example.com");
    expect(recoveryStore.summarySelect).not.toHaveProperty("passwordHash");
    expect(recoveryStore.summarySelect).not.toHaveProperty("trustedDevices");
  });

  it("resets credentials without creating another admin and revokes active access", async () => {
    const recoveryStore = await store();
    const originalAdminId = recoveryStore.adminId;
    const result = await resetPlatformAdminCredentials(prisma(recoveryStore), {
      email: "ADMIN.RECOVERED@EXAMPLE.COM",
      password: "NewPassword123!"
    });

    expect(result.adminId).toBe(originalAdminId);
    expect(result.email).toBe("admin.recovered@example.com");
    expect(recoveryStore.adminEmail).toBe("admin.recovered@example.com");
    expect(recoveryStore.userEmail).toBe("admin.recovered@example.com");
    expect(await bcrypt.compare("NewPassword123!", recoveryStore.adminPasswordHash)).toBe(true);
    expect(recoveryStore.adminPasswordHash).not.toBe("NewPassword123!");
    expect(recoveryStore.userPasswordHash).toBe(recoveryStore.adminPasswordHash);
    expect(recoveryStore.sessions.filter((session) => session.revokedAt)).toHaveLength(2);
    expect(recoveryStore.devices.filter((device) => device.revokedAt)).toHaveLength(2);
    expect(recoveryStore.challenges.filter((challenge) => challenge.consumedAt)).toHaveLength(2);
    expect(recoveryStore.auditLogs[0]).toMatchObject({ action: "ADMIN_CREDENTIALS_RESET", actorId: recoveryStore.userId });
  });

  it("rejects weak passwords using the current policy", async () => {
    const recoveryStore = await store();

    await expect(resetPlatformAdminCredentials(prisma(recoveryStore), { password: "short" })).rejects.toThrow();
  });

  it("rejects reset when more than one Platform Admin is present", async () => {
    const recoveryStore = await store();
    recoveryStore.adminCount = 2;

    await expect(resetPlatformAdminCredentials(prisma(recoveryStore), { password: "NewPassword123!" })).rejects.toThrow(
      "More than one Platform Admin exists. Reset aborted."
    );
  });
});
