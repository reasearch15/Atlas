import { describe, expect, it } from "vitest";
import {
  ensurePrivateContactParticipantSideEffect,
  tryAutoBindForDeterministicOwner,
  tryAutoBindParticipant
} from "./auto-bind";
import { backfillLeaderboardParticipants } from "./backfill-participants";
import { LeaderboardError } from "./leaderboard.errors";
import { selectPlayerSearchHits } from "./player-search";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const ownerA = "22222222-2222-4222-8222-222222222222";
const ownerB = "33333333-3333-4333-8333-333333333333";
const contactPrivate = "44444444-4444-4444-8444-444444444401";
const contactChannel = "44444444-4444-4444-8444-444444444402";
const contactGroup = "44444444-4444-4444-8444-444444444403";
const contactPicasso = "44444444-4444-4444-8444-444444444404";
const contactOtherWs = "44444444-4444-4444-8444-444444444405";

type ContactRow = {
  id: string;
  workspaceId: string;
  kind: string;
  telegramPeerId: string;
  displayName: string;
  username: string | null;
};

type ParticipantRow = {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  crmContactId: string;
};

type StandingRow = {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  competitionId: string;
  crmContactId: string;
  totalPoints: number;
  depositPoints: number;
  referralPoints: number;
  promotionPoints: number;
  wheelPoints: number;
};

function createPrisma() {
  const state = {
    users: [] as Array<{ id: string; workspaceId: string; role: string; status: string }>,
    contacts: [] as ContactRow[],
    participants: [] as ParticipantRow[],
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
    standings: [] as StandingRow[],
    poolRateHistory: [] as unknown[],
    audits: [] as unknown[]
  };

  const prisma: any = {
    _state: state,
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
    crmContact: {
      findFirst: async ({ where }: any) => {
        const row = state.contacts.find(
          (c) => c.id === where.id && c.workspaceId === where.workspaceId
        );
        return row
          ? { id: row.id, kind: row.kind, telegramPeerId: row.telegramPeerId }
          : null;
      },
      findMany: async ({ where, take }: any) => {
        let rows = state.contacts.filter((c) => c.workspaceId === where.workspaceId);
        if (where.kind) {
          if (typeof where.kind === "string") {
            rows = rows.filter((c) => c.kind === where.kind);
          } else if (Array.isArray(where.kind.in)) {
            rows = rows.filter((c) => where.kind.in.includes(c.kind));
          }
        }
        if (typeof take === "number") rows = rows.slice(0, take);
        return rows.map((c) => ({
          id: c.id,
          kind: c.kind,
          telegramPeerId: c.telegramPeerId
        }));
      },
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
    leaderboardParticipant: {
      findMany: async ({ where }: any) => {
        return state.participants.filter((p) => {
          if (where.workspaceId && p.workspaceId !== where.workspaceId) return false;
          if (where.crmContactId && p.crmContactId !== where.crmContactId) return false;
          if (where.ownerCoadminUserId && p.ownerCoadminUserId !== where.ownerCoadminUserId) {
            return false;
          }
          return true;
        });
      },
      create: async ({ data }: any) => {
        if (
          state.participants.some(
            (p) => p.workspaceId === data.workspaceId && p.crmContactId === data.crmContactId
          )
        ) {
          const err: any = new Error("Unique constraint");
          err.code = "P2002";
          throw err;
        }
        const row = {
          id: `p-${state.participants.length + 1}`,
          workspaceId: data.workspaceId,
          ownerCoadminUserId: data.ownerCoadminUserId,
          crmContactId: data.crmContactId
        };
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
        const row: StandingRow = {
          id: `s-${state.standings.length + 1}`,
          workspaceId: create.workspaceId,
          ownerCoadminUserId: create.ownerCoadminUserId,
          competitionId: create.competitionId,
          crmContactId: create.crmContactId,
          totalPoints: 0,
          depositPoints: 0,
          referralPoints: 0,
          promotionPoints: 0,
          wheelPoints: 0
        };
        state.standings.push(row);
        return row;
      },
      findMany: async ({ where }: any) =>
        state.standings.filter((s) => {
          if (where.competitionId && s.competitionId !== where.competitionId) return false;
          if (where.ownerCoadminUserId && s.ownerCoadminUserId !== where.ownerCoadminUserId) {
            return false;
          }
          return true;
        })
    },
    poolRateHistory: {
      findFirst: async () => state.poolRateHistory[0] ?? null,
      create: async ({ data }: any) => {
        state.poolRateHistory.push(data);
        return data;
      }
    },
    $transaction: async (fn: any) => fn(prisma)
  };

  return prisma;
}

class TestDomain {
  constructor(private readonly prisma: any) {}
  async ensureSettings(workspaceId: string, ownerCoadminUserId: string) {
    return this.prisma.leaderboardSettings.upsert({
      where: { ownerCoadminUserId },
      create: { workspaceId, ownerCoadminUserId, enabled: false },
      update: { ownerCoadminUserId }
    });
  }
  async bindParticipant(input: {
    workspaceId: string;
    ownerCoadminUserId: string;
    crmContactId: string;
    createdByUserId?: string;
  }) {
    const existing = await this.prisma.leaderboardParticipant.findMany({
      where: { workspaceId: input.workspaceId, crmContactId: input.crmContactId }
    });
    if (existing.length > 1) {
      throw new LeaderboardError("PARTICIPANT_INTEGRITY_ERROR", "integrity");
    }
    if (existing.length === 1) {
      if (existing[0].ownerCoadminUserId !== input.ownerCoadminUserId) {
        throw new LeaderboardError("PARTICIPANT_TRANSFER_UNSUPPORTED", "transfer");
      }
      await this.ensureZeroStanding(input);
      return existing[0];
    }
    try {
      const row = await this.prisma.leaderboardParticipant.create({ data: input });
      await this.ensureZeroStanding(input);
      return row;
    } catch (error: any) {
      if (error?.code !== "P2002") throw error;
      const raced = await this.prisma.leaderboardParticipant.findMany({
        where: { workspaceId: input.workspaceId, crmContactId: input.crmContactId }
      });
      if (raced.length === 1 && raced[0].ownerCoadminUserId === input.ownerCoadminUserId) {
        await this.ensureZeroStanding(input);
        return raced[0];
      }
      if (raced.length === 1) {
        throw new LeaderboardError("PARTICIPANT_TRANSFER_UNSUPPORTED", "transfer");
      }
      throw error;
    }
  }
  private async ensureZeroStanding(input: {
    workspaceId: string;
    ownerCoadminUserId: string;
    crmContactId: string;
  }) {
    const settings = await this.prisma.leaderboardSettings.findUnique({
      where: { ownerCoadminUserId: input.ownerCoadminUserId }
    });
    if (!settings?.enabled) return;
    const competition = await this.prisma.leaderboardCompetition.findFirst({
      where: {
        workspaceId: input.workspaceId,
        ownerCoadminUserId: input.ownerCoadminUserId,
        status: "ACTIVE"
      }
    });
    if (!competition) return;
    await this.prisma.leaderboardStanding.upsert({
      where: {
        competitionId_crmContactId: {
          competitionId: competition.id,
          crmContactId: input.crmContactId
        }
      },
      create: {
        workspaceId: input.workspaceId,
        ownerCoadminUserId: input.ownerCoadminUserId,
        competitionId: competition.id,
        crmContactId: input.crmContactId
      },
      update: { ownerCoadminUserId: input.ownerCoadminUserId }
    });
  }
}

describe("automatic PRIVATE contact participant binding", () => {
  it("creates participant for new PRIVATE contact in single-Coadmin workspace", async () => {
    const prisma = createPrisma();
    prisma._state.users.push({
      id: ownerA,
      workspaceId,
      role: "COADMIN",
      status: "ACTIVE"
    });
    prisma._state.contacts.push({
      id: contactPrivate,
      workspaceId,
      kind: "PRIVATE",
      telegramPeerId: "9001",
      displayName: "Player",
      username: null
    });

    const result = await ensurePrivateContactParticipantSideEffect(
      prisma,
      { workspaceId, crmContactId: contactPrivate, source: "LIVE_SYNC" },
      new TestDomain(prisma) as never
    );
    expect(result.status).toBe("BOUND");
    expect(prisma._state.participants).toHaveLength(1);
    expect(prisma._state.participants[0]?.ownerCoadminUserId).toBe(ownerA);
  });

  it("creates participant even when leaderboard is disabled", async () => {
    const prisma = createPrisma();
    prisma._state.users.push({
      id: ownerA,
      workspaceId,
      role: "COADMIN",
      status: "ACTIVE"
    });
    prisma._state.settings.push({
      ownerCoadminUserId: ownerA,
      workspaceId,
      enabled: false
    });
    prisma._state.contacts.push({
      id: contactPrivate,
      workspaceId,
      kind: "PRIVATE",
      telegramPeerId: "9001",
      displayName: "Player",
      username: null
    });

    const result = await tryAutoBindForDeterministicOwner(
      prisma,
      { workspaceId, crmContactId: contactPrivate, source: "CRM" },
      new TestDomain(prisma) as never
    );
    expect(result.status).toBe("BOUND");
    expect(prisma._state.standings).toHaveLength(0);
  });

  it("creates zero standing when ACTIVE competition exists", async () => {
    const prisma = createPrisma();
    prisma._state.users.push({
      id: ownerA,
      workspaceId,
      role: "COADMIN",
      status: "ACTIVE"
    });
    prisma._state.settings.push({
      ownerCoadminUserId: ownerA,
      workspaceId,
      enabled: true
    });
    prisma._state.competitions.push({
      id: "comp-1",
      workspaceId,
      ownerCoadminUserId: ownerA,
      status: "ACTIVE",
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 86_400_000)
    });
    prisma._state.contacts.push({
      id: contactPrivate,
      workspaceId,
      kind: "PRIVATE",
      telegramPeerId: "9001",
      displayName: "Player",
      username: null
    });

    const result = await tryAutoBindParticipant(
      prisma,
      {
        workspaceId,
        crmContactId: contactPrivate,
        ownerCoadminUserId: ownerA,
        source: "CRM"
      },
      new TestDomain(prisma) as never
    );
    expect(result.status).toBe("BOUND");
    expect(prisma._state.standings).toHaveLength(1);
    expect(prisma._state.standings[0]).toMatchObject({
      totalPoints: 0,
      depositPoints: 0,
      referralPoints: 0,
      promotionPoints: 0,
      wheelPoints: 0,
      crmContactId: contactPrivate
    });
  });

  it("does not bind CHANNEL or GROUP contacts", async () => {
    const prisma = createPrisma();
    prisma._state.users.push({
      id: ownerA,
      workspaceId,
      role: "COADMIN",
      status: "ACTIVE"
    });
    prisma._state.contacts.push(
      {
        id: contactChannel,
        workspaceId,
        kind: "CHANNEL",
        telegramPeerId: "9002",
        displayName: "Channel",
        username: null
      },
      {
        id: contactGroup,
        workspaceId,
        kind: "GROUP",
        telegramPeerId: "9003",
        displayName: "Group",
        username: null
      }
    );

    const channel = await tryAutoBindForDeterministicOwner(
      prisma,
      { workspaceId, crmContactId: contactChannel, source: "LIVE_SYNC" },
      new TestDomain(prisma) as never
    );
    const group = await tryAutoBindForDeterministicOwner(
      prisma,
      { workspaceId, crmContactId: contactGroup, source: "LIVE_SYNC" },
      new TestDomain(prisma) as never
    );
    expect(channel).toMatchObject({ status: "SKIPPED", reason: "NOT_PRIVATE" });
    expect(group).toMatchObject({ status: "SKIPPED", reason: "NOT_PRIVATE" });
    expect(prisma._state.participants).toHaveLength(0);
  });

  it("is idempotent for an existing participant", async () => {
    const prisma = createPrisma();
    prisma._state.users.push({
      id: ownerA,
      workspaceId,
      role: "COADMIN",
      status: "ACTIVE"
    });
    prisma._state.contacts.push({
      id: contactPrivate,
      workspaceId,
      kind: "PRIVATE",
      telegramPeerId: "9001",
      displayName: "Player",
      username: null
    });
    const domain = new TestDomain(prisma) as never;
    await tryAutoBindForDeterministicOwner(
      prisma,
      { workspaceId, crmContactId: contactPrivate, source: "CRM" },
      domain
    );
    const second = await tryAutoBindForDeterministicOwner(
      prisma,
      { workspaceId, crmContactId: contactPrivate, source: "CRM" },
      domain
    );
    expect(second.status).toBe("ALREADY_BOUND");
    expect(prisma._state.participants).toHaveLength(1);
  });

  it("handles 20 concurrent ensure attempts with a single participant", async () => {
    const prisma = createPrisma();
    prisma._state.users.push({
      id: ownerA,
      workspaceId,
      role: "COADMIN",
      status: "ACTIVE"
    });
    prisma._state.contacts.push({
      id: contactPrivate,
      workspaceId,
      kind: "PRIVATE",
      telegramPeerId: "9001",
      displayName: "Player",
      username: null
    });
    const domain = new TestDomain(prisma) as never;
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        tryAutoBindForDeterministicOwner(
          prisma,
          { workspaceId, crmContactId: contactPrivate, source: "LIVE_SYNC" },
          domain
        )
      )
    );
    expect(prisma._state.participants).toHaveLength(1);
    expect(
      results.every((r) => r.status === "BOUND" || r.status === "ALREADY_BOUND")
    ).toBe(true);
  });

  it("does not guess ownership in multi-Coadmin workspaces", async () => {
    const prisma = createPrisma();
    prisma._state.users.push(
      { id: ownerA, workspaceId, role: "COADMIN", status: "ACTIVE" },
      { id: ownerB, workspaceId, role: "COADMIN", status: "ACTIVE" }
    );
    prisma._state.contacts.push({
      id: contactPrivate,
      workspaceId,
      kind: "PRIVATE",
      telegramPeerId: "9001",
      displayName: "Player",
      username: null
    });

    const result = await tryAutoBindForDeterministicOwner(
      prisma,
      { workspaceId, crmContactId: contactPrivate, source: "CRM" },
      new TestDomain(prisma) as never
    );
    expect(result).toMatchObject({ status: "SKIPPED", reason: "AMBIGUOUS_OWNER" });
    expect(prisma._state.participants).toHaveLength(0);
  });

  it("does not transfer an existing participant owned by another Coadmin", async () => {
    const prisma = createPrisma();
    prisma._state.users.push({
      id: ownerA,
      workspaceId,
      role: "COADMIN",
      status: "ACTIVE"
    });
    prisma._state.contacts.push({
      id: contactPrivate,
      workspaceId,
      kind: "PRIVATE",
      telegramPeerId: "9001",
      displayName: "Player",
      username: null
    });
    prisma._state.participants.push({
      id: "p-existing",
      workspaceId,
      ownerCoadminUserId: ownerB,
      crmContactId: contactPrivate
    });

    const result = await tryAutoBindParticipant(
      prisma,
      {
        workspaceId,
        crmContactId: contactPrivate,
        ownerCoadminUserId: ownerA,
        source: "CRM"
      },
      new TestDomain(prisma) as never
    );
    expect(result.status).toBe("TRANSFER_REJECTED");
    expect(prisma._state.participants).toHaveLength(1);
    expect(prisma._state.participants[0]?.ownerCoadminUserId).toBe(ownerB);
  });

  it("backfill binds missing PRIVATE contacts and reports conflicts/idempotency", async () => {
    const prisma = createPrisma();
    prisma._state.users.push({
      id: ownerA,
      workspaceId,
      role: "COADMIN",
      status: "ACTIVE"
    });
    prisma._state.contacts.push(
      {
        id: contactPicasso,
        workspaceId,
        kind: "PRIVATE",
        telegramPeerId: "4247",
        displayName: "Picasso",
        username: "Piccaso47"
      },
      {
        id: contactPrivate,
        workspaceId,
        kind: "PRIVATE",
        telegramPeerId: "9001",
        displayName: "Already",
        username: null
      },
      {
        id: contactChannel,
        workspaceId,
        kind: "CHANNEL",
        telegramPeerId: "9002",
        displayName: "Chan",
        username: null
      },
      {
        id: contactOtherWs,
        workspaceId,
        kind: "PRIVATE",
        telegramPeerId: "abc",
        displayName: "BadPeer",
        username: null
      }
    );
    prisma._state.participants.push({
      id: "p-already",
      workspaceId,
      ownerCoadminUserId: ownerA,
      crmContactId: contactPrivate
    });

    const domain = new TestDomain(prisma) as never;
    const first = await backfillLeaderboardParticipants(
      prisma,
      { workspaceId, dryRun: false },
      domain
    );
    expect(first.scanned).toBe(3);
    expect(first.eligible).toBe(2);
    expect(first.newlyBound).toBe(1);
    expect(first.bound).toBe(1);
    expect(first.alreadyBound).toBe(1);
    expect(first.skipped).toBeGreaterThanOrEqual(1);

    const second = await backfillLeaderboardParticipants(
      prisma,
      { workspaceId, dryRun: false },
      domain
    );
    expect(second.newlyBound).toBe(0);
    expect(second.bound).toBe(0);
    expect(second.alreadyBound).toBe(2);
    expect(prisma._state.participants).toHaveLength(2);

    // Referral search surfaces Picasso after bind (participant haystack).
    const picasso = prisma._state.contacts.find((c: ContactRow) => c.id === contactPicasso)!;
    const hits = selectPlayerSearchHits(
      [
        {
          crmContactId: picasso.id,
          displayName: picasso.displayName,
          username: picasso.username,
          chatFirstNames: ["Picasso"],
          chatLastNames: [],
          chatUsernames: ["Piccaso47"]
        }
      ],
      "picass",
      25
    );
    expect(hits.map((h) => h.crmContactId)).toContain(contactPicasso);
  });

  it("backfill binds Picasso-like UNKNOWN numeric person contacts that live-sync left unbound", async () => {
    const prisma = createPrisma();
    prisma._state.users.push({
      id: ownerA,
      workspaceId,
      role: "COADMIN",
      status: "ACTIVE"
    });
    // Historical gap: TelegramChat treated as PRIVATE, CRM kind stuck UNKNOWN.
    prisma._state.contacts.push({
      id: contactPicasso,
      workspaceId,
      kind: "UNKNOWN",
      telegramPeerId: "424747",
      displayName: "Picasso",
      username: "Piccaso47"
    });

    const first = await backfillLeaderboardParticipants(
      prisma,
      { workspaceId, dryRun: false },
      new TestDomain(prisma) as never
    );
    expect(first.scanned).toBe(1);
    expect(first.eligible).toBe(1);
    expect(first.newlyBound).toBe(1);
    expect(prisma._state.participants).toHaveLength(1);
    expect(prisma._state.participants[0]?.crmContactId).toBe(contactPicasso);
    // Heal UNKNOWN → PRIVATE after bind.
    expect(prisma._state.contacts.find((c) => c.id === contactPicasso)?.kind).toBe("PRIVATE");

    const second = await backfillLeaderboardParticipants(
      prisma,
      { workspaceId, dryRun: false },
      new TestDomain(prisma) as never
    );
    expect(second.newlyBound).toBe(0);
    expect(second.alreadyBound).toBe(1);

    const picasso = prisma._state.contacts.find((c) => c.id === contactPicasso)!;
    for (const q of ["p", "pic", "pica", "picass", "Picasso", "@Piccaso47"]) {
      const hits = selectPlayerSearchHits(
        [
          {
            crmContactId: picasso.id,
            displayName: picasso.displayName,
            username: picasso.username,
            chatFirstNames: ["Picasso"],
            chatLastNames: [],
            chatUsernames: ["Piccaso47"]
          }
        ],
        q,
        25
      );
      expect(hits.map((h) => h.crmContactId)).toContain(contactPicasso);
    }
  });

  it("never binds Coadmin A contact into Coadmin B scope when sole owner is A", async () => {
    const prisma = createPrisma();
    prisma._state.users.push({
      id: ownerA,
      workspaceId,
      role: "COADMIN",
      status: "ACTIVE"
    });
    prisma._state.contacts.push({
      id: contactPrivate,
      workspaceId,
      kind: "PRIVATE",
      telegramPeerId: "9001",
      displayName: "Player",
      username: null
    });

    const mismatch = await tryAutoBindParticipant(
      prisma,
      {
        workspaceId,
        crmContactId: contactPrivate,
        ownerCoadminUserId: ownerB,
        source: "CRM"
      },
      new TestDomain(prisma) as never
    );
    expect(mismatch).toMatchObject({ status: "SKIPPED", reason: "OWNER_SCOPE_MISMATCH" });
    expect(prisma._state.participants).toHaveLength(0);
  });

  it("zero-standing creation does not invent scoring events (no event table writes)", async () => {
    const prisma = createPrisma();
    prisma._state.users.push({
      id: ownerA,
      workspaceId,
      role: "COADMIN",
      status: "ACTIVE"
    });
    prisma._state.settings.push({
      ownerCoadminUserId: ownerA,
      workspaceId,
      enabled: true
    });
    prisma._state.competitions.push({
      id: "comp-1",
      workspaceId,
      ownerCoadminUserId: ownerA,
      status: "ACTIVE",
      startsAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 86_400_000)
    });
    prisma._state.contacts.push({
      id: contactPrivate,
      workspaceId,
      kind: "PRIVATE",
      telegramPeerId: "9001",
      displayName: "Player",
      username: null
    });

    await tryAutoBindForDeterministicOwner(
      prisma,
      { workspaceId, crmContactId: contactPrivate, source: "CRM" },
      new TestDomain(prisma) as never
    );
    expect(prisma._state.standings).toHaveLength(1);
    expect(prisma._state.standings[0]?.totalPoints).toBe(0);
    // No leaderboardEvent table on this fake — standing upsert is the only write path.
    expect(prisma.leaderboardEvent).toBeUndefined();
  });
});
