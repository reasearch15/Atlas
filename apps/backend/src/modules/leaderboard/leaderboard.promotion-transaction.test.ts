import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { chicagoWallTimeToUtc, competitionWindowContaining } from "./competition-schedule";
import { DEFAULT_POOL_RATE_BPS } from "./leaderboard.constants";
import { PrismaLeaderboardService } from "./leaderboard.prisma-service";
import { createFixedRandomSource } from "./promotion-points";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const staffActor = "staff111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const playerId = "b1e1e379-82bf-494c-aa45-0de204e72209";

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
  reversesEventId?: string | null;
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

type AwardRow = {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  competitionId: string;
  crmContactId: string;
  points: number;
  eventId: string;
  actorUserId: string | null;
  idempotencyKey: string;
  createdAt: Date;
};

/**
 * In-memory harness for promotion / reversePromotion / freeze audit timing.
 */
function createPromotionPrismaHarness(options?: {
  failStandingUpdate?: boolean;
  expiredCompetition?: boolean;
}) {
  const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
  const window = competitionWindowContaining(now);
  const competitionId = "f9db36db-d526-47bb-8942-91e316e2cf19";
  const expiredId = "e9db36db-d526-47bb-8942-91e316e2cf20";

  const competitions: CompetitionRow[] = options?.expiredCompetition
    ? [
        {
          id: expiredId,
          workspaceId,
          ownerCoadminUserId: ownerA,
          sequence: window.sequence - 1,
          startsAt: new Date(window.startsAt.getTime() - 14 * 24 * 60 * 60 * 1000),
          endsAt: new Date(now.getTime() - 60_000),
          status: "ACTIVE",
          prizePoolCents: 500,
          frozenAt: null
        }
      ]
    : [
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
        }
      ];

  const state = {
    contacts: [{ id: playerId, workspaceId, kind: "PRIVATE", telegramPeerId: "424747" }],
    participants: [
      { id: randomUUID(), workspaceId, ownerCoadminUserId: ownerA, crmContactId: playerId }
    ],
    settings: new Map([
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
      ]
    ]),
    poolRateHistory: [
      { id: randomUUID(), workspaceId, ownerCoadminUserId: ownerA, rateBps: DEFAULT_POOL_RATE_BPS }
    ],
    competitions,
    standings: [] as StandingRow[],
    events: [] as EventRow[],
    awards: [] as AwardRow[],
    snapshots: [] as Array<{ competitionId: string }>,
    eligibility: [] as Array<{ competitionId: string; crmContactId: string }>,
    txOpen: false,
    rootClientCallsDuringTx: 0,
    lockOrder: [] as string[]
  };

  const snapshot = () => ({
    events: state.events.map((e) => ({ ...e })),
    awards: state.awards.map((a) => ({ ...a })),
    standings: state.standings.map((s) => ({ ...s })),
    competitions: state.competitions.map((c) => ({ ...c })),
    snapshots: state.snapshots.map((s) => ({ ...s })),
    eligibility: state.eligibility.map((e) => ({ ...e }))
  });

  const restore = (before: ReturnType<typeof snapshot>) => {
    state.events = before.events;
    state.awards = before.awards;
    state.standings = before.standings;
    state.competitions = before.competitions;
    state.snapshots = before.snapshots;
    state.eligibility = before.eligibility;
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
          create: {
            workspaceId: string;
            ownerCoadminUserId: string;
            enabled: boolean;
            poolRateBps: number;
            timezone: string;
            updatedByUserId: string | null;
          };
        }) => {
          const existing = state.settings.get(where.ownerCoadminUserId);
          if (existing) return existing;
          const row = { id: randomUUID(), ...create };
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
          data: Partial<CompetitionRow>;
        }) => {
          const row = state.competitions.find((c) => c.id === where.id);
          if (!row) throw new Error("competition missing");
          if (typeof data.status === "string") row.status = data.status;
          if (data.frozenAt !== undefined) row.frozenAt = data.frozenAt ?? null;
          return row;
        },
        updateMany: async ({
          where,
          data
        }: {
          where: { id: string; status?: string };
          data: Partial<CompetitionRow>;
        }) => {
          const row = state.competitions.find((c) => c.id === where.id);
          if (!row) return { count: 0 };
          if (where.status && row.status !== where.status) return { count: 0 };
          if (typeof data.status === "string") row.status = data.status;
          if (data.frozenAt !== undefined) row.frozenAt = data.frozenAt ?? null;
          return { count: 1 };
        }
      },
      leaderboardStanding: {
        findMany: async ({ where }: { where: { competitionId: string } }) =>
          state.standings.filter((s) => s.competitionId === where.competitionId),
        createMany: async () => ({ count: 0 }),
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
          if (options?.failStandingUpdate) {
            throw new Error("IN_TX_STANDING_UPDATE_FAILED");
          }
          const row = state.standings.find((s) => s.id === where.id);
          if (!row) throw new Error("standing missing");
          if (data.promotionPoints && typeof data.promotionPoints === "object") {
            const op = data.promotionPoints as { increment?: number; decrement?: number };
            if (op.increment) row.promotionPoints += op.increment;
            if (op.decrement) row.promotionPoints -= op.decrement;
          }
          if (data.totalPoints && typeof data.totalPoints === "object") {
            const op = data.totalPoints as { increment?: number };
            if (op.increment) row.totalPoints += op.increment;
          }
          if (data.pointsReachedAt instanceof Date) row.pointsReachedAt = data.pointsReachedAt;
          if (typeof data.lastEventId === "string") row.lastEventId = data.lastEventId;
          if (data.lastEventAt instanceof Date) row.lastEventAt = data.lastEventAt;
          if (typeof data.lastEventType === "string") row.lastEventType = data.lastEventType;
          if (typeof data.lastEventReason === "string") row.lastEventReason = data.lastEventReason;
          return row;
        }
      },
      leaderboardEvent: {
        findUnique: async ({ where }: { where: { idempotencyKey?: string; id?: string } }) => {
          if (where.idempotencyKey) {
            return state.events.find((e) => e.idempotencyKey === where.idempotencyKey) ?? null;
          }
          if (where.id) return state.events.find((e) => e.id === where.id) ?? null;
          return null;
        },
        findFirst: async ({
          where
        }: {
          where: { id?: string; workspaceId?: string; reversesEventId?: string };
        }) => {
          if (where.reversesEventId) {
            return state.events.find((e) => e.reversesEventId === where.reversesEventId) ?? null;
          }
          if (where.id) {
            return (
              state.events.find(
                (e) => e.id === where.id && (!where.workspaceId || e.workspaceId === where.workspaceId)
              ) ?? null
            );
          }
          return null;
        },
        create: async ({ data }: { data: Omit<EventRow, "id"> }) => {
          const row: EventRow = { id: randomUUID(), ...data };
          state.events.push(row);
          return row;
        },
        count: async () => state.events.length
      },
      promotionAward: {
        findMany: async ({
          where
        }: {
          where: { ownerCoadminUserId: string; crmContactId: string };
        }) =>
          state.awards.filter(
            (a) =>
              a.ownerCoadminUserId === where.ownerCoadminUserId && a.crmContactId === where.crmContactId
          ),
        create: async ({ data }: { data: Omit<AwardRow, "id"> }) => {
          const row: AwardRow = { id: randomUUID(), ...data };
          state.awards.push(row);
          return row;
        }
      },
      competitionSnapshot: {
        findUnique: async ({ where }: { where: { competitionId: string } }) =>
          state.snapshots.find((s) => s.competitionId === where.competitionId) ?? null,
        create: async ({ data }: { data: { competitionId: string } }) => {
          state.snapshots.push({ competitionId: data.competitionId });
          return data;
        }
      },
      giveawayEligibilityCandidate: {
        create: async ({
          data
        }: {
          data: { competitionId: string; crmContactId: string };
        }) => {
          state.eligibility.push({
            competitionId: data.competitionId,
            crmContactId: data.crmContactId
          });
          return data;
        }
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
    _competitionId: competitionId,
    _expiredId: expiredId
  };

  return prisma as unknown as PrismaClient & {
    _state: typeof state;
    _now: Date;
    _competitionId: string;
    _expiredId: string;
  };
}

describe("PrismaLeaderboardService.recordPromotion transaction/audit", () => {
  it("records promotion with audit after commit (no timeout pattern)", async () => {
    const prisma = createPromotionPrismaHarness();
    const auditCalls: Array<{ duringTx: boolean; action: string }> = [];
    const service = new PrismaLeaderboardService(prisma, {
      random: createFixedRandomSource([2, 2, 2]),
      audit: {
        record: async (input: { action: string }) => {
          auditCalls.push({ duringTx: prisma._state.txOpen, action: input.action });
        }
      } as never
    });

    const started = Date.now();
    const event = await service.recordPromotion({
      workspaceId,
      crmContactId: playerId,
      actorUserId: staffActor,
      idempotencyKey: "promo-1",
      now: prisma._now
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(event.type).toBe("PROMOTION");
    expect(event.pointsDelta).toBe(2);
    expect(prisma._state.events).toHaveLength(1);
    expect(prisma._state.awards).toHaveLength(1);
    const standing = prisma._state.standings.find((s) => s.crmContactId === playerId)!;
    expect(standing.promotionPoints).toBe(2);
    expect(standing.totalPoints).toBe(2);
    expect(auditCalls).toEqual([{ duringTx: false, action: "leaderboard.promotion" }]);
    expect(prisma._state.rootClientCallsDuringTx).toBe(0);
  });

  it("idempotent replay does not double-award or re-audit", async () => {
    const prisma = createPromotionPrismaHarness();
    const auditRecord = vi.fn(async () => undefined);
    const service = new PrismaLeaderboardService(prisma, {
      random: createFixedRandomSource([3, 3, 3]),
      audit: { record: auditRecord } as never
    });
    const first = await service.recordPromotion({
      workspaceId,
      crmContactId: playerId,
      actorUserId: staffActor,
      idempotencyKey: "promo-idem",
      now: prisma._now
    });
    const second = await service.recordPromotion({
      workspaceId,
      crmContactId: playerId,
      actorUserId: staffActor,
      idempotencyKey: "promo-idem",
      now: prisma._now
    });
    expect(second.id).toBe(first.id);
    expect(prisma._state.events).toHaveLength(1);
    expect(prisma._state.awards).toHaveLength(1);
    expect(prisma._state.standings[0]?.promotionPoints).toBe(3);
    expect(auditRecord).toHaveBeenCalledTimes(1);
  });

  it("keeps promotion committed when audit fails after commit", async () => {
    const prisma = createPromotionPrismaHarness();
    const service = new PrismaLeaderboardService(prisma, {
      random: createFixedRandomSource([1]),
      audit: {
        record: async () => {
          throw new Error("AUDIT_WRITE_FAILED");
        }
      } as never
    });
    const event = await service.recordPromotion({
      workspaceId,
      crmContactId: playerId,
      actorUserId: staffActor,
      idempotencyKey: "promo-audit-fail",
      now: prisma._now
    });
    expect(event.id).toBeTruthy();
    expect(prisma._state.events).toHaveLength(1);
    expect(prisma._state.awards).toHaveLength(1);
    expect(prisma._state.standings[0]?.promotionPoints).toBe(1);
  });

  it("rolls back when in-transaction standing update fails", async () => {
    const prisma = createPromotionPrismaHarness({ failStandingUpdate: true });
    const auditRecord = vi.fn(async () => undefined);
    const service = new PrismaLeaderboardService(prisma, {
      random: createFixedRandomSource([2]),
      audit: { record: auditRecord } as never
    });
    await expect(
      service.recordPromotion({
        workspaceId,
        crmContactId: playerId,
        actorUserId: staffActor,
        idempotencyKey: "promo-fail-tx",
        now: prisma._now
      })
    ).rejects.toThrow(/IN_TX_STANDING_UPDATE_FAILED/);
    expect(prisma._state.events).toHaveLength(0);
    expect(prisma._state.awards).toHaveLength(0);
    expect(prisma._state.standings).toHaveLength(0);
    expect(auditRecord).not.toHaveBeenCalled();
  });
});

describe("PrismaLeaderboardService.reversePromotion transaction/audit", () => {
  it("reverses promotion with audit after commit", async () => {
    const prisma = createPromotionPrismaHarness();
    const auditCalls: string[] = [];
    const service = new PrismaLeaderboardService(prisma, {
      random: createFixedRandomSource([2]),
      audit: {
        record: async (input: { action: string }) => {
          expect(prisma._state.txOpen).toBe(false);
          auditCalls.push(input.action);
        }
      } as never
    });
    const promo = await service.recordPromotion({
      workspaceId,
      crmContactId: playerId,
      actorUserId: staffActor,
      idempotencyKey: "promo-before-rev",
      now: prisma._now
    });
    const rev = await service.reversePromotion({
      workspaceId,
      promotionEventId: promo.id,
      actorUserId: staffActor,
      idempotencyKey: "promo-rev-1",
      now: prisma._now
    });
    expect(rev.type).toBe("PROMOTION_REVERSAL");
    expect(rev.pointsDelta).toBe(-2);
    expect(prisma._state.standings[0]?.promotionPoints).toBe(0);
    expect(prisma._state.standings[0]?.totalPoints).toBe(0);
    expect(auditCalls).toEqual(["leaderboard.promotion", "leaderboard.promotion_reversal"]);
  });
});

describe("freezeCompetitionTx audit timing", () => {
  it("freezes expired competition without root audit while tx is open", async () => {
    const prisma = createPromotionPrismaHarness({ expiredCompetition: true });
    const auditCalls: Array<{ duringTx: boolean; action: string }> = [];
    const service = new PrismaLeaderboardService(prisma, {
      audit: {
        record: async (input: { action: string }) => {
          auditCalls.push({ duringTx: prisma._state.txOpen, action: input.action });
        }
      } as never
    });

    await service.ensureCurrentCompetition(workspaceId, ownerA, prisma._now);
    const expired = prisma._state.competitions.find((c) => c.id === prisma._expiredId)!;
    expect(expired.status).toBe("FROZEN");
    expect(auditCalls.some((c) => c.action === "leaderboard.competition_frozen")).toBe(true);
    expect(auditCalls.every((c) => c.duringTx === false)).toBe(true);
    expect(prisma._state.rootClientCallsDuringTx).toBe(0);
  });
});
