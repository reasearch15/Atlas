import { describe, expect, it } from "vitest";
import { AppError } from "../../utils/errors";
import type { RequestUser } from "../auth/auth.types";
import { AdminCoadminService } from "./admin-coadmin.service";

interface Row {
  id: string;
  [key: string]: unknown;
}

interface State {
  users: Row[];
  workspaces: Row[];
  sessions: Row[];
  trustedDevices: Row[];
  auditLogs: Row[];
}

const actor: RequestUser = {
  id: "platform-admin-user",
  email: "pokharelayush3@gmail.com",
  name: "Platform Admin",
  role: "PLATFORM_ADMIN",
  workspaceId: null,
  sessionId: "admin-session"
};

function createState(): State {
  return {
    users: [],
    workspaces: [],
    sessions: [],
    trustedDevices: [],
    auditLogs: []
  };
}

function createPrisma(state: State) {
  const userWithWorkspace = (user: Row) => ({
    ...user,
    workspace: state.workspaces.find((workspace) => workspace.id === user.workspaceId) ?? null
  });

  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { username?: string } }) => state.users.find((user) => user.username === where.username) ?? null,
      findFirst: async ({ where }: { where: { id?: string; role?: string } }) => {
        const user = state.users.find((row) => (!where.id || row.id === where.id) && (!where.role || row.role === where.role));
        return user ? userWithWorkspace(user) : null;
      },
      create: async ({ data }: { data: Row }) => {
        const user = { createdAt: new Date("2026-08-02T00:00:00.000Z"), ...data, id: `user-${state.users.length + 1}` };
        state.users.push(user);
        return user;
      },
      count: async () => 0
    },
    workspace: {
      findUnique: async ({ where }: { where: { slug: string } }) => state.workspaces.find((workspace) => workspace.slug === where.slug) ?? null,
      create: async ({ data }: { data: Row }) => {
        const workspace = { createdAt: new Date("2026-08-02T00:00:00.000Z"), ...data, id: `workspace-${state.workspaces.length + 1}` };
        state.workspaces.push(workspace);
        return workspace;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const workspace = state.workspaces.find((row) => row.id === where.id);
        if (!workspace) throw new Error("workspace missing");
        Object.assign(workspace, data);
        return workspace;
      }
    },
    session: {
      findMany: async ({ where }: { where: { userId: string } }) => state.sessions.filter((session) => session.userId === where.userId),
      findFirst: async ({ where }: { where: { userId: string; revokedAt: null } }) => state.sessions.find((session) => session.userId === where.userId && session.revokedAt === where.revokedAt) ?? null
    },
    userTrustedDevice: {
      count: async ({ where }: { where: { userId: string; revokedAt: null } }) => state.trustedDevices.filter((device) => device.userId === where.userId && device.revokedAt === where.revokedAt).length
    },
    telegramAccount: {
      count: async () => 0
    },
    developerApp: {
      count: async () => 0
    },
    auditLog: {
      create: async ({ data }: { data: Row }) => {
        state.auditLogs.push({ createdAt: new Date("2026-08-02T00:00:00.000Z"), ...data, id: `audit-${state.auditLogs.length + 1}` });
      },
      findMany: async ({ where }: { where: { workspaceId: string } }) => state.auditLogs.filter((auditLog) => auditLog.workspaceId === where.workspaceId)
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(prisma)
  };

  return prisma as any;
}

describe("AdminCoadminService simplified creation", () => {
  it("creates a workspace automatically from username and forces first-login password change", async () => {
    const state = createState();
    const service = new AdminCoadminService(createPrisma(state));

    const result = await service.create(actor, {
      username: "acme_owner",
      temporaryPassword: "Temporary123!",
      confirmTemporaryPassword: "Temporary123!"
    });

    expect(result).toMatchObject({
      username: "acme_owner",
      name: "acme_owner",
      contactEmail: null,
      workspaceName: "acme_owner",
      workspaceSlug: "acme-owner",
      workspaceStatus: "ACTIVE",
      mustChangePassword: true,
      temporaryPassword: "Temporary123!"
    });
    expect(state.users[0]).toMatchObject({
      username: "acme_owner",
      email: null,
      name: "acme_owner",
      role: "COADMIN",
      status: "ACTIVE",
      mustChangePassword: true
    });
    expect(state.workspaces[0]).toMatchObject({
      name: "acme_owner",
      slug: "acme-owner",
      status: "ACTIVE",
      primaryCoadminId: "user-1"
    });
    expect(state.auditLogs.map((log) => log.action)).toEqual(["coadmin.created", "temporary_password.issued"]);
  });

  it("rejects duplicate usernames before creating another workspace", async () => {
    const state = createState();
    state.users.push({ id: "existing-user", username: "acme", role: "COADMIN" });
    const service = new AdminCoadminService(createPrisma(state));

    await expect(
      service.create(actor, {
        username: "acme",
        temporaryPassword: "Temporary123!",
        confirmTemporaryPassword: "Temporary123!"
      })
    ).rejects.toMatchObject({ code: "USERNAME_ALREADY_EXISTS" } satisfies Partial<AppError>);
    expect(state.workspaces).toHaveLength(0);
  });

  it("allocates a backend-only slug when the generated slug already exists", async () => {
    const state = createState();
    state.workspaces.push({ id: "existing-workspace", name: "Existing", slug: "acme-team", status: "ACTIVE" });
    const service = new AdminCoadminService(createPrisma(state));

    const result = await service.create(actor, {
      username: "acme.team",
      temporaryPassword: "Temporary123!",
      confirmTemporaryPassword: "Temporary123!"
    });

    expect(result.workspaceSlug).toBe("acme-team-2");
    expect(state.workspaces.at(-1)).toMatchObject({ name: "acme.team", slug: "acme-team-2" });
  });
});
