import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { chicagoWallTimeToUtc, competitionWindowContaining } from "./competition-schedule";
import { DEFAULT_POOL_RATE_BPS } from "./leaderboard.constants";
import { LeaderboardError } from "./leaderboard.errors";
import { PrismaLeaderboardService } from "./leaderboard.prisma-service";
import { poolContributionCents } from "./points-math";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const staffActor = "staff111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const picassoId = "b1e1e379-82bf-494c-aa45-0de204e72209";
const otherContactId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type EventRow = {
  id: string;
  workspaceId: string;
  ownerCoadminUserId: string;
  competitionId: string;
  crmContactId: string;
  type: string;
  pointsDelta: number;
  depositAmountCents: number | null;
  poolContributionCents: number | null;
  poolRateBpsApplied: number | null;
  actorUserId: string | null;
  reason: string | null;
  metadataJson: unknown;
  occurredAt: Date;
  idempotencyKey: string;
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

/**
 * In-memory Prisma harness for recordDeposit transaction/audit timing.
 * Tracks interactive-tx open state so tests fail if audit runs inside the tx.
 */
function createDepositPrismaHarness(options?: { failStandingUpdate?: boolean }) {
  const now = chicagoWallTimeToUtc("2024-01-10T12:00:00");
  const window = competitionWindowContaining(now);
  const competitionId = "f9db36db-d526-47bb-8942-91e316e2cf19";

  const state = {
    contacts: [
      { id: picassoId, workspaceId, kind: "PRIVATE", telegramPeerId: "424747" },
      { id: otherContactId, workspaceId, kind: "PRIVATE", telegramPeerId: "999001" }
    ],
    participants: [
      { id: randomUUID(), workspaceId, ownerCoadminUserId: ownerA, crmContactId: picassoId },
      { id: randomUUID(), workspaceId, ownerCoadminUserId: ownerB, crmContactId: otherContactId }
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
      } satisfies CompetitionRow,
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
      } satisfies CompetitionRow
    ] as CompetitionRow[],
    standings: [
      {
        id: randomUUID(),
        workspaceId,
        ownerCoadminUserId: ownerA,
        competitionId,
        crmContactId: picassoId,
        qualifyingDepositCents: 0,
        depositPoints: 0,
        totalPoints: 0,
        referralPoints: 0,
        promotionPoints: 0,
        successfulReferralCount: 0,
        pointsReachedAt: now,
        lastEventId: null,
        lastEventAt: null,
        lastEventType: null,
        lastEventReason: null
      }
    ] as StandingRow[],
    events: [] as EventRow[],
    stats: [] as StatsRow[],
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
    referrals: [] as unknown[],
    lockOrder: [] as string[],
    txOpen: false,
    rootClientCallsDuringTx: 0
  };

  function snapshot() {
    return {
      events: structuredClone(state.events),
      standings: structuredClone(state.standings),
      competitions: structuredClone(state.competitions),
      stats: structuredClone(state.stats)
    };
  }

  function restore(snap: ReturnType<typeof snapshot>) {
    state.events = snap.events;
    state.standings = snap.standings;
    state.competitions = snap.competitions;
    state.stats = snap.stats;
  }

  function noteRootDuringTx() {
    if (state.txOpen) state.rootClientCallsDuringTx += 1;
  }

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
          where: { workspaceId: string; crmContactId?: string; ownerCoadminUserId?: string };
        }) =>
          state.participants.filter((p) => {
            if (p.workspaceId !== where.workspaceId) return false;
            if (where.crmContactId && p.crmContactId !== where.crmContactId) return false;
            if (where.ownerCoadminUserId && p.ownerCoadminUserId !== where.ownerCoadminUserId) return false;
            return true;
          })
      },
      leaderboardSettings: {
        upsert: async ({
          where,
          create
        }: {
          where: { ownerCoadminUserId: string };
          create: Omit<SettingsRow, "id">;
          update: Record<string, unknown>;
        }) => {
          const existing = state.settings.get(where.ownerCoadminUserId);
          if (existing) return existing;
          const row: SettingsRow = { id: randomUUID(), ...create };
          state.settings.set(where.ownerCoadminUserId, row);
          return row;
        },
        findUnique: async ({ where }: { where: { ownerCoadminUserId: string } }) =>
          state.settings.get(where.ownerCoadminUserId) ?? null
      },
      poolRateHistory: {
        findFirst: async ({ where }: { where: { ownerCoadminUserId: string } }) =>
          state.poolRateHistory.find((h) => h.ownerCoadminUserId === where.ownerCoadminUserId) ?? null,
        create: async ({ data }: { data: { workspaceId: string; ownerCoadminUserId: string; rateBps: number } }) => {
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
          const row: CompetitionRow = {
            id: randomUUID(),
            frozenAt: null,
            ...data
          };
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
          if (options?.failStandingUpdate) {
            throw new Error("IN_TX_STANDING_WRITE_FAILED");
          }
          const row = state.standings.find((s) => s.id === where.id);
          if (!row) throw new Error("standing missing");
          if (typeof data.qualifyingDepositCents === "number") row.qualifyingDepositCents = data.qualifyingDepositCents;
          if (typeof data.depositPoints === "number") row.depositPoints = data.depositPoints;
          if (data.totalPoints && typeof data.totalPoints === "object" && "increment" in (data.totalPoints as object)) {
            row.totalPoints += (data.totalPoints as { increment: number }).increment;
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
        count: async () => 0
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
          const row: StatsRow = {
            id: randomUUID(),
            updatedAt: new Date(),
            ...data
          };
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
        findUnique: async () => null
      },
      referralMilestoneAward: {
        findMany: async () => []
      },
      competitionSnapshot: {
        findUnique: async () => null
      },
      // Root-client surfaces used if AuditService (or a bug) escapes the tx client.
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

describe("PrismaLeaderboardService.recordDeposit transaction/audit", () => {
  it("Staff $1 deposit succeeds: event, points, pool, audit after commit, no timeout pattern", async () => {
    const prisma = createDepositPrismaHarness();
    const auditCalls: Array<{ duringTx: boolean; action: string; metadata: Record<string, unknown> }> = [];
    const service = new PrismaLeaderboardService(prisma, {
      audit: {
        record: async (input: {
          action: string;
          metadata?: Record<string, unknown>;
        }) => {
          auditCalls.push({
            duringTx: prisma._state.txOpen,
            action: input.action,
            metadata: input.metadata ?? {}
          });
        }
      } as never
    });

    const started = Date.now();
    const event = await service.recordDeposit({
      workspaceId,
      crmContactId: picassoId,
      amountCents: 100,
      actorUserId: staffActor,
      idempotencyKey: "f84cf5be-2bd5-47d8-ab75-edabbbcb807f",
      now: prisma._now
    });
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeLessThan(1000);
    expect(event.pointsDelta).toBe(1);
    expect(event.depositAmountCents).toBe(100);
    expect(event.poolContributionCents).toBe(poolContributionCents(100, DEFAULT_POOL_RATE_BPS));
    expect(event.ownerCoadminUserId).toBe(ownerA);
    expect(event.competitionId).toBe(prisma._competitionId);

    expect(prisma._state.events).toHaveLength(1);
    const standing = prisma._state.standings.find((s) => s.crmContactId === picassoId)!;
    expect(standing.depositPoints).toBe(1);
    expect(standing.totalPoints).toBe(1);
    expect(standing.qualifyingDepositCents).toBe(100);
    expect(standing.lastEventAt).not.toBeNull();

    const competition = prisma._state.competitions.find((c) => c.id === prisma._competitionId)!;
    expect(competition.prizePoolCents).toBe(poolContributionCents(100, DEFAULT_POOL_RATE_BPS));

    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]?.duringTx).toBe(false);
    expect(auditCalls[0]?.action).toBe("leaderboard.deposit");
    expect(auditCalls[0]?.metadata.eventId).toBe(event.id);
    expect(prisma._state.rootClientCallsDuringTx).toBe(0);

    // workspace → contact → competition
    expect(prisma._state.lockOrder[0]).toBe("workspace");
    expect(prisma._state.lockOrder).toContain("contact");
    expect(prisma._state.lockOrder.indexOf("workspace")).toBeLessThan(
      prisma._state.lockOrder.indexOf("contact")
    );
  });

  it("rolls back scoring writes when an in-transaction standing update fails", async () => {
    const prisma = createDepositPrismaHarness({ failStandingUpdate: true });
    const auditRecord = vi.fn(async () => undefined);
    const service = new PrismaLeaderboardService(prisma, {
      audit: { record: auditRecord } as never
    });

    await expect(
      service.recordDeposit({
        workspaceId,
        crmContactId: picassoId,
        amountCents: 100,
        actorUserId: staffActor,
        idempotencyKey: "dep-fail-in-tx",
        now: prisma._now
      })
    ).rejects.toThrow("IN_TX_STANDING_WRITE_FAILED");

    expect(prisma._state.events).toHaveLength(0);
    expect(prisma._state.standings[0]?.depositPoints).toBe(0);
    expect(prisma._state.competitions.find((c) => c.id === prisma._competitionId)?.prizePoolCents).toBe(0);
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it("keeps committed deposit when audit fails after commit", async () => {
    const prisma = createDepositPrismaHarness();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = new PrismaLeaderboardService(prisma, {
      audit: {
        record: async () => {
          throw new Error("AUDIT_BACKEND_DOWN");
        }
      } as never
    });

    const event = await service.recordDeposit({
      workspaceId,
      crmContactId: picassoId,
      amountCents: 100,
      actorUserId: staffActor,
      idempotencyKey: "dep-audit-fail",
      now: prisma._now
    });

    expect(event.pointsDelta).toBe(1);
    expect(prisma._state.events).toHaveLength(1);
    expect(prisma._state.standings[0]?.depositPoints).toBe(1);
    expect(prisma._state.competitions.find((c) => c.id === prisma._competitionId)?.prizePoolCents).toBe(
      poolContributionCents(100, DEFAULT_POOL_RATE_BPS)
    );
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("idempotency returns the same event without double-scoring", async () => {
    const prisma = createDepositPrismaHarness();
    const auditRecord = vi.fn(async () => undefined);
    const service = new PrismaLeaderboardService(prisma, {
      audit: { record: auditRecord } as never
    });

    const first = await service.recordDeposit({
      workspaceId,
      crmContactId: picassoId,
      amountCents: 100,
      actorUserId: staffActor,
      idempotencyKey: "dep-idem",
      now: prisma._now
    });
    const second = await service.recordDeposit({
      workspaceId,
      crmContactId: picassoId,
      amountCents: 100,
      actorUserId: staffActor,
      idempotencyKey: "dep-idem",
      now: prisma._now
    });

    expect(second.id).toBe(first.id);
    expect(prisma._state.events).toHaveLength(1);
    expect(prisma._state.standings[0]?.depositPoints).toBe(1);
    expect(prisma._state.competitions.find((c) => c.id === prisma._competitionId)?.prizePoolCents).toBe(
      poolContributionCents(100, DEFAULT_POOL_RATE_BPS)
    );
    // Audit only for the creating call
    expect(auditRecord).toHaveBeenCalledTimes(1);
  });

  it("does not leak Picasso deposit into Coadmin B competition", async () => {
    const prisma = createDepositPrismaHarness();
    const service = new PrismaLeaderboardService(prisma, {
      audit: { record: async () => undefined } as never
    });

    await service.recordDeposit({
      workspaceId,
      crmContactId: picassoId,
      amountCents: 100,
      actorUserId: staffActor,
      idempotencyKey: "dep-isolation",
      now: prisma._now
    });

    const ownerBComp = prisma._state.competitions.find((c) => c.ownerCoadminUserId === ownerB)!;
    expect(ownerBComp.prizePoolCents).toBe(0);
    expect(prisma._state.events.every((e) => e.ownerCoadminUserId === ownerA)).toBe(true);
    expect(prisma._state.standings.find((s) => s.crmContactId === picassoId)?.ownerCoadminUserId).toBe(ownerA);
  });

  it("rejects deposit when leaderboard is disabled", async () => {
    const prisma = createDepositPrismaHarness();
    prisma._state.settings.get(ownerA)!.enabled = false;
    const service = new PrismaLeaderboardService(prisma, {
      audit: { record: async () => undefined } as never
    });

    await expect(
      service.recordDeposit({
        workspaceId,
        crmContactId: picassoId,
        amountCents: 100,
        actorUserId: staffActor,
        idempotencyKey: "dep-disabled",
        now: prisma._now
      })
    ).rejects.toBeInstanceOf(LeaderboardError);

    expect(prisma._state.events).toHaveLength(0);
  });
});
