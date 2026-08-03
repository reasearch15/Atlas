import { describe, expect, it } from "vitest";
import { decryptSecret, type EncryptedSecret } from "@atlas/shared/session-encryption";
import type { RequestUser } from "../auth/auth.types";
import { DeveloperAppService } from "./developer-app.service";

const encryptionKey = "d".repeat(64);
const coadmin: RequestUser = {
  id: "coadmin-1",
  email: "coadmin",
  name: "Coadmin",
  role: "COADMIN",
  workspaceId: "workspace-1",
  sessionId: "session-1"
};
const staff: RequestUser = { ...coadmin, id: "staff-1", role: "STAFF" };
const otherCoadmin: RequestUser = { ...coadmin, id: "coadmin-2", workspaceId: "workspace-2" };

interface Row {
  id: string;
  [key: string]: unknown;
}

interface State {
  developerApps: Row[];
  telegramAccounts: Row[];
  auditLogs: Row[];
}

function createState(): State {
  return {
    developerApps: [],
    telegramAccounts: [],
    auditLogs: []
  };
}

function createService(state: State) {
  return new DeveloperAppService({
    server: {
      env: { TELEGRAM_SESSION_ENCRYPTION_KEY: encryptionKey },
      prisma: createPrisma(state)
    }
  } as any);
}

function withCount(state: State, app: Row) {
  return {
    ...app,
    _count: {
      telegramAccounts: state.telegramAccounts.filter(
        (account) => account.developerAppId === app.id && account.status !== "DISCONNECTED" && account.status !== "DELETING"
      ).length
    }
  };
}

function createPrisma(state: State) {
  return {
    developerApp: {
      findMany: async ({ where }: { where: { workspaceId?: string; deletedAt?: null } }) =>
        state.developerApps
          .filter((app) => (!where.workspaceId || app.workspaceId === where.workspaceId) && (where.deletedAt !== null || app.deletedAt === null))
          .map((app) => withCount(state, app)),
      findFirst: async ({ where, select }: { where: { id?: string | { not: string }; workspaceId?: string; deletedAt?: null; displayName?: { equals: string } }; select?: { id: true } }) => {
        const app = state.developerApps.find((candidate) => {
          if (where.id && typeof where.id === "string" && candidate.id !== where.id) return false;
          if (where.id && typeof where.id === "object" && candidate.id === where.id.not) return false;
          if (where.workspaceId && candidate.workspaceId !== where.workspaceId) return false;
          if (where.deletedAt === null && candidate.deletedAt !== null) return false;
          if (where.displayName && String(candidate.displayName).toLowerCase() !== where.displayName.equals.toLowerCase()) return false;
          return true;
        });
        if (!app) return null;
        return select?.id ? { id: app.id } : withCount(state, app);
      },
      create: async ({ data }: { data: Row }) => {
        const now = new Date("2026-08-02T00:00:00.000Z");
        const app = { createdAt: now, updatedAt: now, deletedAt: null, status: "ACTIVE", ...data, id: `app-${state.developerApps.length + 1}` };
        state.developerApps.push(app);
        return withCount(state, app);
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        const app = state.developerApps.find((candidate) => candidate.id === where.id);
        if (!app) throw new Error("missing app");
        Object.assign(app, data, { updatedAt: new Date("2026-08-02T01:00:00.000Z") });
        return withCount(state, app);
      }
    },
    auditLog: {
      create: async ({ data }: { data: Row }) => {
        state.auditLogs.push({ ...data, id: `audit-${state.auditLogs.length + 1}` });
      }
    }
  } as any;
}

describe("DeveloperAppService", () => {
  it("allows a Coadmin to create a Developer App with encrypted API hash and no secret in the response", async () => {
    const state = createState();
    const result = await createService(state).create(coadmin, {
      provider: "TELEGRAM",
      displayName: "Primary Telegram App",
      apiId: 12345,
      apiHash: "a".repeat(32)
    });

    expect(result).toMatchObject({
      workspaceId: "workspace-1",
      provider: "TELEGRAM",
      displayName: "Primary Telegram App",
      apiId: 12345,
      status: "ACTIVE",
      connectedTelegramAccountCount: 0
    });
    expect(JSON.stringify(result)).not.toContain("apiHash");
    expect(JSON.stringify(result)).not.toContain("ciphertext");
    expect(decryptSecret(state.developerApps[0]!.encryptedApiHash as EncryptedSecret, encryptionKey)).toBe("a".repeat(32));
    expect(state.auditLogs[0]).toMatchObject({ action: "developer_app.create", workspaceId: "workspace-1" });
    expect(JSON.stringify(state.auditLogs)).not.toContain("a".repeat(32));
  });

  it("rejects Staff and explicit workspace override", async () => {
    const service = createService(createState());

    await expect(service.list(staff)).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      service.create(coadmin, { provider: "TELEGRAM", displayName: "App", apiId: 1, apiHash: "b".repeat(32) }, "workspace-2")
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("denies cross-workspace access", async () => {
    const state = createState();
    const service = createService(state);
    const app = await service.create(coadmin, { provider: "TELEGRAM", displayName: "App", apiId: 1, apiHash: "c".repeat(32) });

    await expect(service.get(otherCoadmin, app.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.update(otherCoadmin, app.id, { displayName: "Other" })).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects duplicate display names, invalid API IDs, and invalid providers", async () => {
    const state = createState();
    const service = createService(state);
    await service.create(coadmin, { provider: "TELEGRAM", displayName: "Duplicate", apiId: 1, apiHash: "d".repeat(32) });

    await expect(service.create(coadmin, { provider: "TELEGRAM", displayName: "duplicate", apiId: 2, apiHash: "e".repeat(32) })).rejects.toMatchObject({
      statusCode: 409,
      code: "DEVELOPER_APP_DISPLAY_NAME_EXISTS"
    });
    await expect(service.create(coadmin, { provider: "TELEGRAM", displayName: "Bad ID", apiId: -1, apiHash: "f".repeat(32) })).rejects.toThrow();
    await expect(service.create(coadmin, { provider: "POSTMARK", displayName: "Bad Provider", apiId: 1, apiHash: "1".repeat(32) })).rejects.toThrow();
  });

  it("preserves the encrypted secret when edit omits API hash and rotates it when provided", async () => {
    const state = createState();
    const service = createService(state);
    const app = await service.create(coadmin, { provider: "TELEGRAM", displayName: "Rotating", apiId: 1, apiHash: "1".repeat(32) });
    const originalSecret = state.developerApps[0]!.encryptedApiHash;

    await service.update(coadmin, app.id, { displayName: "Renamed", apiId: 2 });
    expect(state.developerApps[0]!.encryptedApiHash).toBe(originalSecret);

    await service.update(coadmin, app.id, { apiHash: "2".repeat(32) });
    expect(state.developerApps[0]!.encryptedApiHash).not.toBe(originalSecret);
    expect(decryptSecret(state.developerApps[0]!.encryptedApiHash as EncryptedSecret, encryptionKey)).toBe("2".repeat(32));
    expect(state.auditLogs.map((log) => log.action)).toContain("developer_app.credentials_rotated");
  });

  it("soft deletes unused apps, excludes them from lists, and blocks deleting apps with Telegram accounts", async () => {
    const state = createState();
    const service = createService(state);
    const unused = await service.create(coadmin, { provider: "TELEGRAM", displayName: "Unused", apiId: 1, apiHash: "3".repeat(32) });
    const used = await service.create(coadmin, { provider: "TELEGRAM", displayName: "Used", apiId: 2, apiHash: "4".repeat(32) });
    state.telegramAccounts.push({ id: "account-1", developerAppId: used.id, workspaceId: "workspace-1", status: "CONNECTED" });

    await expect(service.remove(coadmin, used.id)).rejects.toMatchObject({ statusCode: 409, code: "DEVELOPER_APP_HAS_TELEGRAM_ACCOUNTS" });
    await service.remove(coadmin, unused.id);

    expect(state.developerApps.find((app) => app.id === unused.id)).toMatchObject({ status: "DISABLED" });
    expect(state.developerApps.find((app) => app.id === unused.id)?.deletedAt).toBeInstanceOf(Date);
    expect((await service.list(coadmin)).map((app) => app.id)).toEqual([used.id]);
    expect(state.auditLogs.map((log) => log.action)).toContain("developer_app.delete_blocked");
    expect(state.auditLogs.map((log) => log.action)).toContain("developer_app.delete");
  });

  it("allows soft delete after Telegram accounts are disconnected without cascade-deleting account history", async () => {
    const state = createState();
    const service = createService(state);
    const used = await service.create(coadmin, { provider: "TELEGRAM", displayName: "Used", apiId: 2, apiHash: "4".repeat(32) });
    state.telegramAccounts.push({
      id: "account-1",
      developerAppId: used.id,
      workspaceId: "workspace-1",
      status: "DISCONNECTED"
    });

    expect((await service.get(coadmin, used.id)).connectedTelegramAccountCount).toBe(0);
    await service.remove(coadmin, used.id);

    expect(state.developerApps.find((app) => app.id === used.id)?.deletedAt).toBeInstanceOf(Date);
    expect(state.telegramAccounts).toHaveLength(1);
    expect(state.telegramAccounts[0]).toMatchObject({ id: "account-1", developerAppId: used.id, status: "DISCONNECTED" });
  });

  it("enables and disables apps", async () => {
    const state = createState();
    const service = createService(state);
    const app = await service.create(coadmin, { provider: "TELEGRAM", displayName: "Toggle", apiId: 1, apiHash: "5".repeat(32) });

    expect((await service.disable(coadmin, app.id)).status).toBe("DISABLED");
    expect((await service.enable(coadmin, app.id)).status).toBe("ACTIVE");
    expect(state.auditLogs.map((log) => log.action)).toEqual(["developer_app.create", "developer_app.disabled", "developer_app.enabled"]);
  });
});
