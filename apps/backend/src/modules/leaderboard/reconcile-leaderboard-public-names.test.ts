import { describe, expect, it } from "vitest";
import { reconcileLeaderboardPublicNames } from "./reconcile-leaderboard-public-names";

const workspaceA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ownerA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const ljId = "11111111-1111-4111-8111-111111111111";
const customId = "22222222-2222-4222-8222-222222222222";
const blankId = "33333333-3333-4333-8333-333333333333";
const privacyId = "44444444-4444-4444-8444-444444444444";
const noneId = "55555555-5555-4555-8555-555555555555";

type ChatRow = {
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  title: string;
  chatType: string;
  updatedAt: Date;
  isBot?: boolean;
  isArchived?: boolean;
};

type ContactRow = {
  id: string;
  workspaceId: string;
  displayName: string;
  username: string | null;
  chats: ChatRow[];
};

type ParticipantRow = {
  crmContactId: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  updatedAt: Date;
};

function privateChat(partial: Partial<ChatRow> & Pick<ChatRow, "title">): ChatRow {
  return {
    firstName: partial.firstName ?? null,
    lastName: partial.lastName ?? null,
    username: partial.username ?? null,
    title: partial.title,
    chatType: partial.chatType ?? "PRIVATE",
    updatedAt: partial.updatedAt ?? new Date("2026-08-01T00:00:00.000Z"),
    isBot: partial.isBot ?? false,
    isArchived: partial.isArchived ?? false
  };
}

function createPrisma(input: { contacts: ContactRow[]; participants: ParticipantRow[] }) {
  const state = {
    contacts: input.contacts.map((row) => ({ ...row, chats: row.chats.map((chat) => ({ ...chat })) })),
    participants: [...input.participants],
    logs: [] as Array<{ crmContactId: string; toDisplayName: string }>,
    updates: 0
  };
  const prisma = {
    _state: state,
    leaderboardParticipant: {
      findMany: async ({ where, take }: { where?: any; take?: number }) => {
        let rows = state.participants.filter((row) => {
          if (where?.workspaceId && row.workspaceId !== where.workspaceId) return false;
          if (where?.ownerCoadminUserId && row.ownerCoadminUserId !== where.ownerCoadminUserId) return false;
          return true;
        });
        rows = [...rows].sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
        if (typeof take === "number") rows = rows.slice(0, take);
        return rows.map((row) => ({
          crmContactId: row.crmContactId,
          workspaceId: row.workspaceId,
          crmContact: state.contacts.find((contact) => contact.id === row.crmContactId)!
        }));
      }
    },
    crmContact: {
      update: async ({ where, data }: { where: { id: string }; data: { displayName: string } }) => {
        const row = state.contacts.find((c) => c.id === where.id);
        if (!row) throw new Error("missing contact");
        row.displayName = data.displayName;
        state.updates += 1;
        return row;
      }
    }
  };
  return prisma as any;
}

function participant(crmContactId: string, updatedAt: string): ParticipantRow {
  return {
    crmContactId,
    workspaceId: workspaceA,
    ownerCoadminUserId: ownerA,
    updatedAt: new Date(updatedAt)
  };
}

describe("reconcileLeaderboardPublicNames", () => {
  it("repairs weak CRM names from Telegram identity and keeps custom names", async () => {
    const prisma = createPrisma({
      contacts: [
        {
          id: ljId,
          workspaceId: workspaceA,
          displayName: "Telegram user 8201130943",
          username: null,
          chats: [privateChat({ firstName: "L.", lastName: "J.", title: "L. J." })]
        },
        {
          id: blankId,
          workspaceId: workspaceA,
          displayName: "",
          username: null,
          chats: [privateChat({ firstName: "John", lastName: "McCloud", title: "John McCloud" })]
        },
        {
          id: privacyId,
          workspaceId: workspaceA,
          displayName: "@privateusername",
          username: "privateusername",
          chats: [privateChat({ firstName: "Amanda", lastName: "Mauricio", title: "Amanda Mauricio" })]
        },
        {
          id: customId,
          workspaceId: workspaceA,
          displayName: "Custom Player Name",
          username: null,
          chats: [privateChat({ firstName: "Joe", lastName: "Mashburn", title: "Joe Mashburn" })]
        },
        {
          id: noneId,
          workspaceId: workspaceA,
          displayName: "Unknown User",
          username: null,
          chats: [privateChat({ title: "8687540231" })]
        }
      ],
      participants: [
        participant(ljId, "2026-08-01T00:00:00.000Z"),
        participant(blankId, "2026-08-02T00:00:00.000Z"),
        participant(privacyId, "2026-08-03T00:00:00.000Z"),
        participant(customId, "2026-08-04T00:00:00.000Z"),
        participant(noneId, "2026-08-05T00:00:00.000Z")
      ]
    });

    const result = await reconcileLeaderboardPublicNames(prisma, { workspaceId: workspaceA, dryRun: false });
    expect(result.scanned).toBe(5);
    expect(result.updated).toBe(3);
    expect(result.repaired.map((row) => row.toDisplayName).sort()).toEqual([
      "Amanda Mauricio",
      "John McCloud",
      "L. J."
    ]);
    expect(prisma._state.contacts.find((c: ContactRow) => c.id === ljId)?.displayName).toBe("L. J.");
    expect(prisma._state.contacts.find((c: ContactRow) => c.id === blankId)?.displayName).toBe("John McCloud");
    expect(prisma._state.contacts.find((c: ContactRow) => c.id === privacyId)?.displayName).toBe(
      "Amanda Mauricio"
    );
    expect(prisma._state.contacts.find((c: ContactRow) => c.id === customId)?.displayName).toBe(
      "Custom Player Name"
    );
    expect(prisma._state.contacts.find((c: ContactRow) => c.id === noneId)?.displayName).toBe("Unknown User");
  });

  it("is idempotent and supports dry-run", async () => {
    const prisma = createPrisma({
      contacts: [
        {
          id: ljId,
          workspaceId: workspaceA,
          displayName: "Telegram user 8201130943",
          username: null,
          chats: [privateChat({ firstName: "L.", lastName: "J.", title: "L. J." })]
        }
      ],
      participants: [participant(ljId, "2026-08-01T00:00:00.000Z")]
    });

    const dry = await reconcileLeaderboardPublicNames(prisma, { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, eligible: 1, updated: 0 });
    expect(prisma._state.contacts[0]?.displayName).toBe("Telegram user 8201130943");

    const first = await reconcileLeaderboardPublicNames(prisma, { dryRun: false });
    const second = await reconcileLeaderboardPublicNames(prisma, { dryRun: false });
    expect(first.updated).toBe(1);
    expect(second.updated).toBe(0);
    expect(prisma._state.updates).toBe(1);
    expect(prisma._state.contacts[0]?.displayName).toBe("L. J.");
  });
});
