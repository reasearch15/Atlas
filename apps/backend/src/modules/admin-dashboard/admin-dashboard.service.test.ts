import { describe, expect, it } from "vitest";
import { AdminDashboardService } from "./admin-dashboard.service";

function prisma() {
  return {
    platformAdmin: {
      findUnique: async () => ({ id: "admin-id", userId: "admin-user-id", lastLoginAt: new Date("2026-08-02T07:00:00.000Z") })
    },
    user: {
      count: async ({ where }: any) => (where.role === "COADMIN" ? 2 : 4),
      findMany: async () => [
        {
          id: "coadmin-id",
          name: "Acme Admin",
          email: "coadmin@acme.test",
          status: "ACTIVE",
          createdAt: new Date("2026-08-02T06:00:00.000Z"),
          workspace: { name: "Acme Operations" }
        }
      ]
    },
    workspace: { count: async () => 3 },
    telegramAccount: { count: async () => 1 },
    session: { count: async () => 1 },
    adminTrustedDevice: { count: async () => 1 },
    auditLog: {
      count: async () => 5,
      findMany: async () => [
        {
          id: "audit-id",
          action: "admin_auth.password_login.success",
          actor: { email: "admin@example.com" },
          createdAt: new Date("2026-08-02T07:10:00.000Z"),
          ipAddress: "127.0.0.1"
        }
      ]
    },
    $queryRaw: async () => [{ "?column?": 1 }]
  } as any;
}

describe("AdminDashboardService", () => {
  it("builds dashboard data from real persistence calls", async () => {
    const service = new AdminDashboardService(
      prisma(),
      {
        ping: async () => "PONG",
        get: async () => JSON.stringify({ lastHeartbeatAt: new Date().toISOString() })
      } as any,
      { assertReady: async () => undefined }
    );

    const dashboard = await service.getDashboard("admin-user-id");

    expect(dashboard.counts).toEqual({
      coadmins: 2,
      workspaces: 3,
      staff: 4,
      telegramAccounts: 1,
      unclaimedConversations: null
    });
    expect(dashboard.security).toMatchObject({ activeSessions: 1, trustedDevices: 1, recentFailedLogins: 5 });
    expect(dashboard.health).toEqual({
      backend: "HEALTHY",
      database: "HEALTHY",
      redis: "HEALTHY",
      storage: "HEALTHY",
      telegramWorker: "HEALTHY"
    });
    expect(dashboard.recentCoadmins[0]).toMatchObject({ name: "Acme Admin", workspaceName: "Acme Operations" });
    expect(dashboard.recentAuditEvents[0]).toMatchObject({ action: "admin_auth.password_login.success", status: "Success" });
  });

  it("marks unavailable dependencies without inventing healthy status", async () => {
    const service = new AdminDashboardService(
      prisma(),
      {
        ping: async () => {
          throw new Error("redis down");
        },
        get: async () => null
      } as any,
      {
        assertReady: async () => {
          throw new Error("storage down");
        }
      }
    );

    const dashboard = await service.getDashboard("admin-user-id");

    expect(dashboard.health.redis).toBe("UNAVAILABLE");
    expect(dashboard.health.storage).toBe("UNAVAILABLE");
    expect(dashboard.health.telegramWorker).toBe("UNAVAILABLE");
  });
});
