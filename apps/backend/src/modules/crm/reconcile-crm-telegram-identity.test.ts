import { describe, expect, it } from "vitest";
import { reconcileCrmTelegramIdentities } from "./reconcile-crm-telegram-identity";

const workspaceA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const workspaceB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const joeId = "77c60d43-209f-4e17-9c16-39a3091293f7";
const jonahId = "c4668eb3-08c9-422c-bab2-042e20c08ba0";
const serviceId = "567d65fa-b934-4703-a27b-e611926f94fa";

type ContactRow = {
  id: string;
  workspaceId: string;
  displayName: string;
  username: string | null;
  updatedAt: Date;
  chats: ChatRow[];
};

type ChatRow = {
  workspaceId: string;
  telegramChatId: string;
  chatType: string;
  title: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  isBot: boolean;
  isArchived: boolean;
  rawMetadataJson: Record<string, unknown>;
  updatedAt: Date;
};

function createReconcilePrisma(contacts: ContactRow[]) {
  const state = {
    contacts: contacts.map((row) => ({ ...row, chats: row.chats.map((chat) => ({ ...chat })) })),
    updates: 0
  };

  const prisma = {
    _state: state,
    crmContact: {
      findMany: async ({ where, take }: { where?: any; take?: number }) => {
        let rows = state.contacts.filter((contact) => {
          if (where?.workspaceId && contact.workspaceId !== where.workspaceId) return false;
          return matchesWeakIdentityWhere(contact, where?.OR);
        });
        rows = [...rows].sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
        if (typeof take === "number") rows = rows.slice(0, take);
        return rows.map((contact) => ({
          id: contact.id,
          workspaceId: contact.workspaceId,
          displayName: contact.displayName,
          username: contact.username,
          chats: contact.chats.filter((chat) => !chat.isArchived && !chat.isBot)
        }));
      },
      update: async ({
        where,
        data
      }: {
        where: { id: string };
        data: { displayName?: string; username?: string };
      }) => {
        const row = state.contacts.find((c) => c.id === where.id);
        if (!row) throw new Error("missing contact");
        Object.assign(row, data);
        state.updates += 1;
        return row;
      }
    }
  };
  return prisma as any;
}

function matchesWeakIdentityWhere(contact: ContactRow, or?: unknown[]): boolean {
  if (!or) return true;
  return or.some((clause) => {
    const row = clause as Record<string, any>;
    if (row.displayName?.startsWith === "Unknown") {
      return contact.displayName.toLowerCase().startsWith("unknown");
    }
    if (row.displayName?.startsWith === "Telegram user ") {
      return contact.displayName.toLowerCase().startsWith("telegram user ");
    }
    if (row.displayName === "") return contact.displayName === "";
    if (row.AND) {
      const usernameBlank = contact.username == null || contact.username === "";
      const hasTelegramUsername = contact.chats.some(
        (chat) => !chat.isArchived && !chat.isBot && Boolean(chat.username)
      );
      return usernameBlank && hasTelegramUsername;
    }
    return false;
  });
}

function joeChat(workspaceId = workspaceA): ChatRow {
  return {
    workspaceId,
    telegramChatId: "8771801870",
    chatType: "PRIVATE",
    title: "Joe Mashburn",
    username: "waylon_rivers85",
    firstName: "Joe",
    lastName: "Mashburn",
    isBot: false,
    isArchived: false,
    rawMetadataJson: {},
    updatedAt: new Date("2026-08-16T00:00:00.000Z")
  };
}

function jonahChat(workspaceId = workspaceA): ChatRow {
  return {
    workspaceId,
    telegramChatId: "1002",
    chatType: "PRIVATE",
    title: "Jonah Leal",
    username: "Jhood69",
    firstName: "Jonah",
    lastName: "Leal",
    isBot: false,
    isArchived: false,
    rawMetadataJson: {},
    updatedAt: new Date("2026-08-16T00:00:00.000Z")
  };
}

describe("reconcileCrmTelegramIdentities", () => {
  it("repairs existing Unknown CRM rows from persisted Telegram chats", async () => {
    const prisma = createReconcilePrisma([
      {
        id: joeId,
        workspaceId: workspaceA,
        displayName: "Unknown",
        username: null,
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
        chats: [joeChat()]
      },
      {
        id: jonahId,
        workspaceId: workspaceA,
        displayName: "Unknown",
        username: "",
        updatedAt: new Date("2026-08-02T00:00:00.000Z"),
        chats: [jonahChat()]
      }
    ]);

    const result = await reconcileCrmTelegramIdentities(prisma, { workspaceId: workspaceA, dryRun: false });
    expect(result).toMatchObject({ scanned: 2, eligible: 2, updated: 2, dryRun: false });
    expect(prisma._state.contacts.find((c: ContactRow) => c.id === joeId)).toMatchObject({
      displayName: "Joe Mashburn",
      username: "waylon_rivers85"
    });
    expect(prisma._state.contacts.find((c: ContactRow) => c.id === jonahId)).toMatchObject({
      displayName: "Jonah Leal",
      username: "Jhood69"
    });
  });

  it("is idempotent after values are already correct", async () => {
    const prisma = createReconcilePrisma([
      {
        id: joeId,
        workspaceId: workspaceA,
        displayName: "Joe Mashburn",
        username: "waylon_rivers85",
        updatedAt: new Date(),
        chats: [joeChat()]
      }
    ]);
    const first = await reconcileCrmTelegramIdentities(prisma, { workspaceId: workspaceA, dryRun: false });
    const second = await reconcileCrmTelegramIdentities(prisma, { workspaceId: workspaceA, dryRun: false });
    expect(first.updated).toBe(0);
    expect(second.updated).toBe(0);
    expect(prisma._state.updates).toBe(0);
  });

  it("does not overwrite a legitimate CRM name", async () => {
    const prisma = createReconcilePrisma([
      {
        id: joeId,
        workspaceId: workspaceA,
        displayName: "Custom Player Name",
        username: null,
        updatedAt: new Date(),
        chats: [joeChat()]
      }
    ]);
    const result = await reconcileCrmTelegramIdentities(prisma, { workspaceId: workspaceA, dryRun: false });
    expect(result.updated).toBe(1);
    expect(prisma._state.contacts[0]).toMatchObject({
      displayName: "Custom Player Name",
      username: "waylon_rivers85"
    });
  });

  it("never downgrades when Telegram fields are blank", async () => {
    const prisma = createReconcilePrisma([
      {
        id: joeId,
        workspaceId: workspaceA,
        displayName: "Joe Mashburn",
        username: "waylon_rivers85",
        updatedAt: new Date(),
        chats: [
          {
            ...joeChat(),
            title: "",
            username: null,
            firstName: null,
            lastName: null
          }
        ]
      }
    ]);
    const result = await reconcileCrmTelegramIdentities(prisma, { workspaceId: workspaceA, dryRun: false });
    expect(result.updated).toBe(0);
    expect(prisma._state.contacts[0]?.displayName).toBe("Joe Mashburn");
  });

  it("excludes Telegram service account 777000", async () => {
    const prisma = createReconcilePrisma([
      {
        id: serviceId,
        workspaceId: workspaceA,
        displayName: "Unknown",
        username: null,
        updatedAt: new Date(),
        chats: [
          {
            workspaceId: workspaceA,
            telegramChatId: "777000",
            chatType: "PRIVATE",
            title: "Telegram",
            username: null,
            firstName: "Telegram",
            lastName: null,
            isBot: false,
            isArchived: false,
            rawMetadataJson: {},
            updatedAt: new Date()
          }
        ]
      }
    ]);
    const result = await reconcileCrmTelegramIdentities(prisma, { workspaceId: workspaceA, dryRun: false });
    expect(result.updated).toBe(0);
    expect(result.skippedService).toBe(1);
    expect(prisma._state.contacts[0]?.displayName).toBe("Unknown");
  });

  it("cannot use a workspace B chat to update a workspace A contact", async () => {
    const prisma = createReconcilePrisma([
      {
        id: joeId,
        workspaceId: workspaceA,
        displayName: "Unknown",
        username: null,
        updatedAt: new Date(),
        chats: [joeChat(workspaceB)]
      }
    ]);
    const result = await reconcileCrmTelegramIdentities(prisma, { workspaceId: workspaceA, dryRun: false });
    expect(result.updated).toBe(0);
    expect(result.skippedCrossWorkspace).toBe(1);
    expect(prisma._state.contacts[0]?.displayName).toBe("Unknown");
  });

  it("dry-run reports eligible rows without writing", async () => {
    const prisma = createReconcilePrisma([
      {
        id: joeId,
        workspaceId: workspaceA,
        displayName: "Unknown",
        username: null,
        updatedAt: new Date(),
        chats: [joeChat()]
      }
    ]);
    const result = await reconcileCrmTelegramIdentities(prisma, { workspaceId: workspaceA });
    expect(result).toMatchObject({ dryRun: true, eligible: 1, updated: 0 });
    expect(prisma._state.contacts[0]?.displayName).toBe("Unknown");
    expect(prisma._state.updates).toBe(0);
  });
});
