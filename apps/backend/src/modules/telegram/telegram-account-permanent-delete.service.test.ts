import { describe, expect, it, vi } from "vitest";
import { TelegramAccountPermanentDeleteService } from "./telegram-account-permanent-delete.service";
import type { RequestUser } from "../auth/auth.types";

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

function createApp(state: {
  account: Record<string, unknown> | null;
  chats: Array<{ id: string; crmContactId: string | null }>;
  messages: Array<{ id: string; telegramAccountId: string; mediaStorageKey: string | null; thumbnailStorageKey: string | null }>;
  contacts: Array<{ id: string; workspaceId: string }>;
  otherChats: Array<{ crmContactId: string | null }>;
  deletions: Array<Record<string, unknown>>;
  developerApps: Array<{ id: string }>;
  audit: Array<Record<string, unknown>>;
  commands: Array<Record<string, unknown>>;
}) {
  const storageKeys = new Set<string>();
  return {
    prisma: {
      telegramAccountDeletion: {
        findUnique: async ({ where }: { where: { telegramAccountId: string } }) =>
          state.deletions.find((row) => row.telegramAccountId === where.telegramAccountId) ?? null,
        upsert: async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
          const existing = state.deletions.find((row) => row.telegramAccountId === create.telegramAccountId);
          if (existing) {
            Object.assign(existing, update);
            return existing;
          }
          const row = { id: "deletion-1", requestedAt: new Date("2026-08-03T00:00:00.000Z"), ...create };
          state.deletions.push(row);
          return row;
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = state.deletions.find((item) => item.id === where.id);
          if (!row) throw new Error("missing deletion");
          Object.assign(row, data);
          return row;
        }
      },
      telegramAccount: {
        findFirst: async ({ where }: { where: { id: string; workspaceId: string } }) => {
          if (!state.account) return null;
          if (state.account.id !== where.id || state.account.workspaceId !== where.workspaceId) return null;
          return state.account;
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          if (!state.account || state.account.id !== where.id) throw new Error("missing");
          Object.assign(state.account, data);
          return state.account;
        },
        delete: async ({ where }: { where: { id: string } }) => {
          if (!state.account || state.account.id !== where.id) throw new Error("missing");
          state.chats = [];
          state.messages = state.messages.filter((message) => message.telegramAccountId !== where.id);
          state.account = null;
          return { id: where.id };
        }
      },
      telegramChat: {
        findMany: async ({ where, select }: { where: { telegramAccountId?: string; crmContactId?: { in: string[] } }; select?: Record<string, boolean> }) => {
          if (where.telegramAccountId) {
            return state.chats.map((chat) => (select ? { id: chat.id, crmContactId: chat.crmContactId } : chat));
          }
          if (where.crmContactId?.in) {
            return state.otherChats.filter((chat) => chat.crmContactId && where.crmContactId!.in.includes(chat.crmContactId));
          }
          return [];
        }
      },
      telegramMessage: {
        count: async ({ where }: { where: { telegramAccountId?: string; OR?: unknown[] } }) => {
          if (where.telegramAccountId) {
            return state.messages.filter((message) => message.telegramAccountId === where.telegramAccountId).length;
          }
          return 0;
        },
        findMany: async () =>
          state.messages.map((message) => ({
            mediaStorageKey: message.mediaStorageKey,
            thumbnailStorageKey: message.thumbnailStorageKey
          }))
      },
      crmContact: {
        deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
          state.contacts = state.contacts.filter((contact) => !where.id.in.includes(contact.id));
          return { count: where.id.in.length };
        }
      },
      telegramOutboundCommand: {
        updateMany: async () => ({ count: 0 }),
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const command = { id: `cmd-${state.commands.length + 1}`, status: "SENT", ...data };
          state.commands.push(command);
          return command;
        },
        findUnique: async ({ where }: { where: { id: string } }) => state.commands.find((command) => command.id === where.id) ?? null
      },
      auditLog: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          state.audit.push(data);
        }
      },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
        telegramAccount: {
          delete: async ({ where }: { where: { id: string } }) => {
            if (!state.account || state.account.id !== where.id) throw new Error("missing");
            state.chats = [];
            state.messages = state.messages.filter((message) => message.telegramAccountId !== where.id);
            state.account = null;
            return { id: where.id };
          }
        },
        telegramChat: {
          findMany: async ({ where }: { where: { crmContactId: { in: string[] } } }) =>
            state.otherChats.filter((chat) => chat.crmContactId && where.crmContactId.in.includes(chat.crmContactId))
        },
        crmContact: {
          deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
            state.contacts = state.contacts.filter((contact) => !where.id.in.includes(contact.id));
            return { count: where.id.in.length };
          }
        }
      })
    },
    redis: {
      del: vi.fn(async () => 1),
      scan: vi.fn(async () => ["0", []]),
      publish: vi.fn(async () => 1)
    },
    storage: {
      listObjectKeys: async () => [...storageKeys],
      deleteObject: async (key: string) => {
        storageKeys.delete(key);
      }
    },
    queues: {
      telegramOutbound: {
        add: vi.fn(async () => undefined)
      }
    }
  } as any;
}

describe("TelegramAccountPermanentDeleteService", () => {
  it("allows Coadmin to permanently delete a disconnected account and keep shared contacts", async () => {
    const sharedContactId = "contact-shared";
    const orphanContactId = "contact-orphan";
    const state = {
      account: {
        id: "account-1",
        workspaceId: "workspace-1",
        developerAppId: "app-1",
        displayName: "Piccaso",
        telegramUsername: "Piccaso47",
        status: "DISCONNECTED",
        sessionEncrypted: null,
        phoneNumberEncrypted: null
      },
      chats: [
        { id: "chat-1", crmContactId: sharedContactId },
        { id: "chat-2", crmContactId: orphanContactId }
      ],
      messages: [
        { id: "m1", telegramAccountId: "account-1", mediaStorageKey: "workspaces/workspace-1/telegram/account-1/a/b/c.jpg", thumbnailStorageKey: null },
        { id: "m2", telegramAccountId: "account-1", mediaStorageKey: null, thumbnailStorageKey: null }
      ],
      contacts: [
        { id: sharedContactId, workspaceId: "workspace-1" },
        { id: orphanContactId, workspaceId: "workspace-1" }
      ],
      otherChats: [{ crmContactId: sharedContactId }],
      deletions: [] as Array<Record<string, unknown>>,
      developerApps: [{ id: "app-1" }],
      audit: [] as Array<Record<string, unknown>>,
      commands: [] as Array<Record<string, unknown>>
    };
    const app = createApp(state);
    const service = new TelegramAccountPermanentDeleteService(app);

    const result = await service.permanentDelete(coadmin, "account-1", { confirmation: "DELETE PICCASO47" });

    expect(result.outcome).toBe("COMPLETED");
    expect(result.conversationCount).toBe(2);
    expect(result.messageCount).toBe(2);
    expect(result.developerAppId).toBe("app-1");
    expect(state.account).toBeNull();
    expect(state.contacts.map((contact) => contact.id)).toEqual([sharedContactId]);
    expect(state.deletions[0]).toMatchObject({ stage: "COMPLETED", outcome: "COMPLETED" });
    expect(app.redis.publish).toHaveBeenCalled();
    expect(state.audit[0]).toMatchObject({ action: "telegram.account.permanent_delete" });
  });

  it("rejects Staff, wrong workspace, wrong confirmation, and connected accounts", async () => {
    const state = {
      account: {
        id: "account-1",
        workspaceId: "workspace-1",
        developerAppId: "app-1",
        displayName: "Piccaso",
        telegramUsername: "Piccaso47",
        status: "CONNECTED",
        sessionEncrypted: null,
        phoneNumberEncrypted: null
      },
      chats: [],
      messages: [],
      contacts: [],
      otherChats: [],
      deletions: [] as Array<Record<string, unknown>>,
      developerApps: [{ id: "app-1" }],
      audit: [] as Array<Record<string, unknown>>,
      commands: [] as Array<Record<string, unknown>>
    };
    const service = new TelegramAccountPermanentDeleteService(createApp(state));

    await expect(service.permanentDelete(staff, "account-1", { confirmation: "DELETE PICCASO47" })).rejects.toMatchObject({
      statusCode: 403
    });
    await expect(service.permanentDelete(otherCoadmin, "account-1", { confirmation: "DELETE PICCASO47" })).rejects.toMatchObject({
      statusCode: 404
    });

    state.account!.status = "DISCONNECTED";
    await expect(service.permanentDelete(coadmin, "account-1", { confirmation: "DELETE WRONG" })).rejects.toMatchObject({
      statusCode: 400,
      code: "TELEGRAM_ACCOUNT_DELETE_CONFIRMATION_MISMATCH"
    });

    state.account!.status = "CONNECTED";
    await expect(service.permanentDelete(coadmin, "account-1", { confirmation: "DELETE PICCASO47" })).rejects.toMatchObject({
      statusCode: 409,
      code: "TELEGRAM_ACCOUNT_MUST_DISCONNECT_FIRST"
    });
  });

  it("is idempotent after completion", async () => {
    const state = {
      account: null,
      chats: [],
      messages: [],
      contacts: [],
      otherChats: [],
      deletions: [
        {
          id: "deletion-1",
          telegramAccountId: "account-1",
          stage: "COMPLETED",
          outcome: "COMPLETED",
          safeDisplayName: "@Piccaso47",
          conversationCount: 3,
          messageCount: 10,
          mediaCount: 2
        }
      ],
      developerApps: [{ id: "app-1" }],
      audit: [] as Array<Record<string, unknown>>,
      commands: [] as Array<Record<string, unknown>>
    };
    const service = new TelegramAccountPermanentDeleteService(createApp(state));
    const result = await service.permanentDelete(coadmin, "account-1", { confirmation: "DELETE PICCASO47" });
    expect(result.outcome).toBe("ALREADY_DELETED");
    expect(result.conversationCount).toBe(3);
  });
});
