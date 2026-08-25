import { describe, expect, it } from "vitest";
import { assertNoOrphanPlatformAdminUsers, assertOrphanPlatformAdminCleanupAllowed, cleanOrphanPlatformAdminUsers, inspectOrphanPlatformAdminUsers } from "./admin-orphan-cleanup.service";

interface Row {
  id: string;
  [key: string]: unknown;
}

interface OrphanState {
  users: Row[];
  platformAdmins: Row[];
  sessions: Row[];
  trustedDevices: Row[];
  auditLogs: Row[];
}

function createState(): OrphanState {
  const expiresAt = new Date(Date.now() + 60_000);
  return {
    users: [
      {
        id: "real-admin-user",
        email: "pokharelayush3@gmail.com",
        role: "PLATFORM_ADMIN",
        status: "ACTIVE",
        createdAt: new Date("2026-08-02T06:31:31.955Z"),
        workspaceId: null,
        isDevelopmentFixture: false,
        fixtureKey: null,
        platformAdminId: "platform-admin",
        ownedWorkspace: null,
        createdDeveloperApps: [],
        createdTelegramAccounts: []
      },
      {
        id: "orphan-admin-user",
        email: "admin@atlas.local",
        role: "PLATFORM_ADMIN",
        status: "ACTIVE",
        createdAt: new Date("2026-08-02T06:01:59.883Z"),
        workspaceId: null,
        isDevelopmentFixture: false,
        fixtureKey: null,
        platformAdminId: null,
        ownedWorkspace: null,
        createdDeveloperApps: [],
        createdTelegramAccounts: []
      },
      {
        id: "real-coadmin-user",
        email: "owner@example.com",
        role: "COADMIN",
        status: "ACTIVE",
        createdAt: new Date("2026-08-02T07:00:00.000Z"),
        workspaceId: "workspace",
        platformAdminId: null
      }
    ],
    platformAdmins: [{ id: "platform-admin", userId: "real-admin-user", email: "pokharelayush3@gmail.com" }],
    sessions: [
      { id: "orphan-session", userId: "orphan-admin-user", revokedAt: null, expiresAt },
      { id: "real-session", userId: "real-admin-user", revokedAt: null, expiresAt }
    ],
    trustedDevices: [{ id: "orphan-device", userId: "orphan-admin-user" }],
    auditLogs: [
      { id: "orphan-audit", actorId: "orphan-admin-user", action: "auth.login", metadata: { sessionId: "orphan-session" } },
      { id: "real-audit", actorId: "real-admin-user", action: "admin_auth.login", metadata: {} }
    ]
  };
}

function createPrisma(state: OrphanState) {
  const userSelect = (row: Row) => ({
    ...row,
    platformAdmin: state.platformAdmins.find((admin) => admin.userId === row.id) ?? null,
    sessions: state.sessions.filter((session) => session.userId === row.id),
    trustedDevices: state.trustedDevices.filter((device) => device.userId === row.id),
    auditLogs: state.auditLogs.filter((auditLog) => auditLog.actorId === row.id),
    ownedWorkspace: row.ownedWorkspace ?? null,
    createdDeveloperApps: row.createdDeveloperApps ?? [],
    createdTelegramAccounts: row.createdTelegramAccounts ?? []
  });

  const prisma = {
    platformAdmin: {
      findMany: async () => state.platformAdmins.map((admin) => ({ email: admin.email }))
    },
    user: {
      findMany: async () =>
        state.users
          .filter((row) => row.role === "PLATFORM_ADMIN" && !state.platformAdmins.some((admin) => admin.userId === row.id))
          .map(userSelect),
      findFirst: async () => {
        const orphan = state.users.find((row) => row.role === "PLATFORM_ADMIN" && !state.platformAdmins.some((admin) => admin.userId === row.id));
        return orphan ? { id: orphan.id, email: orphan.email } : null;
      },
      deleteMany: async ({ where }: { where: { id: { in: string[] }; role: string; platformAdmin: null } }) => {
        const ids = new Set(where.id.in);
        const before = state.users.length;
        state.users = state.users.filter((row) => !(ids.has(row.id) && row.role === where.role && !state.platformAdmins.some((admin) => admin.userId === row.id)));
        for (const auditLog of state.auditLogs) {
          if (ids.has(String(auditLog.actorId))) {
            auditLog.actorId = null;
          }
        }
        return { count: before - state.users.length };
      }
    },
    session: {
      deleteMany: async ({ where }: { where: { userId: { in: string[] } } }) => {
        const ids = new Set(where.userId.in);
        const before = state.sessions.length;
        state.sessions = state.sessions.filter((row) => !ids.has(String(row.userId)));
        return { count: before - state.sessions.length };
      }
    },
    userTrustedDevice: {
      deleteMany: async ({ where }: { where: { userId: { in: string[] } } }) => {
        const ids = new Set(where.userId.in);
        const before = state.trustedDevices.length;
        state.trustedDevices = state.trustedDevices.filter((row) => !ids.has(String(row.userId)));
        return { count: before - state.trustedDevices.length };
      }
    },
    auditLog: {
      create: async ({ data }: { data: Row }) => {
        state.auditLogs.push({ ...data, id: "cleanup-audit" });
      }
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma)
  };

  return prisma as any;
}

describe("orphan Platform Admin cleanup", () => {
  it("finds only users.role=PLATFORM_ADMIN rows without platform_admins records", async () => {
    const plan = await inspectOrphanPlatformAdminUsers(createPrisma(createState()));

    expect(plan.platformAdminCount).toBe(1);
    expect(plan.platformAdminEmail).toBe("pokharelayush3@gmail.com");
    expect(plan.orphanUsers).toEqual([
      expect.objectContaining({
        id: "orphan-admin-user",
        email: "admin@atlas.local",
        sessionCount: 1,
        activeSessionCount: 1,
        trustedDeviceCount: 1,
        auditLogCount: 1
      })
    ]);
  });

  it("removes orphan sessions, trusted devices, and the stale user while preserving real records and audit history", async () => {
    const state = createState();
    await cleanOrphanPlatformAdminUsers(createPrisma(state));

    expect(state.platformAdmins).toEqual([{ id: "platform-admin", userId: "real-admin-user", email: "pokharelayush3@gmail.com" }]);
    expect(state.users.map((row) => row.id)).toEqual(["real-admin-user", "real-coadmin-user"]);
    expect(state.sessions.map((row) => row.id)).toEqual(["real-session"]);
    expect(state.trustedDevices).toHaveLength(0);
    expect(state.auditLogs.find((row) => row.id === "orphan-audit")).toMatchObject({
      actorId: null,
      action: "auth.login",
      metadata: { sessionId: "orphan-session" }
    });
    expect(state.auditLogs.find((row) => row.id === "cleanup-audit")).toMatchObject({
      action: "admin_auth.orphan_platform_admin_users.cleaned"
    });
  });

  it("is idempotent", async () => {
    const state = createState();
    await cleanOrphanPlatformAdminUsers(createPrisma(state));
    const plan = await cleanOrphanPlatformAdminUsers(createPrisma(state));

    expect(plan.orphanUsers).toHaveLength(0);
    expect(state.users.map((row) => row.id)).toEqual(["real-admin-user", "real-coadmin-user"]);
  });

  it("blocks cleanup when an orphan owns business data", async () => {
    const state = createState();
    state.users[1]!.createdDeveloperApps = [{ id: "app" }];

    await expect(cleanOrphanPlatformAdminUsers(createPrisma(state))).rejects.toThrow("owns business data");
  });

  it("fails startup validation when an orphan Platform Admin identity exists", async () => {
    await expect(assertNoOrphanPlatformAdminUsers(createPrisma(createState()))).rejects.toThrow("Orphan Platform Admin user detected");
  });

  it("blocks production execution", () => {
    expect(() => assertOrphanPlatformAdminCleanupAllowed("production")).toThrow("production");
    expect(() => assertOrphanPlatformAdminCleanupAllowed("development")).not.toThrow();
  });
});
