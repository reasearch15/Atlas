import type { Prisma, PrismaClient } from "@prisma/client";

export const fixtureWorkspaceIdentities = [
  { fixtureKey: "dev.workspace.acme", slug: "acme", name: "Acme Operations" },
  { fixtureKey: "dev.workspace.globex", slug: "globex", name: "Globex Support" }
] as const;

export const fixtureUserIdentities = [
  { fixtureKey: "dev.user.acme-coadmin", email: "coadmin@acme.local", name: "Acme Coadmin" },
  { fixtureKey: "dev.user.acme-staff", email: "staff@acme.local", name: "Acme Staff" },
  { fixtureKey: "dev.user.globex-coadmin", email: "coadmin@globex.local", name: "Globex Coadmin" }
] as const;

export interface FixtureRecordSummary {
  readonly id: string;
  readonly label: string;
}

export interface FixtureCleanupPlan {
  readonly workspaces: readonly FixtureRecordSummary[];
  readonly users: readonly FixtureRecordSummary[];
  readonly sessions: readonly FixtureRecordSummary[];
  readonly auditLogs: readonly FixtureRecordSummary[];
  readonly developerApps: readonly FixtureRecordSummary[];
  readonly telegramAccounts: readonly FixtureRecordSummary[];
  readonly telegramChats: readonly FixtureRecordSummary[];
  readonly telegramMessages: readonly FixtureRecordSummary[];
  readonly telegramOutboundCommands: readonly FixtureRecordSummary[];
}

export interface FixtureCleanupResult {
  readonly plan: FixtureCleanupPlan;
  readonly deleted: Record<keyof FixtureCleanupPlan, number>;
}

type FixturePrismaClient = Pick<
  PrismaClient,
  | "workspace"
  | "user"
  | "session"
  | "auditLog"
  | "developerApp"
  | "telegramAccount"
  | "telegramChat"
  | "telegramMessage"
  | "telegramOutboundCommand"
  | "platformAdmin"
  | "$transaction"
>;

type FixtureTransaction = Omit<FixturePrismaClient, "$transaction">;

/**
 * Refuses fixture cleanup in production.
 */
export function assertFixtureCleanupAllowed(nodeEnv: string | undefined): void {
  if (nodeEnv === "production") {
    throw new Error("fixtures:clean is disabled when NODE_ENV=production.");
  }
}

/**
 * Builds a dry-run plan of every row positively identified as development fixture data.
 */
export async function loadFixtureCleanupPlan(prisma: FixturePrismaClient): Promise<FixtureCleanupPlan> {
  const loaded = await loadFixtureRows(prisma);
  return toPlan(loaded);
}

/**
 * Deletes all identified development fixture rows in foreign-key-safe order.
 */
export async function cleanDevelopmentFixtures(prisma: FixturePrismaClient): Promise<FixtureCleanupResult> {
  return prisma.$transaction(async (tx) => {
    const loaded = await loadFixtureRows(tx);
    const plan = toPlan(loaded);

    const deleted = {
      telegramOutboundCommands: await deleteMany(tx.telegramOutboundCommand, loaded.telegramOutboundCommands.map((record) => record.id)),
      telegramMessages: await deleteMany(tx.telegramMessage, loaded.telegramMessages.map((record) => record.id)),
      telegramChats: await deleteMany(tx.telegramChat, loaded.telegramChats.map((record) => record.id)),
      telegramAccounts: await deleteMany(tx.telegramAccount, loaded.telegramAccounts.map((record) => record.id)),
      developerApps: await deleteMany(tx.developerApp, loaded.developerApps.map((record) => record.id)),
      sessions: await deleteMany(tx.session, loaded.sessions.map((record) => record.id)),
      auditLogs: await deleteMany(tx.auditLog, loaded.auditLogs.map((record) => record.id)),
      users: await deleteMany(tx.user, loaded.users.map((record) => record.id)),
      workspaces: await deleteMany(tx.workspace, loaded.workspaces.map((record) => record.id))
    };

    return { plan, deleted };
  });
}

interface LoadedFixtureRows {
  readonly workspaces: Array<{ id: string; slug: string; name: string }>;
  readonly users: Array<{ id: string; email: string | null; name: string; role: string }>;
  readonly sessions: Array<{ id: string; userId: string; workspaceId: string | null; deviceName: string }>;
  readonly auditLogs: Array<{ id: string; action: string; actorId: string | null; workspaceId: string | null }>;
  readonly developerApps: Array<{ id: string; displayName: string; workspaceId: string; createdByUserId: string }>;
  readonly telegramAccounts: Array<{ id: string; displayName: string; workspaceId: string; developerAppId: string; createdByUserId: string }>;
  readonly telegramChats: Array<{ id: string; title: string; workspaceId: string; telegramAccountId: string }>;
  readonly telegramMessages: Array<{ id: string; telegramMessageId: string; workspaceId: string; telegramAccountId: string }>;
  readonly telegramOutboundCommands: Array<{ id: string; operation: string; workspaceId: string; telegramAccountId: string }>;
}

async function loadFixtureRows(prisma: FixtureTransaction): Promise<LoadedFixtureRows> {
  const workspaces = await prisma.workspace.findMany({
    where: {
      OR: [
        { isDevelopmentFixture: true },
        ...fixtureWorkspaceIdentities.map((fixture) => ({ slug: fixture.slug, name: fixture.name }))
      ]
    },
    select: { id: true, slug: true, name: true }
  });
  const workspaceIds = workspaces.map((workspace) => workspace.id);

  const users = await prisma.user.findMany({
    where: {
      OR: [{ isDevelopmentFixture: true }, { email: { in: fixtureUserIdentities.map((fixture) => fixture.email) } }]
    },
    select: { id: true, email: true, name: true, role: true }
  });
  const userIds = users.map((user) => user.id);
  await assertNoPlatformAdminUserWillBeDeleted(prisma, userIds);

  const developerApps = await prisma.developerApp.findMany({
    where: {
      OR: [{ isDevelopmentFixture: true }, { workspaceId: { in: workspaceIds } }, { createdByUserId: { in: userIds } }]
    },
    select: { id: true, displayName: true, workspaceId: true, createdByUserId: true }
  });
  const developerAppIds = developerApps.map((app) => app.id);

  const telegramAccounts = await prisma.telegramAccount.findMany({
    where: {
      OR: [
        { isDevelopmentFixture: true },
        { workspaceId: { in: workspaceIds } },
        { developerAppId: { in: developerAppIds } },
        { createdByUserId: { in: userIds } }
      ]
    },
    select: { id: true, displayName: true, workspaceId: true, developerAppId: true, createdByUserId: true }
  });
  const telegramAccountIds = telegramAccounts.map((account) => account.id);

  const telegramChats = await prisma.telegramChat.findMany({
    where: {
      OR: [{ isDevelopmentFixture: true }, { workspaceId: { in: workspaceIds } }, { telegramAccountId: { in: telegramAccountIds } }]
    },
    select: { id: true, title: true, workspaceId: true, telegramAccountId: true }
  });
  const telegramChatIds = telegramChats.map((chat) => chat.id);

  const telegramMessages = await prisma.telegramMessage.findMany({
    where: {
      OR: [
        { isDevelopmentFixture: true },
        { workspaceId: { in: workspaceIds } },
        { telegramAccountId: { in: telegramAccountIds } },
        { telegramChatDbId: { in: telegramChatIds } },
        { internalSenderUserId: { in: userIds } }
      ]
    },
    select: { id: true, telegramMessageId: true, workspaceId: true, telegramAccountId: true }
  });

  const telegramOutboundCommands = await prisma.telegramOutboundCommand.findMany({
    where: {
      OR: [
        { isDevelopmentFixture: true },
        { workspaceId: { in: workspaceIds } },
        { telegramAccountId: { in: telegramAccountIds } },
        { telegramChatDbId: { in: telegramChatIds } },
        { requestedByUserId: { in: userIds } }
      ]
    },
    select: { id: true, operation: true, workspaceId: true, telegramAccountId: true }
  });

  const sessions = await prisma.session.findMany({
    where: {
      OR: [{ isDevelopmentFixture: true }, { userId: { in: userIds } }, { workspaceId: { in: workspaceIds } }]
    },
    select: { id: true, userId: true, workspaceId: true, deviceName: true }
  });

  const auditLogs = await prisma.auditLog.findMany({
    where: {
      OR: [{ isDevelopmentFixture: true }, { actorId: { in: userIds } }, { workspaceId: { in: workspaceIds } }]
    },
    select: { id: true, action: true, actorId: true, workspaceId: true }
  });

  return {
    workspaces,
    users,
    sessions,
    auditLogs,
    developerApps,
    telegramAccounts,
    telegramChats,
    telegramMessages,
    telegramOutboundCommands
  };
}

async function assertNoPlatformAdminUserWillBeDeleted(prisma: FixtureTransaction, userIds: readonly string[]): Promise<void> {
  if (userIds.length === 0) return;
  const platformAdminUserCount = await prisma.platformAdmin.count({ where: { userId: { in: [...userIds] } } });
  if (platformAdminUserCount > 0) {
    throw new Error("Fixture cleanup refused to delete a Platform Admin user.");
  }
}

function toPlan(loaded: LoadedFixtureRows): FixtureCleanupPlan {
  return {
    workspaces: loaded.workspaces.map((record) => ({ id: record.id, label: `${record.slug} (${record.name})` })),
    users: loaded.users.map((record) => ({ id: record.id, label: `${record.email ?? record.name} (${record.role})` })),
    sessions: loaded.sessions.map((record) => ({ id: record.id, label: `${record.deviceName} for user ${record.userId}` })),
    auditLogs: loaded.auditLogs.map((record) => ({ id: record.id, label: `${record.action}` })),
    developerApps: loaded.developerApps.map((record) => ({ id: record.id, label: `${record.displayName}` })),
    telegramAccounts: loaded.telegramAccounts.map((record) => ({ id: record.id, label: `${record.displayName}` })),
    telegramChats: loaded.telegramChats.map((record) => ({ id: record.id, label: `${record.title}` })),
    telegramMessages: loaded.telegramMessages.map((record) => ({ id: record.id, label: `${record.telegramMessageId}` })),
    telegramOutboundCommands: loaded.telegramOutboundCommands.map((record) => ({ id: record.id, label: `${record.operation}` }))
  };
}

async function deleteMany(delegate: { deleteMany(args: { where: { id: { in: string[] } } }): Promise<Prisma.BatchPayload> }, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await delegate.deleteMany({ where: { id: { in: ids } } });
  return result.count;
}
