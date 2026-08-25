import type { PrismaClient } from "@prisma/client";

type OrphanCleanupPrismaClient = Pick<
  PrismaClient,
  "user" | "platformAdmin" | "session" | "userTrustedDevice" | "auditLog" | "$transaction"
>;

export interface OrphanPlatformAdminUser {
  readonly id: string;
  readonly email: string | null;
  readonly status: string;
  readonly createdAt: Date;
  readonly sessionCount: number;
  readonly activeSessionCount: number;
  readonly trustedDeviceCount: number;
  readonly auditLogCount: number;
}

export interface OrphanAdminCleanupPlan {
  readonly platformAdminCount: number;
  readonly platformAdminEmail: string | null;
  readonly orphanUsers: readonly OrphanPlatformAdminUser[];
}

/**
 * Ensures the orphan cleanup command remains a local administrative operation.
 */
export function assertOrphanPlatformAdminCleanupAllowed(nodeEnv: string): void {
  if (nodeEnv === "production") {
    throw new Error("Refusing to clean orphan Platform Admin users in production.");
  }
}

/**
 * Finds Platform Admin users that are not represented by the canonical platform_admins table.
 */
export async function inspectOrphanPlatformAdminUsers(prisma: OrphanCleanupPrismaClient): Promise<OrphanAdminCleanupPlan> {
  const [platformAdmins, orphanUsers] = await Promise.all([
    prisma.platformAdmin.findMany({ select: { email: true } }),
    prisma.user.findMany({
      where: { role: "PLATFORM_ADMIN", platformAdmin: null },
      select: {
        id: true,
        email: true,
        status: true,
        createdAt: true,
        workspaceId: true,
        isDevelopmentFixture: true,
        fixtureKey: true,
        ownedWorkspace: { select: { id: true } },
        createdDeveloperApps: { select: { id: true } },
        createdTelegramAccounts: { select: { id: true } },
        sessions: { select: { id: true, revokedAt: true, expiresAt: true } },
        trustedDevices: { select: { id: true } },
        auditLogs: { select: { id: true } }
      },
      orderBy: { createdAt: "asc" }
    })
  ]);

  const safeOrphans = orphanUsers.map((user) => {
    if (user.workspaceId || user.ownedWorkspace || user.createdDeveloperApps.length > 0 || user.createdTelegramAccounts.length > 0) {
      throw new Error(`Orphan Platform Admin user ${user.email ?? user.id} owns business data. Manual review is required.`);
    }
    return {
      id: user.id,
      email: user.email,
      status: user.status,
      createdAt: user.createdAt,
      sessionCount: user.sessions.length,
      activeSessionCount: user.sessions.filter((session) => !session.revokedAt && session.expiresAt > new Date()).length,
      trustedDeviceCount: user.trustedDevices.length,
      auditLogCount: user.auditLogs.length
    };
  });

  return {
    platformAdminCount: platformAdmins.length,
    platformAdminEmail: platformAdmins[0]?.email ?? null,
    orphanUsers: safeOrphans
  };
}

/**
 * Removes orphan Platform Admin users after preserving their audit history through nullable actor references.
 */
export async function cleanOrphanPlatformAdminUsers(prisma: OrphanCleanupPrismaClient): Promise<OrphanAdminCleanupPlan> {
  const plan = await inspectOrphanPlatformAdminUsers(prisma);
  if (plan.platformAdminCount !== 1) {
    throw new Error("Cleanup requires exactly one canonical Platform Admin.");
  }
  if (plan.orphanUsers.length === 0) {
    return plan;
  }

  const orphanIds = plan.orphanUsers.map((user) => user.id);
  await prisma.$transaction(async (tx) => {
    await tx.session.deleteMany({ where: { userId: { in: orphanIds } } });
    await tx.userTrustedDevice.deleteMany({ where: { userId: { in: orphanIds } } });
    await tx.user.deleteMany({ where: { id: { in: orphanIds }, role: "PLATFORM_ADMIN", platformAdmin: null } });
    await tx.auditLog.create({
      data: {
        workspaceId: null,
        actorId: null,
        action: "admin_auth.orphan_platform_admin_users.cleaned",
        metadata: { removedUserIds: orphanIds, removedEmails: plan.orphanUsers.map((user) => user.email) }
      }
    });
  });

  return plan;
}

/**
 * Fails fast if a users.role=PLATFORM_ADMIN row is not linked to platform_admins.
 */
export async function assertNoOrphanPlatformAdminUsers(prisma: Pick<PrismaClient, "user">): Promise<void> {
  const orphan = await prisma.user.findFirst({
    where: { role: "PLATFORM_ADMIN", platformAdmin: null },
    select: { email: true, id: true }
  });
  if (orphan) {
    throw new Error(`Orphan Platform Admin user detected: ${orphan.email ?? orphan.id}. Run pnpm admin:cleanup-orphans locally.`);
  }
}
