import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { chicagoWallTimeToUtc, competitionWindowContaining } from "./competition-schedule";
import { DEFAULT_POOL_RATE_BPS } from "./leaderboard.constants";
import { LeaderboardError } from "./leaderboard.errors";
import { PrismaLeaderboardService } from "./leaderboard.prisma-service";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const staffActor = "staff111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const referrerId = "b1e1e379-82bf-494c-aa45-0de204e72209";
const referredId = "d2e2e379-82bf-494c-aa45-0de204e72210";
const foreignId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type ReferralRow = {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  referrerCrmContactId: string;
  referredCrmContactId: string;
  createdByUserId: string | null;
  originalReferrerCrmContactId: string | null;
  overriddenAt: Date | null;
  overriddenByUserId: string | null;
  overrideReason: string | null;
};

type StandingRow = {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  competitionId: string;
  crmContactId: string;
  qualifyingDepositCents: number;
  depositPoints: number;
  totalPoints: number;
  referralPoints: number;
  promotionPoints: number;
  successfulReferralCount: number;
  pointsReachedAt: Date;
  lastEventId: string | null;
  lastEventAt: Date | null;
  lastEventType: string | null;
  lastEventReason: string | null;
};

type CompetitionRow = {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  sequence: number;
  startsAt: Date;
  endsAt: Date;
  status: string;
  prizePoolCents: number;
  frozenAt: Date | null;
};

type SettingsRow = {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  enabled: boolean;
  poolRateBps: number;
  timezone: string;
  updatedByUserId: string | null;
};

type StatsRow = {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  crmContactId: string;
  lifetimeQualifyingDepositCents: number;
  updatedAt: Date;
};

type EventRow = {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  competitionId: string;
  crmContactId: string;
  type: string;
  pointsDelta: number;
  actorUserId: string | null;
  reason: string | null;
  metadataJson: unknown;
  occurredAt: Date;
  idempotencyKey: string;
};

/**
 * In-memory Prisma harness for setReferral / overrideReferral transaction/audit timing.
 */
function createReferralPrismaHarness(options?: { failReferralCreate?: boolean }) {
  const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
  const window = competitionWindowContaining(now);
  const competitionId = "f9db36db-d526-47bb-8942-91e316e2cf19";

  const state = {
    contacts: [
      { id: referrerId, workspaceId, kind: "PRIVATE", telegramPeerId: "424747" },
      { id: referredId, workspaceId, kind: "PRIVATE", telegramPeerId: "424748" },
      { id: foreignId, workspaceId, kind: "PRIVATE", telegramPeerId: "999001" }
    ],
    participants: [
      { id: randomUUID(), workspaceId, ownerCoadminUserId: ownerA, crmContactId: referrerId },
      { id: randomUUID(), workspaceId, ownerCoadminUserId: ownerA, crmContactId: referredId },
      { id: randomUUID(), workspaceId, ownerCoadminUserId: ownerB, crmContactId: foreignId }
    ],
    settings: new Map<string, SettingsRow>([
      [
        ownerA,
        {
          id: randomUUID(),
          workspaceId,
          ownerCoadminUserId: ownerA,
          enabled: true,
          poolRateBps: DEFAULT_POOL_RATE_BPS,
          timezone: "America/Chicago",
          updatedByUserId: ownerA
        }
      ],
      [
        ownerB,
        {
          id: randomUUID(),
          workspaceId,
          ownerCoadminUserId: ownerB,
          enabled: true,
          poolRateBps: DEFAULT_POOL_RATE_BPS,
          timezone: "America/Chicago",
          updatedByUserId: ownerB
        }
      ]
    ]),
    competitions: [
      {
        id: competitionId,
        workspaceId,
        ownerCoadminUserId: ownerA,
        sequence: window.sequence,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        status: "ACTIVE",
        prizePoolCents: 0,
        frozenAt: null
      },
      {
        id: randomUUID(),
        workspaceId,
        ownerCoadminUserId: ownerB,
        sequence: window.sequence,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        status: "ACTIVE",
        prizePoolCents: 0,
        frozenAt: null
      }
    ] as CompetitionRow[],
    standings: [] as StandingRow[],
    events: [] as EventRow[],
    stats: [] as StatsRow[],
    referrals: [] as ReferralRow[],
    milestoneAwards: [] as Array<{
      id: string;
      referralId: string;
      milestoneCode: string;
      thresholdCents: number;
      points: number;
      status: string;
      awardEventId: string;
      competitionId: string;
    }>,
    poolRateHistory: [
      {
        id: randomUUID(),
        workspaceId,
        ownerCoadminUserId: ownerA,
        rateBps: DEFAULT_POOL_RATE_BPS
      },
      {
        id: randomUUID(),
        workspaceId,
        ownerCoadminUserId: ownerB,
        rateBps: DEFAULT_POOL_RATE_BPS
      }
    ],
    txOpen: false,
    rootClientCallsDuringTx: 0,
    lockOrder: [] as string[]
  };

  const snapshot = () => ({
    referrals: state.referrals.map((r) => ({ ...r })),
    events: state.events.map((e) => ({ ...e })),
    standings: state.standings.map((s) => ({ ...s })),
    stats: state.stats.map((s) => ({ ...s })),
    milestoneAwards: state.milestoneAwards.map((m) => ({ ...m })),
    competitions: state.competitions.map((c) => ({ ...c }))
  });

  const restore = (before: ReturnType<typeof snapshot>) => {
    state.referrals = before.referrals;
    state.events = before.events;
    state.standings = before.standings;
    state.stats = before.stats;
    state.milestoneAwards = before.milestoneAwards;
    state.competitions = before.competitions;
  };

  const noteRootDuringTx = () => {
    if (state.txOpen) state.rootClientCallsDuringTx += 1;
  };

  function createTxClient() {
    return {
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        if (sql.includes("workspaces")) state.lockOrder.push("workspace");
        else if (sql.includes("crm_contacts")) state.lockOrder.push("contact");
        else if (sql.includes("leaderboard_competitions")) state.lockOrder.push("competition");
        void values;
        return 1;
      },
      crmContact: {
        findFirst: async ({ where }: { where: { id: string; workspaceId: string } }) =>
          state.contacts.find((c) => c.id === where.id && c.workspaceId === where.workspaceId) ?? null
      },
      leaderboardParticipant: {
        findMany: async ({
          where
        }: {
          where: { workspaceId: string; crmContactId: string };
        }) =>
          state.participants.filter(
            (p) => p.workspaceId === where.workspaceId && p.crmContactId === where.crmContactId
          )
      },
      leaderboardSettings: {
        findUnique: async ({ where }: { where: { ownerCoadminUserId: string } }) =>
          state.settings.get(where.ownerCoadminUserId) ?? null,
        upsert: async ({
          where,
          create
        }: {
          where: { ownerCoadminUserId: string };
          create: SettingsRow;
          update: Partial<SettingsRow>;
        }) => {
          const existing = state.settings.get(where.ownerCoadminUserId);
          if (existing) return existing;
          const row = { ...create, id: create.id ?? randomUUID() };
          state.settings.set(where.ownerCoadminUserId, row);
          return row;
        }
      },
      poolRateHistory: {
        findFirst: async ({ where }: { where: { ownerCoadminUserId: string } }) =>
          state.poolRateHistory.find((h) => h.ownerCoadminUserId === where.ownerCoadminUserId) ?? null,
        create: async ({
          data
        }: {
          data: { workspaceId: string; ownerCoadminUserId: string; rateBps: number };
        }) => {
          const row = { id: randomUUID(), ...data };
          state.poolRateHistory.push(row);
          return row;
        }
      },
      leaderboardCompetition: {
        findMany: async ({
          where
        }: {
          where: {
            workspaceId?: string;
            ownerCoadminUserId?: string;
            status?: string;
            endsAt?: { lte: Date };
          };
        }) =>
          state.competitions.filter((c) => {
            if (where.workspaceId && c.workspaceId !== where.workspaceId) return false;
            if (where.ownerCoadminUserId && c.ownerCoadminUserId !== where.ownerCoadminUserId) return false;
            if (where.status && c.status !== where.status) return false;
            if (where.endsAt?.lte && !(c.endsAt <= where.endsAt.lte)) return false;
            return true;
          }),
        findUnique: async ({
          where
        }: {
          where: { id?: string; ownerCoadminUserId_sequence?: { ownerCoadminUserId: string; sequence: number } };
        }) => {
          if (where.id) return state.competitions.find((c) => c.id === where.id) ?? null;
          if (where.ownerCoadminUserId_sequence) {
            const key = where.ownerCoadminUserId_sequence;
            return (
              state.competitions.find(
                (c) => c.ownerCoadminUserId === key.ownerCoadminUserId && c.sequence === key.sequence
              ) ?? null
            );
          }
          return null;
        },
        findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
          const row = state.competitions.find((c) => c.id === where.id);
          if (!row) throw new Error("competition missing");
          return row;
        },
        findFirst: async ({
          where
        }: {
          where: {
            ownerCoadminUserId: string;
            status: string;
            startsAt: { lte: Date };
            endsAt: { gt: Date };
          };
        }) =>
          state.competitions.find(
            (c) =>
              c.ownerCoadminUserId === where.ownerCoadminUserId &&
              c.status === where.status &&
              c.startsAt <= where.startsAt.lte &&
              c.endsAt > where.endsAt.gt
          ) ?? null,
        create: async ({ data }: { data: Omit<CompetitionRow, "id" | "frozenAt"> & { frozenAt?: null } }) => {
          const row: CompetitionRow = { id: randomUUID(), frozenAt: null, ...data };
          state.competitions.push(row);
          return row;
        },
        update: async ({
          where,
          data
        }: {
          where: { id: string };
          data: Partial<CompetitionRow> & { prizePoolCents?: { increment: number } };
        }) => {
          const row = state.competitions.find((c) => c.id === where.id);
          if (!row) throw new Error("competition missing");
          if (data.prizePoolCents && typeof data.prizePoolCents === "object" && "increment" in data.prizePoolCents) {
            row.prizePoolCents += data.prizePoolCents.increment;
          }
          if (typeof data.status === "string") row.status = data.status;
          if (data.frozenAt !== undefined) row.frozenAt = data.frozenAt ?? null;
          return row;
        },
        updateMany: async () => ({ count: 0 })
      },
      leaderboardStanding: {
        upsert: async ({
          where,
          create
        }: {
          where: { competitionId_crmContactId: { competitionId: string; crmContactId: string } };
          create: {
            workspaceId: string;
            ownerCoadminUserId: string;
            competitionId: string;
            crmContactId: string;
            pointsReachedAt: Date;
          };
          update: Record<string, unknown>;
        }) => {
          const existing = state.standings.find(
            (s) =>
              s.competitionId === where.competitionId_crmContactId.competitionId &&
              s.crmContactId === where.competitionId_crmContactId.crmContactId
          );
          if (existing) return existing;
          const row: StandingRow = {
            id: randomUUID(),
            qualifyingDepositCents: 0,
            depositPoints: 0,
            totalPoints: 0,
            referralPoints: 0,
            promotionPoints: 0,
            successfulReferralCount: 0,
            lastEventId: null,
            lastEventAt: null,
            lastEventType: null,
            lastEventReason: null,
            ...create
          };
          state.standings.push(row);
          return row;
        },
        update: async ({
          where,
          data
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = state.standings.find((s) => s.id === where.id);
          if (!row) throw new Error("standing missing");
          if (data.referralPoints && typeof data.referralPoints === "object" && "increment" in (data.referralPoints as object)) {
            row.referralPoints += (data.referralPoints as { increment: number }).increment;
          }
          if (data.totalPoints && typeof data.totalPoints === "object" && "increment" in (data.totalPoints as object)) {
            row.totalPoints += (data.totalPoints as { increment: number }).increment;
          }
          if (data.successfulReferralCount && typeof data.successfulReferralCount === "object") {
            const op = data.successfulReferralCount as { increment?: number; decrement?: number };
            if (op.increment) row.successfulReferralCount += op.increment;
            if (op.decrement) row.successfulReferralCount -= op.decrement;
          }
          if (data.pointsReachedAt instanceof Date) row.pointsReachedAt = data.pointsReachedAt;
          if (typeof data.lastEventId === "string") row.lastEventId = data.lastEventId;
          if (data.lastEventAt instanceof Date) row.lastEventAt = data.lastEventAt;
          if (typeof data.lastEventType === "string") row.lastEventType = data.lastEventType;
          if (typeof data.lastEventReason === "string") row.lastEventReason = data.lastEventReason;
          return row;
        },
        findMany: async ({ where }: { where: { competitionId: string } }) =>
          state.standings.filter((s) => s.competitionId === where.competitionId),
        createMany: async () => ({ count: 0 })
      },
      leaderboardEvent: {
        findUnique: async ({ where }: { where: { idempotencyKey?: string; id?: string } }) => {
          if (where.idempotencyKey) {
            return state.events.find((e) => e.idempotencyKey === where.idempotencyKey) ?? null;
          }
          if (where.id) return state.events.find((e) => e.id === where.id) ?? null;
          return null;
        },
        create: async ({ data }: { data: Omit<EventRow, "id"> }) => {
          const row: EventRow = { id: randomUUID(), ...data };
          state.events.push(row);
          return row;
        },
        count: async ({
          where
        }: {
          where?: { type?: string; metadataJson?: unknown };
        } = {}) => {
          if (!where) return state.events.length;
          return state.events.filter((e) => (where.type ? e.type === where.type : true)).length;
        }
      },
      leaderboardPlayerStats: {
        findUnique: async ({
          where
        }: {
          where: { ownerCoadminUserId_crmContactId: { ownerCoadminUserId: string; crmContactId: string } };
        }) => {
          const key = where.ownerCoadminUserId_crmContactId;
          return (
            state.stats.find(
              (s) => s.ownerCoadminUserId === key.ownerCoadminUserId && s.crmContactId === key.crmContactId
            ) ?? null
          );
        },
        create: async ({
          data
        }: {
          data: {
            workspaceId: string;
            ownerCoadminUserId: string;
            crmContactId: string;
            lifetimeQualifyingDepositCents: number;
          };
        }) => {
          const row: StatsRow = { id: randomUUID(), updatedAt: new Date(), ...data };
          state.stats.push(row);
          return row;
        },
        update: async ({
          where,
          data
        }: {
          where: { id: string };
          data: { lifetimeQualifyingDepositCents: number; updatedAt: Date };
        }) => {
          const row = state.stats.find((s) => s.id === where.id);
          if (!row) throw new Error("stats missing");
          row.lifetimeQualifyingDepositCents = data.lifetimeQualifyingDepositCents;
          row.updatedAt = data.updatedAt;
          return row;
        }
      },
      leaderboardReferral: {
        findUnique: async ({
          where
        }: {
          where: {
            id?: string;
            ownerCoadminUserId_referredCrmContactId?: {
              ownerCoadminUserId: string;
              referredCrmContactId: string;
            };
          };
        }) => {
          if (where.id) return state.referrals.find((r) => r.id === where.id) ?? null;
          if (where.ownerCoadminUserId_referredCrmContactId) {
            const key = where.ownerCoadminUserId_referredCrmContactId;
            return (
              state.referrals.find(
                (r) =>
                  r.ownerCoadminUserId === key.ownerCoadminUserId &&
                  r.referredCrmContactId === key.referredCrmContactId
              ) ?? null
            );
          }
          return null;
        },
        create: async ({
          data
        }: {
          data: {
            workspaceId: string;
            ownerCoadminUserId: string;
            referrerCrmContactId: string;
            referredCrmContactId: string;
            createdByUserId: string | null;
            originalReferrerCrmContactId: string;
          };
        }) => {
          if (options?.failReferralCreate) {
            throw new Error("IN_TX_REFERRAL_WRITE_FAILED");
          }
          if (
            state.referrals.some(
              (r) =>
                r.ownerCoadminUserId === data.ownerCoadminUserId &&
                r.referredCrmContactId === data.referredCrmContactId
            )
          ) {
            const err = new Error("Unique") as Error & { code: string };
            err.code = "P2002";
            throw err;
          }
          const row: ReferralRow = {
            id: randomUUID(),
            overriddenAt: null,
            overriddenByUserId: null,
            overrideReason: null,
            ...data
          };
          state.referrals.push(row);
          return row;
        },
        update: async ({
          where,
          data
        }: {
          where: { id: string };
          data: Partial<ReferralRow>;
        }) => {
          const row = state.referrals.find((r) => r.id === where.id);
          if (!row) throw new Error("referral missing");
          Object.assign(row, data);
          return row;
        }
      },
      referralMilestoneAward: {
        findMany: async ({ where }: { where: { referralId: string; status?: string } }) =>
          state.milestoneAwards.filter(
            (m) => m.referralId === where.referralId && (!where.status || m.status === where.status)
          ),
        create: async ({
          data
        }: {
          data: {
            referralId: string;
            milestoneCode: string;
            thresholdCents: number;
            points: number;
            status: string;
            awardEventId: string;
            competitionId: string;
            workspaceId?: string;
            ownerCoadminUserId?: string;
            generation?: number;
          };
        }) => {
          const row = { id: randomUUID(), ...data };
          state.milestoneAwards.push(row);
          return row;
        },
        update: async ({
          where,
          data
        }: {
          where: { id: string };
          data: { status: string };
        }) => {
          const row = state.milestoneAwards.find((m) => m.id === where.id);
          if (!row) throw new Error("award missing");
          row.status = data.status;
          return row;
        },
        count: async ({
          where
        }: {
          where: { referralId: string; milestoneCode?: string };
        }) =>
          state.milestoneAwards.filter(
            (m) =>
              m.referralId === where.referralId &&
              (!where.milestoneCode || m.milestoneCode === where.milestoneCode)
          ).length
      },
      competitionSnapshot: {
        findUnique: async () => null
      },
      auditLog: {
        create: async () => {
          noteRootDuringTx();
          return { id: randomUUID() };
        }
      }
    };
  }

  const prisma = {
    ...createTxClient(),
    $transaction: async <T>(fn: (tx: ReturnType<typeof createTxClient>) => Promise<T>) => {
      const before = snapshot();
      state.txOpen = true;
      state.lockOrder = [];
      try {
        const result = await fn(createTxClient());
        state.txOpen = false;
        return result;
      } catch (error) {
        restore(before);
        state.txOpen = false;
        throw error;
      }
    },
    _state: state,
    _now: now,
    _competitionId: competitionId
  };

  return prisma as unknown as PrismaClient & {
    _state: typeof state;
    _now: Date;
    _competitionId: string;
  };
}

describe("PrismaLeaderboardService.setReferral transaction/audit", () => {
  it("links referral successfully with audit after commit (no timeout pattern)", async () => {
    const prisma = createReferralPrismaHarness();
    const auditCalls: Array<{ duringTx: boolean; action: string; metadata: Record<string, unknown> }> = [];
    const service = new PrismaLeaderboardService(prisma, {
      audit: {
        record: async (input: { action: string; metadata?: Record<string, unknown> }) => {
          auditCalls.push({
            duringTx: prisma._state.txOpen,
            action: input.action,
            metadata: input.metadata ?? {}
          });
        }
      } as never
    });

    const started = Date.now();
    const row = await service.setReferral({
      workspaceId,
      referrerCrmContactId: referrerId,
      referredCrmContactId: referredId,
      actorUserId: staffActor,
      idempotencyKey: "ref-link-1",
      now: prisma._now
    });
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeLessThan(1000);
    expect(row.referrerCrmContactId).toBe(referrerId);
    expect(row.referredCrmContactId).toBe(referredId);
    expect(row.ownerCoadminUserId).toBe(ownerA);
    expect(prisma._state.referrals).toHaveLength(1);
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]?.duringTx).toBe(false);
    expect(auditCalls[0]?.action).toBe("leaderboard.referral_set");
    expect(auditCalls[0]?.metadata.referralId).toBe(row.id);
    expect(prisma._state.rootClientCallsDuringTx).toBe(0);
  });

  it("rejects self-referral", async () => {
    const prisma = createReferralPrismaHarness();
    const service = new PrismaLeaderboardService(prisma, {
      audit: { record: vi.fn(async () => undefined) } as never
    });
    await expect(
      service.setReferral({
        workspaceId,
        referrerCrmContactId: referrerId,
        referredCrmContactId: referrerId,
        actorUserId: staffActor,
        idempotencyKey: "ref-self",
        now: prisma._now
      })
    ).rejects.toMatchObject({ code: "SELF_REFERRAL_FORBIDDEN" } satisfies Partial<LeaderboardError>);
    expect(prisma._state.referrals).toHaveLength(0);
  });

  it("rejects duplicate referral", async () => {
    const prisma = createReferralPrismaHarness();
    const service = new PrismaLeaderboardService(prisma, {
      audit: { record: vi.fn(async () => undefined) } as never
    });
    await service.setReferral({
      workspaceId,
      referrerCrmContactId: referrerId,
      referredCrmContactId: referredId,
      actorUserId: staffActor,
      idempotencyKey: "ref-dup-1",
      now: prisma._now
    });
    await expect(
      service.setReferral({
        workspaceId,
        referrerCrmContactId: referrerId,
        referredCrmContactId: referredId,
        actorUserId: staffActor,
        idempotencyKey: "ref-dup-2",
        now: prisma._now
      })
    ).rejects.toMatchObject({ code: "REFERRAL_ALREADY_EXISTS" } satisfies Partial<LeaderboardError>);
    expect(prisma._state.referrals).toHaveLength(1);
  });

  it("rejects cross-Coadmin referral", async () => {
    const prisma = createReferralPrismaHarness();
    const service = new PrismaLeaderboardService(prisma, {
      audit: { record: vi.fn(async () => undefined) } as never
    });
    await expect(
      service.setReferral({
        workspaceId,
        referrerCrmContactId: referrerId,
        referredCrmContactId: foreignId,
        actorUserId: staffActor,
        idempotencyKey: "ref-cross",
        now: prisma._now
      })
    ).rejects.toMatchObject({ code: "OWNER_MISMATCH" } satisfies Partial<LeaderboardError>);
    expect(prisma._state.referrals).toHaveLength(0);
  });

  it("rolls back when in-transaction create fails (no referral, no audit)", async () => {
    const prisma = createReferralPrismaHarness({ failReferralCreate: true });
    const auditRecord = vi.fn(async () => undefined);
    const service = new PrismaLeaderboardService(prisma, {
      audit: { record: auditRecord } as never
    });
    await expect(
      service.setReferral({
        workspaceId,
        referrerCrmContactId: referrerId,
        referredCrmContactId: referredId,
        actorUserId: staffActor,
        idempotencyKey: "ref-fail-tx",
        now: prisma._now
      })
    ).rejects.toThrow(/IN_TX_REFERRAL_WRITE_FAILED/);
    expect(prisma._state.referrals).toHaveLength(0);
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it("keeps referral committed when audit fails after commit", async () => {
    const prisma = createReferralPrismaHarness();
    const service = new PrismaLeaderboardService(prisma, {
      audit: {
        record: async () => {
          throw new Error("AUDIT_WRITE_FAILED");
        }
      } as never
    });
    const row = await service.setReferral({
      workspaceId,
      referrerCrmContactId: referrerId,
      referredCrmContactId: referredId,
      actorUserId: staffActor,
      idempotencyKey: "ref-audit-fail",
      now: prisma._now
    });
    expect(row.id).toBeTruthy();
    expect(prisma._state.referrals).toHaveLength(1);
  });

  it("syncs milestones when referred player already has lifetime deposits", async () => {
    const prisma = createReferralPrismaHarness();
    prisma._state.stats.push({
      id: randomUUID(),
      workspaceId,
      ownerCoadminUserId: ownerA,
      crmContactId: referredId,
      lifetimeQualifyingDepositCents: 1000,
      updatedAt: new Date()
    });
    const service = new PrismaLeaderboardService(prisma, {
      audit: { record: vi.fn(async () => undefined) } as never
    });
    await service.setReferral({
      workspaceId,
      referrerCrmContactId: referrerId,
      referredCrmContactId: referredId,
      actorUserId: staffActor,
      idempotencyKey: "ref-milestone",
      now: prisma._now
    });
    expect(prisma._state.referrals).toHaveLength(1);
    expect(prisma._state.milestoneAwards.length).toBeGreaterThan(0);
    expect(prisma._state.events.some((e) => e.type === "REFERRAL_MILESTONE")).toBe(true);
  });

  it("overrideReferral updates referrer with audit after commit", async () => {
    const prisma = createReferralPrismaHarness();
    const auditCalls: string[] = [];
    const service = new PrismaLeaderboardService(prisma, {
      audit: {
        record: async (input: { action: string }) => {
          expect(prisma._state.txOpen).toBe(false);
          auditCalls.push(input.action);
        }
      } as never
    });

    await service.setReferral({
      workspaceId,
      referrerCrmContactId: referrerId,
      referredCrmContactId: referredId,
      actorUserId: staffActor,
      idempotencyKey: "ref-before-override",
      now: prisma._now
    });

    // Add a second eligible referrer on same owner.
    const altReferrer = "e3e3e379-82bf-494c-aa45-0de204e72211";
    prisma._state.contacts.push({
      id: altReferrer,
      workspaceId,
      kind: "PRIVATE",
      telegramPeerId: "424749"
    });
    prisma._state.participants.push({
      id: randomUUID(),
      workspaceId,
      ownerCoadminUserId: ownerA,
      crmContactId: altReferrer
    });

    const started = Date.now();
    const updated = await service.overrideReferral({
      workspaceId,
      referredCrmContactId: referredId,
      newReferrerCrmContactId: altReferrer,
      actorUserId: staffActor,
      reason: "staff correction",
      idempotencyKey: "ref-override-1",
      now: prisma._now
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(updated.referrerCrmContactId).toBe(altReferrer);
    expect(auditCalls).toEqual(["leaderboard.referral_set", "leaderboard.referral_override"]);
  });
});

describe("LeaderboardApiService.setReferral telegram projection", () => {
  it("projects standings / outbox after successful referral (not on domain failure)", async () => {
    const { LeaderboardApiService } = await import("./leaderboard.api-service");
    type RequestUser = import("../auth/auth.types").RequestUser;
    const staffUser = {
      id: staffActor,
      role: "STAFF",
      workspaceId
    } as RequestUser;

    const projectCalls: string[] = [];
    const service = new LeaderboardApiService({
      prisma: {
        workspace: {
          findUnique: async () => ({ primaryCoadminId: ownerA })
        },
        leaderboardCompetition: {
          findFirst: async () => null
        }
      },
      log: { warn: () => undefined }
    } as never);

    (service as unknown as { domain: Record<string, unknown> }).domain = {
      resolveLeaderboardOwner: async (_ws: string, crmContactId: string) => {
        if (crmContactId === foreignId) return ownerB;
        return ownerA;
      },
      setReferral: async () => ({
        id: randomUUID(),
        referrerCrmContactId: referrerId,
        referredCrmContactId: referredId
      })
    };
    (service as unknown as { assertActorMayMutatePlayer: () => Promise<void> }).assertActorMayMutatePlayer =
      async () => undefined;
    (service as unknown as {
      projectStandingsForOwner: (ws: string, owner: string) => Promise<void>;
    }).projectStandingsForOwner = async (_ws, owner) => {
      projectCalls.push(owner);
    };
    (service as unknown as {
      enqueueRecentReferralMilestoneDms: () => Promise<void>;
    }).enqueueRecentReferralMilestoneDms = async () => undefined;

    await service.setReferral(staffUser, {
      referrerCrmContactId: referrerId,
      referredCrmContactId: referredId,
      idempotencyKey: "api-ref-1"
    });
    expect(projectCalls).toEqual([ownerA]);

    projectCalls.length = 0;
    (service as unknown as { domain: { setReferral: () => Promise<never> } }).domain.setReferral = async () => {
      throw new Error("DOMAIN_REFERRAL_FAILED");
    };
    await expect(
      service.setReferral(staffUser, {
        referrerCrmContactId: referrerId,
        referredCrmContactId: referredId,
        idempotencyKey: "api-ref-fail"
      })
    ).rejects.toThrow(/DOMAIN_REFERRAL_FAILED/);
    expect(projectCalls).toHaveLength(0);
  });
});
