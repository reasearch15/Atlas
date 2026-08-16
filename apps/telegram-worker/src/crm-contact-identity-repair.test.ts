import { describe, expect, it } from "vitest";
import { healLinkedCrmContactIdentityFromChat } from "./crm-contact-identity-repair";

const workspaceA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const workspaceB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const joeContactId = "77c60d43-209f-4e17-9c16-39a3091293f7";
const serviceContactId = "567d65fa-b934-4703-a27b-e611926f94fa";

function createRepairPrisma(contacts: Array<{
  id: string;
  workspaceId: string;
  displayName: string;
  username: string | null;
}>) {
  const state = {
    contacts: contacts.map((row) => ({ ...row })),
    updates: 0
  };
  const prisma = {
    _state: state,
    crmContact: {
      findFirst: async ({ where }: { where: { id: string; workspaceId: string } }) =>
        state.contacts.find((c) => c.id === where.id && c.workspaceId === where.workspaceId) ?? null,
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
  return prisma;
}

function joeChat(partial: { crmContactId?: string | null; workspaceId?: string } = {}) {
  return {
    workspaceId: partial.workspaceId ?? workspaceA,
    telegramChatId: "8771801870",
    chatType: "PRIVATE" as const,
    title: "Joe Mashburn",
    username: "waylon_rivers85",
    firstName: "Joe",
    lastName: "Mashburn",
    isBot: false,
    isArchived: false,
    crmContactId: partial.crmContactId === undefined ? joeContactId : partial.crmContactId
  };
}

describe("healLinkedCrmContactIdentityFromChat", () => {
  it("repairs Unknown + blank username from persisted Telegram fields", async () => {
    const prisma = createRepairPrisma([
      { id: joeContactId, workspaceId: workspaceA, displayName: "Unknown", username: null }
    ]);

    const first = await healLinkedCrmContactIdentityFromChat(prisma, joeChat());
    expect(first).toBe(true);
    expect(prisma._state.contacts[0]).toMatchObject({
      displayName: "Joe Mashburn",
      username: "waylon_rivers85"
    });
    expect(prisma._state.updates).toBe(1);

    const second = await healLinkedCrmContactIdentityFromChat(prisma, joeChat());
    expect(second).toBe(false);
    expect(prisma._state.updates).toBe(1);
  });

  it("heals after a delayed Telegram identity arrival without staff action", async () => {
    const prisma = createRepairPrisma([
      { id: joeContactId, workspaceId: workspaceA, displayName: "Unknown User", username: null }
    ]);
    const emptyChat = {
      ...joeChat(),
      title: "Telegram user 8771801870",
      username: null,
      firstName: null,
      lastName: null
    };

    expect(await healLinkedCrmContactIdentityFromChat(prisma, emptyChat)).toBe(false);
    expect(prisma._state.contacts[0]?.displayName).toBe("Unknown User");
    expect(prisma._state.updates).toBe(0);

    expect(await healLinkedCrmContactIdentityFromChat(prisma, joeChat())).toBe(true);
    expect(prisma._state.contacts[0]).toMatchObject({
      displayName: "Joe Mashburn",
      username: "waylon_rivers85"
    });
  });

  it("preserves a legitimate CRM name and does not write", async () => {
    const prisma = createRepairPrisma([
      { id: joeContactId, workspaceId: workspaceA, displayName: "Custom Player Name", username: "kept" }
    ]);
    expect(await healLinkedCrmContactIdentityFromChat(prisma, joeChat())).toBe(false);
    expect(prisma._state.contacts[0]?.displayName).toBe("Custom Player Name");
    expect(prisma._state.updates).toBe(0);
  });

  it("never downgrades when Telegram later has blank fields", async () => {
    const prisma = createRepairPrisma([
      { id: joeContactId, workspaceId: workspaceA, displayName: "Joe Mashburn", username: "waylon_rivers85" }
    ]);
    expect(
      await healLinkedCrmContactIdentityFromChat(prisma, {
        ...joeChat(),
        title: "",
        username: null,
        firstName: null,
        lastName: null
      })
    ).toBe(false);
    expect(prisma._state.contacts[0]?.displayName).toBe("Joe Mashburn");
    expect(prisma._state.updates).toBe(0);
  });

  it("does not treat Telegram service account 777000 as a player repair", async () => {
    const prisma = createRepairPrisma([
      { id: serviceContactId, workspaceId: workspaceA, displayName: "Unknown", username: null }
    ]);
    expect(
      await healLinkedCrmContactIdentityFromChat(prisma, {
        workspaceId: workspaceA,
        telegramChatId: "777000",
        chatType: "PRIVATE",
        title: "Telegram",
        username: null,
        firstName: "Telegram",
        lastName: null,
        isBot: false,
        crmContactId: serviceContactId
      })
    ).toBe(false);
    expect(prisma._state.contacts[0]?.displayName).toBe("Unknown");
    expect(prisma._state.updates).toBe(0);
  });

  it("cannot update a contact that belongs to another workspace", async () => {
    const prisma = createRepairPrisma([
      { id: joeContactId, workspaceId: workspaceB, displayName: "Unknown", username: null }
    ]);
    expect(await healLinkedCrmContactIdentityFromChat(prisma, joeChat({ workspaceId: workspaceA }))).toBe(false);
    expect(prisma._state.contacts[0]?.displayName).toBe("Unknown");
    expect(prisma._state.updates).toBe(0);
  });
});
