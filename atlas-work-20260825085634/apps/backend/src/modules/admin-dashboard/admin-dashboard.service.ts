import type { PrismaClient } from "@prisma/client";
import type Redis from "ioredis";
import type { AdminDashboardResponse, AdminHealthStatus } from "@atlas/shared";

interface StorageHealth {
  readonly assertReady: () => Promise<void>;
}

/**
 * Builds real Platform Admin dashboard data from Atlas infrastructure.
 */
export class AdminDashboardService {
  private readonly prisma: PrismaClient;
  private readonly redis: Redis;
  private readonly storage: StorageHealth;

  /**
   * Creates the Platform Admin dashboard service.
   */
  public constructor(prisma: PrismaClient, redis: Redis, storage: StorageHealth) {
    this.prisma = prisma;
    this.redis = redis;
    this.storage = storage;
  }

  /**
   * Loads counts, security summary, recent activity, and infrastructure health.
   */
  public async getDashboard(adminUserId: string): Promise<AdminDashboardResponse> {
    const admin = await this.prisma.platformAdmin.findUnique({ where: { userId: adminUserId } });
    const failedSince = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [
      coadmins,
      workspaces,
      staff,
      telegramAccounts,
      activeSessions,
      trustedDevices,
      recentFailedLogins,
      recentCoadmins,
      recentAuditEvents,
      health
    ] = await Promise.all([
      this.prisma.user.count({ where: { role: "COADMIN" } }),
      this.prisma.workspace.count(),
      this.prisma.user.count({ where: { role: "STAFF" } }),
      this.prisma.telegramAccount.count(),
      this.prisma.session.count({ where: { userId: adminUserId, revokedAt: null, expiresAt: { gt: new Date() } } }),
      admin ? this.prisma.adminTrustedDevice.count({ where: { adminId: admin.id, revokedAt: null, expiresAt: { gt: new Date() } } }) : 0,
      this.prisma.auditLog.count({ where: { actorId: adminUserId, action: "admin_auth.password_login.failed", createdAt: { gte: failedSince } } }),
      this.prisma.user.findMany({
        where: { role: "COADMIN" },
        include: { workspace: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: 5
      }),
      this.prisma.auditLog.findMany({
        where: { workspaceId: null },
        include: { actor: { select: { email: true } } },
        orderBy: { createdAt: "desc" },
        take: 8
      }),
      this.loadHealth()
    ]);

    return {
      counts: {
        coadmins,
        workspaces,
        staff,
        telegramAccounts,
        unclaimedConversations: null
      },
      security: {
        activeSessions,
        trustedDevices,
        lastLoginAt: admin?.lastLoginAt?.toISOString() ?? null,
        recentFailedLogins
      },
      health,
      recentCoadmins: recentCoadmins.map((coadmin) => ({
        id: coadmin.id,
        name: coadmin.name,
        email: coadmin.email ?? coadmin.username ?? coadmin.id,
        workspaceName: coadmin.workspace?.name ?? null,
        status: coadmin.status,
        createdAt: coadmin.createdAt.toISOString()
      })),
      recentAuditEvents: recentAuditEvents.map((event) => ({
        id: event.id,
        action: event.action,
        actorEmail: event.actor?.email ?? "system",
        createdAt: event.createdAt.toISOString(),
        ipAddress: event.ipAddress ?? null,
        status: this.auditStatus(event.action)
      }))
    };
  }

  private async loadHealth(): Promise<AdminDashboardResponse["health"]> {
    const [database, redis, storage, telegramWorker] = await Promise.all([
      this.check(async () => {
        await this.prisma.$queryRaw`SELECT 1`;
      }),
      this.check(async () => {
        await this.redis.ping();
      }),
      this.check(async () => {
        await this.storage.assertReady();
      }),
      this.checkTelegramWorker()
    ]);

    return {
      backend: "HEALTHY",
      database,
      redis,
      storage,
      telegramWorker
    };
  }

  private async check(operation: () => Promise<void>): Promise<AdminHealthStatus> {
    try {
      await operation();
      return "HEALTHY";
    } catch {
      return "UNAVAILABLE";
    }
  }

  private async checkTelegramWorker(): Promise<AdminHealthStatus> {
    try {
      const heartbeat = await this.redis.get("atlas:telegram-worker:heartbeat");
      if (!heartbeat) {
        return "UNAVAILABLE";
      }
      const parsed = JSON.parse(heartbeat) as { lastHeartbeatAt?: string };
      const lastHeartbeatAt = parsed.lastHeartbeatAt ? Date.parse(parsed.lastHeartbeatAt) : 0;
      return Date.now() - lastHeartbeatAt <= 45_000 ? "HEALTHY" : "DEGRADED";
    } catch {
      return "UNAVAILABLE";
    }
  }

  private auditStatus(action: string): string | null {
    if (action.includes("failed") || action.includes("incorrect") || action.includes("expired")) {
      return "Failed";
    }
    if (action.includes("success") || action.includes("created") || action.includes("sent") || action.includes("trusted")) {
      return "Success";
    }
    return null;
  }
}
