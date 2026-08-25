import { describe, expect, it, vi } from "vitest";
import { seedDatabase } from "../../prisma/seed";
import { assertFixtureCleanupAllowed, cleanDevelopmentFixtures, loadFixtureCleanupPlan } from "./fixtures-clean.service";

interface Row {
  id: string;
  [key: string]: unknown;
}

interface FixtureState {
  workspaces: Row[];
  users: Row[];
  sessions: Row[];
  auditLogs: Row[];
  developerApps: Row[];
  telegramAccounts: Row[];
  telegramChats: Row[];
  telegramMessages: Row[];
  telegramOutboundCommands: Row[];
  platformAdmins: Row[];
}

function createState(): FixtureState {
  return {
    workspaces: [
      { id: "workspace-acme", slug: "acme", name: "Acme Operations", isDevelopmentFixture: false },
      { id: "workspace-real", slug: "real", name: "Real Workspace", isDevelopmentFixture: false }
    ],
    users: [
      { id: "admin-user", email: "pokharelayush3@gmail.com", name: "Platform Admin", role: "PLATFORM_ADMIN", isDevelopmentFixture: false },
      { id: "fixture-coadmin", email: "coadmin@acme.local", name: "Acme Coadmin", role: "COADMIN", isDevelopmentFixture: false },
      { id: "real-user", email: "owner@example.com", name: "Real User", role: "COADMIN", isDevelopmentFixture: false }
    ],
    sessions: [
      { id: "fixture-session", userId: "fixture-coadmin", workspaceId: "workspace-acme", deviceName: "node", isDevelopmentFixture: false },
      { id: "real-session", userId: "real-user", workspaceId: "workspace-real", deviceName: "Chrome", isDevelopmentFixture: false }
    ],
    auditLogs: [
      { id: "fixture-audit", actorId: "fixture-coadmin", workspaceId: "workspace-acme", action: "auth.login", isDevelopmentFixture: false },
      { id: "real-audit", actorId: "admin-user", workspaceId: null, action: "admin_auth.bootstrap.created", isDevelopmentFixture: false }
    ],
    developerApps: [
      { id: "fixture-app", workspaceId: "workspace-acme", createdByUserId: "fixture-coadmin", displayName: "Fixture App", isDevelopmentFixture: false },
      { id: "real-app", workspaceId: "workspace-real", createdByUserId: "real-user", displayName: "Real App", isDevelopmentFixture: false }
    ],
    telegramAccounts: [
      {
        id: "fixture-account",
        workspaceId: "workspace-acme",
        developerAppId: "fixture-app",
        createdByUserId: "fixture-coadmin",
        displayName: "Fixture Telegram",
        isDevelopmentFixture: false
      },
      {
        id: "real-account",
        workspaceId: "workspace-real",
        developerAppId: "real-app",
        createdByUserId: "real-user",
        displayName: "Real Telegram",
        isDevelopmentFixture: false
      }
    ],
    telegramChats: [
      { id: "fixture-chat", workspaceId: "workspace-acme", telegramAccountId: "fixture-account", title: "Fixture Chat", isDevelopmentFixture: false },
      { id: "real-chat", workspaceId: "workspace-real", telegramAccountId: "real-account", title: "Real Chat", isDevelopmentFixture: false }
    ],
    telegramMessages: [
      {
        id: "fixture-message",
        workspaceId: "workspace-acme",
        telegramAccountId: "fixture-account",
        telegramChatDbId: "fixture-chat",
        telegramMessageId: "100",
        internalSenderUserId: "fixture-coadmin",
        isDevelopmentFixture: false
      },
      {
        id: "real-message",
        workspaceId: "workspace-real",
        telegramAccountId: "real-account",
        telegramChatDbId: "real-chat",
        telegramMessageId: "200",
        internalSenderUserId: "real-user",
        isDevelopmentFixture: false
      }
    ],
    telegramOutboundCommands: [
      {
        id: "fixture-command",
        workspaceId: "workspace-acme",
        telegramAccountId: "fixture-account",
        telegramChatDbId: "fixture-chat",
        requestedByUserId: "fixture-coadmin",
        operation: "SEND_TEXT_MESSAGE",
        isDevelopmentFixture: false
      },
      {
        id: "real-command",
        workspaceId: "workspace-real",
        telegramAccountId: "real-account",
        telegramChatDbId: "real-chat",
        requestedByUserId: "real-user",
        operation: "SEND_TEXT_MESSAGE",
        isDevelopmentFixture: false
      }
    ],
    platformAdmins: [{ id: "admin", userId: "admin-user", email: "pokharelayush3@gmail.com" }]
  };
}

function createPrisma(state: FixtureState) {
  const delegate = (collection: keyof FixtureState, predicate: (row: Row) => boolean) => ({
    findMany: async () => state[collection].filter(predicate),
    deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
      const ids = new Set(where.id.in);
      const before = state[collection].length;
      state[collection] = state[collection].filter((row) => !ids.has(row.id));
      return { count: before - state[collection].length };
    }
  });

  const workspaceFixtureIds = () =>
    new Set(state.workspaces.filter((row) => row.isDevelopmentFixture === true || (row.slug === "acme" && row.name === "Acme Operations") || (row.slug === "globex" && row.name === "Globex Support")).map((row) => row.id));
  const userFixtureIds = () =>
    new Set(state.users.filter((row) => row.isDevelopmentFixture === true || ["coadmin@acme.local", "staff@acme.local", "coadmin@globex.local"].includes(String(row.email))).map((row) => row.id));
  const developerAppFixtureIds = () => new Set(state.developerApps.filter((row) => row.isDevelopmentFixture === true || workspaceFixtureIds().has(String(row.workspaceId)) || userFixtureIds().has(String(row.createdByUserId))).map((row) => row.id));
  const telegramAccountFixtureIds = () =>
    new Set(
      state.telegramAccounts
        .filter(
          (row) =>
            row.isDevelopmentFixture === true ||
            workspaceFixtureIds().has(String(row.workspaceId)) ||
            developerAppFixtureIds().has(String(row.developerAppId)) ||
            userFixtureIds().has(String(row.createdByUserId))
        )
        .map((row) => row.id)
    );
  const telegramChatFixtureIds = () =>
    new Set(state.telegramChats.filter((row) => row.isDevelopmentFixture === true || workspaceFixtureIds().has(String(row.workspaceId)) || telegramAccountFixtureIds().has(String(row.telegramAccountId))).map((row) => row.id));

  return {
    workspace: delegate("workspaces", (row) => workspaceFixtureIds().has(row.id)),
    user: delegate("users", (row) => userFixtureIds().has(row.id)),
    session: delegate("sessions", (row) => row.isDevelopmentFixture === true || userFixtureIds().has(String(row.userId)) || workspaceFixtureIds().has(String(row.workspaceId))),
    auditLog: delegate("auditLogs", (row) => row.isDevelopmentFixture === true || userFixtureIds().has(String(row.actorId)) || workspaceFixtureIds().has(String(row.workspaceId))),
    developerApp: delegate("developerApps", (row) => developerAppFixtureIds().has(row.id)),
    telegramAccount: delegate("telegramAccounts", (row) => telegramAccountFixtureIds().has(row.id)),
    telegramChat: delegate("telegramChats", (row) => telegramChatFixtureIds().has(row.id)),
    telegramMessage: delegate(
      "telegramMessages",
      (row) =>
        row.isDevelopmentFixture === true ||
        workspaceFixtureIds().has(String(row.workspaceId)) ||
        telegramAccountFixtureIds().has(String(row.telegramAccountId)) ||
        telegramChatFixtureIds().has(String(row.telegramChatDbId)) ||
        userFixtureIds().has(String(row.internalSenderUserId))
    ),
    telegramOutboundCommand: delegate(
      "telegramOutboundCommands",
      (row) =>
        row.isDevelopmentFixture === true ||
        workspaceFixtureIds().has(String(row.workspaceId)) ||
        telegramAccountFixtureIds().has(String(row.telegramAccountId)) ||
        telegramChatFixtureIds().has(String(row.telegramChatDbId)) ||
        userFixtureIds().has(String(row.requestedByUserId))
    ),
    platformAdmin: {
      count: async ({ where }: { where: { userId: { in: string[] } } }) =>
        state.platformAdmins.filter((admin) => where.userId.in.includes(String(admin.userId))).length
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(createPrisma(state))
  } as any;
}

describe("development fixture cleanup", () => {
  it("removes fixture data and preserves the real Platform Admin and non-fixture rows", async () => {
    const state = createState();
    const result = await cleanDevelopmentFixtures(createPrisma(state));

    expect(result.deleted).toMatchObject({
      workspaces: 1,
      users: 1,
      sessions: 1,
      auditLogs: 1,
      developerApps: 1,
      telegramAccounts: 1
    });
    expect(state.users.map((row) => row.email)).toEqual(["pokharelayush3@gmail.com", "owner@example.com"]);
    expect(state.platformAdmins).toEqual([{ id: "admin", userId: "admin-user", email: "pokharelayush3@gmail.com" }]);
    expect(state.workspaces.map((row) => row.slug)).toEqual(["real"]);
    expect(state.telegramAccounts.map((row) => row.id)).toEqual(["real-account"]);
  });

  it("is idempotent", async () => {
    const state = createState();
    await cleanDevelopmentFixtures(createPrisma(state));
    const result = await cleanDevelopmentFixtures(createPrisma(state));

    expect(Object.values(result.deleted).every((count) => count === 0)).toBe(true);
    expect((await loadFixtureCleanupPlan(createPrisma(state))).workspaces).toHaveLength(0);
  });

  it("blocks production execution", () => {
    expect(() => assertFixtureCleanupAllowed("production")).toThrow("disabled");
    expect(() => assertFixtureCleanupAllowed("development")).not.toThrow();
  });

  it("refuses to delete a Platform Admin user even if marked as fixture", async () => {
    const state = createState();
    state.users[0]!.isDevelopmentFixture = true;

    await expect(cleanDevelopmentFixtures(createPrisma(state))).rejects.toThrow("Platform Admin");
  });

  it("does not seed fixture business data when ENABLE_DEV_FIXTURES is false", async () => {
    const workspace = { upsert: vi.fn() };
    const user = { upsert: vi.fn() };
    await seedDatabase({ workspace, user } as any, { NODE_ENV: "development", ENABLE_DEV_FIXTURES: "false" });

    expect(workspace.upsert).not.toHaveBeenCalled();
    expect(user.upsert).not.toHaveBeenCalled();
  });
});
