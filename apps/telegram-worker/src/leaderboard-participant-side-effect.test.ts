import { describe, expect, it } from "vitest";
import { ensureLeaderboardParticipantBestEffort } from "./leaderboard-participant-side-effect";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ownerA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const contactId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const channelId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc2";

function createWorkerPrisma() {
  const state = {
    users: [] as Array<{ id: string; workspaceId: string; role: string; status: string }>,
    contacts: [] as Array<{
      id: string;
      workspaceId: string;
      kind: string;
      telegramPeerId: string;
    }>,
    participants: [] as Array<{
      id: string;
      workspaceId: string;
      ownerCoadminUserId: string;
      crmContactId: string;
    }>,
    settings: [] as Array<{
      ownerCoadminUserId: string;
      workspaceId: string;
      enabled: boolean;
    }>,
    competitions: [] as Array<{
      id: string;
      workspaceId: string;
      ownerCoadminUserId: string;
      status: string;
      startsAt: Date;
      endsAt: Date;
    }>,
    standings: [] as Array<{
      competitionId: string;
      crmContactId: string;
      ownerCoadminUserId: string;
    }>
  };

  const prisma: any = {
    _state: state,
    crmContact: {
      findFirst: async ({ where }: any) =>
        state.contacts.find((c) => c.id === where.id && c.workspaceId === where.workspaceId) ?? null,
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const row of state.contacts) {
          if (where.id && row.id !== where.id) continue;
          if (where.workspaceId && row.workspaceId !== where.workspaceId) continue;
          if (where.kind && row.kind !== where.kind) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      }
    },
    user: {
      findMany: async ({ where, take }: any) => {
        let rows = state.users.filter(
          (u) =>
            u.workspaceId === where.workspaceId &&
            u.role === where.role &&
            u.status === where.status
        );
        rows = [...rows].sort((a, b) => a.id.localeCompare(b.id));
        if (typeof take === "number") rows = rows.slice(0, take);
        return rows.map((u) => ({ id: u.id }));
      }
    },
    leaderboardParticipant: {
      findMany: async ({ where }: any) =>
        state.participants.filter(
          (p) => p.workspaceId === where.workspaceId && p.crmContactId === where.crmContactId
        ),
      create: async ({ data }: any) => {
        if (
          state.participants.some(
            (p) => p.workspaceId === data.workspaceId && p.crmContactId === data.crmContactId
          )
        ) {
          const err: any = new Error("Unique");
          err.code = "P2002";
          throw err;
        }
        const row = { id: `p-${state.participants.length + 1}`, ...data };
        state.participants.push(row);
        return row;
      }
    },
    leaderboardSettings: {
      findUnique: async ({ where }: any) =>
        state.settings.find((s) => s.ownerCoadminUserId === where.ownerCoadminUserId) ?? null,
      upsert: async ({ where, create }: any) => {
        const existing = state.settings.find(
          (s) => s.ownerCoadminUserId === where.ownerCoadminUserId
        );
        if (existing) return existing;
        const row = {
          ownerCoadminUserId: create.ownerCoadminUserId,
          workspaceId: create.workspaceId,
          enabled: create.enabled ?? false
        };
        state.settings.push(row);
        return row;
      }
    },
    leaderboardCompetition: {
      findFirst: async ({ where }: any) => {
        const now = new Date();
        return (
          state.competitions.find(
            (c) =>
              c.workspaceId === where.workspaceId &&
              c.ownerCoadminUserId === where.ownerCoadminUserId &&
              c.status === where.status &&
              c.startsAt <= now &&
              c.endsAt > now
          ) ?? null
        );
      }
    },
    leaderboardStanding: {
      upsert: async ({ where, create }: any) => {
        const existing = state.standings.find(
          (s) =>
            s.competitionId === where.competitionId_crmContactId.competitionId &&
            s.crmContactId === where.competitionId_crmContactId.crmContactId
        );
        if (existing) return existing;
        const row = {
          competitionId: create.competitionId,
          crmContactId: create.crmContactId,
          ownerCoadminUserId: create.ownerCoadminUserId
        };
        state.standings.push(row);
        return row;
      }
    }
  };

  return prisma;
}

describe("telegram-worker leaderboard participant side effect", () => {
  it("binds PRIVATE contact for sole Coadmin workspace", async () => {
    const prisma = createWorkerPrisma();
    prisma._state.users.push({
      id: ownerA,
      workspaceId,
      role: "COADMIN",
      status: "ACTIVE"
    });
    prisma._state.contacts.push({
      id: contactId,
      workspaceId,
      kind: "PRIVATE",
      telegramPeerId: "12345"
    });

    const result = await ensureLeaderboardParticipantBestEffort(prisma, workspaceId, contactId);
    expect(result.status).toBe("BOUND");
    expect(prisma._state.participants).toHaveLength(1);
  });

  it("binds UNKNOWN numeric person contacts (Picasso-like live-sync gap)", async () => {
    const prisma = createWorkerPrisma();
    prisma._state.users.push({
      id: ownerA,
      workspaceId,
      role: "COADMIN",
      status: "ACTIVE"
    });
    prisma._state.contacts.push({
      id: contactId,
      workspaceId,
      kind: "UNKNOWN",
      telegramPeerId: "424747"
    });

    const result = await ensureLeaderboardParticipantBestEffort(prisma, workspaceId, contactId);
    expect(result.status).toBe("BOUND");
    expect(prisma._state.participants).toHaveLength(1);
    expect(prisma._state.contacts.find((c) => c.id === contactId)?.kind).toBe("PRIVATE");
  });

  it("skips CHANNEL contacts", async () => {
    const prisma = createWorkerPrisma();
    prisma._state.users.push({
      id: ownerA,
      workspaceId,
      role: "COADMIN",
      status: "ACTIVE"
    });
    prisma._state.contacts.push({
      id: channelId,
      workspaceId,
      kind: "CHANNEL",
      telegramPeerId: "999"
    });

    const result = await ensureLeaderboardParticipantBestEffort(prisma, workspaceId, channelId);
    expect(result).toMatchObject({ status: "SKIPPED", reason: "NOT_PRIVATE" });
    expect(prisma._state.participants).toHaveLength(0);
  });

  it("skips when ownership is ambiguous", async () => {
    const prisma = createWorkerPrisma();
    prisma._state.users.push(
      { id: ownerA, workspaceId, role: "COADMIN", status: "ACTIVE" },
      { id: ownerB, workspaceId, role: "COADMIN", status: "ACTIVE" }
    );
    prisma._state.contacts.push({
      id: contactId,
      workspaceId,
      kind: "PRIVATE",
      telegramPeerId: "12345"
    });

    const result = await ensureLeaderboardParticipantBestEffort(prisma, workspaceId, contactId);
    expect(result).toMatchObject({ status: "SKIPPED", reason: "AMBIGUOUS_OWNER" });
  });
});
