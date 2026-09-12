import { describe, expect, it } from "vitest";
import {
  resolveAndHealPublicLeaderboardDisplayName,
  resolvePublicLeaderboardNameFromContact,
  shouldHealCrmPublicDisplayName
} from "./public-leaderboard-identity";

const contactId = "b1e1e379-82bf-494c-aa45-0de204e72209";

function createHealPrisma(contacts: Array<{ id: string; displayName: string }>) {
  const state = {
    contacts: contacts.map((row) => ({ ...row })),
    updates: 0
  };
  return {
    _state: state,
    crmContact: {
      update: async ({
        where,
        data
      }: {
        where: { id: string };
        data: { displayName: string };
      }) => {
        const row = state.contacts.find((c) => c.id === where.id);
        if (!row) throw new Error("missing contact");
        row.displayName = data.displayName;
        state.updates += 1;
        return row;
      }
    }
  };
}

describe("resolvePublicLeaderboardNameFromContact", () => {
  it("displays a valid Telegram name when the CRM name is weak", () => {
    expect(
      resolvePublicLeaderboardNameFromContact({
        displayName: "Telegram user 8201130943",
        chats: [{ chatType: "PRIVATE", firstName: "L.", lastName: "J.", title: "L. J." }]
      })
    ).toBe("L. J.");
  });

  it("displays a valid Telegram name when the CRM name is blank", () => {
    expect(
      resolvePublicLeaderboardNameFromContact({
        displayName: "   ",
        chats: [{ chatType: "PRIVATE", firstName: "John", lastName: "McCloud", title: "John McCloud" }]
      })
    ).toBe("John McCloud");
  });

  it("displays the Telegram human name when CRM is privacy-sensitive", () => {
    expect(
      resolvePublicLeaderboardNameFromContact({
        displayName: "@privateusername",
        username: "privateusername",
        chats: [
          {
            chatType: "PRIVATE",
            firstName: "Amanda",
            lastName: "Mauricio",
            username: "privateusername",
            title: "Amanda Mauricio"
          }
        ]
      })
    ).toBe("Amanda Mauricio");
  });

  it("falls back to Player when no valid identity exists", () => {
    expect(
      resolvePublicLeaderboardNameFromContact({
        displayName: "Telegram user 123456",
        username: "secretuser",
        chats: [
          {
            chatType: "PRIVATE",
            firstName: null,
            lastName: null,
            title: "8687540231",
            username: "secretuser"
          }
        ]
      })
    ).toBe("Player");
  });

  it("keeps a custom valid CRM name unchanged", () => {
    expect(
      resolvePublicLeaderboardNameFromContact({
        displayName: "Custom Player Name",
        chats: [{ chatType: "PRIVATE", firstName: "Joe", lastName: "Mashburn", title: "Joe Mashburn" }]
      })
    ).toBe("Custom Player Name");
    expect(shouldHealCrmPublicDisplayName("Custom Player Name", "Joe Mashburn")).toBe(false);
  });

  it("uses a private chat title when first/last are blank", () => {
    expect(
      resolvePublicLeaderboardNameFromContact({
        displayName: "Player",
        chats: [{ chatType: "PRIVATE", firstName: null, lastName: null, title: "Jake" }]
      })
    ).toBe("Jake");
  });

  it("does not use a group title as the public player name", () => {
    expect(
      resolvePublicLeaderboardNameFromContact({
        displayName: "Player",
        chats: [{ chatType: "GROUP", firstName: null, lastName: null, title: "Staff Room" }]
      })
    ).toBe("Player");
  });
});

describe("resolveAndHealPublicLeaderboardDisplayName", () => {
  it("heals a weak CRM placeholder from Telegram identity", async () => {
    const prisma = createHealPrisma([{ id: contactId, displayName: "Telegram user 8201130943" }]);
    const displayName = await resolveAndHealPublicLeaderboardDisplayName({
      prisma,
      crmContactId: contactId,
      contact: {
        displayName: "Telegram user 8201130943",
        chats: [{ chatType: "PRIVATE", firstName: "L.", lastName: "J." }]
      }
    });
    expect(displayName).toBe("L. J.");
    expect(prisma._state.contacts[0]?.displayName).toBe("L. J.");
    expect(prisma._state.updates).toBe(1);
  });

  it("heals a blank CRM name from Telegram identity", async () => {
    const prisma = createHealPrisma([{ id: contactId, displayName: "" }]);
    const displayName = await resolveAndHealPublicLeaderboardDisplayName({
      prisma,
      crmContactId: contactId,
      contact: {
        displayName: "",
        chats: [{ chatType: "PRIVATE", firstName: "John", lastName: "McCloud" }]
      }
    });
    expect(displayName).toBe("John McCloud");
    expect(prisma._state.contacts[0]?.displayName).toBe("John McCloud");
  });

  it("does not overwrite a custom CRM name", async () => {
    const prisma = createHealPrisma([{ id: contactId, displayName: "Custom Player Name" }]);
    const displayName = await resolveAndHealPublicLeaderboardDisplayName({
      prisma,
      crmContactId: contactId,
      contact: {
        displayName: "Custom Player Name",
        chats: [{ chatType: "PRIVATE", firstName: "Joe", lastName: "Mashburn" }]
      }
    });
    expect(displayName).toBe("Custom Player Name");
    expect(prisma._state.contacts[0]?.displayName).toBe("Custom Player Name");
    expect(prisma._state.updates).toBe(0);
  });

  it("still returns Player and does not write when nothing can be recovered", async () => {
    const prisma = createHealPrisma([{ id: contactId, displayName: "Unknown User" }]);
    const displayName = await resolveAndHealPublicLeaderboardDisplayName({
      prisma,
      crmContactId: contactId,
      contact: {
        displayName: "Unknown User",
        chats: [{ chatType: "PRIVATE", title: "@privateusername" }]
      }
    });
    expect(displayName).toBe("Player");
    expect(prisma._state.contacts[0]?.displayName).toBe("Unknown User");
    expect(prisma._state.updates).toBe(0);
  });

  it("is idempotent after a successful heal", async () => {
    const prisma = createHealPrisma([{ id: contactId, displayName: "Player" }]);
    const contact = {
      displayName: "Player",
      chats: [{ chatType: "PRIVATE" as const, firstName: "Redface", lastName: null }]
    };
    await resolveAndHealPublicLeaderboardDisplayName({
      prisma,
      crmContactId: contactId,
      contact
    });
    const second = await resolveAndHealPublicLeaderboardDisplayName({
      prisma,
      crmContactId: contactId,
      contact: { ...contact, displayName: prisma._state.contacts[0]!.displayName }
    });
    expect(second).toBe("Redface");
    expect(prisma._state.updates).toBe(1);
  });
});
