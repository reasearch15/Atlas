import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { competitionWindowContaining } from "./competition-schedule";
import { PrismaLeaderboardService } from "./leaderboard.prisma-service";

/**
 * Regression coverage for the leaderboard finalization deadlock: automatic
 * ACTIVE -> FROZEN must always commit on its own (even with every candidate
 * PENDING_REVIEW), onFrozen must fire only after that commit, and FROZEN ->
 * FINALIZED must be a separate, retryable, idempotent operation that never rolls
 * back a freeze.
 *
 * This harness is a hand-rolled fake Prisma client (mirrors the style already
 * used in leaderboard.promotion-transaction.test.ts) so these tests exercise the
 * real PrismaLeaderboardService transaction/orchestration code, not a mock of it.
 */

const workspaceId = "11111111-1111-4111-8111-111111111111";
const ownerA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ownerB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const staffActor = "staff111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const now = new Date("2026-09-23T02:05:00.000Z");

type Row = Record<string, unknown>;

function createLifecyclePrisma() {
  const state = {
    settings: new Map<string, Row>(),
    poolRateHistory: [] as Row[],
    competitions: [] as Row[],
    standings: [] as Row[],
    snapshots: [] as Row[],
    eligibility: [] as Row[],
    payouts: [] as Row[],
    bonusAwards: [] as Row[],
    freeplayClaims: [] as Row[],
    throwOnLockCompetitionId: new Set<string>()
  };

  function snapshotState() {
    return {
      settings: new Map(state.settings),
      poolRateHistory: state.poolRateHistory.map((r) => ({ ...r })),
      competitions: state.competitions.map((r) => ({ ...r })),
      standings: state.standings.map((r) => ({ ...r })),
      snapshots: state.snapshots.map((r) => ({ ...r })),
      eligibility: state.eligibility.map((r) => ({ ...r })),
      payouts: state.payouts.map((r) => ({ ...r })),
      bonusAwards: state.bonusAwards.map((r) => ({ ...r })),
      freeplayClaims: state.freeplayClaims.map((r) => ({ ...r }))
    };
  }

  function restoreState(before: ReturnType<typeof snapshotState>) {
    state.settings = before.settings;
    state.poolRateHistory = before.poolRateHistory;
    state.competitions = before.competitions;
    state.standings = before.standings;
    state.snapshots = before.snapshots;
    state.eligibility = before.eligibility;
    state.payouts = before.payouts;
    state.bonusAwards = before.bonusAwards;
    state.freeplayClaims = before.freeplayClaims;
  }

  function createTxClient() {
    return {
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join("?");
        if (sql.includes("leaderboard_competitions") && typeof values[0] === "string") {
          if (state.throwOnLockCompetitionId.has(values[0])) {
            throw new Error(`FORCED_LOCK_FAILURE:${values[0]}`);
          }
        }
        return 1;
      },
      leaderboardSettings: {
        upsert: async ({ where, create }: { where: { ownerCoadminUserId: string }; create: Row }) => {
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
        create: async ({ data }: { data: Row }) => {
          const row = { id: randomUUID(), ...data };
          state.poolRateHistory.push(row);
          return row;
        }
      },
      leaderboardCompetition: {
        // Reads return shallow copies (like real Prisma) — never the live stored
        // object — so a caller holding an earlier read never observes a later
        // in-place mutation performed via update/updateMany below.
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
          state.competitions
            .filter((c) => {
              if (where.workspaceId && c.workspaceId !== where.workspaceId) return false;
              if (where.ownerCoadminUserId && c.ownerCoadminUserId !== where.ownerCoadminUserId) return false;
              if (where.status && c.status !== where.status) return false;
              if (where.endsAt?.lte && !((c.endsAt as Date) <= where.endsAt.lte)) return false;
              return true;
            })
            .map((c) => ({ ...c })),
        findUnique: async ({
          where
        }: {
          where: { id?: string; ownerCoadminUserId_sequence?: { ownerCoadminUserId: string; sequence: number } };
        }) => {
          if (where.id) {
            const row = state.competitions.find((c) => c.id === where.id);
            return row ? { ...row } : null;
          }
          if (where.ownerCoadminUserId_sequence) {
            const key = where.ownerCoadminUserId_sequence;
            const row = state.competitions.find(
              (c) => c.ownerCoadminUserId === key.ownerCoadminUserId && c.sequence === key.sequence
            );
            return row ? { ...row } : null;
          }
          return null;
        },
        findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
          const row = state.competitions.find((c) => c.id === where.id);
          if (!row) throw new Error("competition missing");
          return { ...row };
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
        }) => {
          const row = state.competitions.find(
            (c) =>
              c.ownerCoadminUserId === where.ownerCoadminUserId &&
              c.status === where.status &&
              (c.startsAt as Date) <= where.startsAt.lte &&
              (c.endsAt as Date) > where.endsAt.gt
          );
          return row ? { ...row } : null;
        },
        create: async ({ data }: { data: Row }) => {
          const row = {
            id: randomUUID(),
            frozenAt: null,
            finalizedAt: null,
            finalizedByUserId: null,
            finalizationIdempotencyKey: null,
            createdAt: now,
            updatedAt: now,
            ...data
          };
          state.competitions.push(row);
          return row;
        },
        update: async ({ where, data }: { where: { id: string }; data: Row }) => {
          const row = state.competitions.find((c) => c.id === where.id);
          if (!row) throw new Error("competition missing");
          Object.assign(row, data);
          return row;
        },
        updateMany: async ({ where, data }: { where: { id: string; status?: string }; data: Row }) => {
          const row = state.competitions.find((c) => c.id === where.id);
          if (!row) return { count: 0 };
          if (where.status && row.status !== where.status) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }
      },
      leaderboardStanding: {
        findMany: async ({ where }: { where: { competitionId: string } }) =>
          state.standings.filter((s) => s.competitionId === where.competitionId)
      },
      leaderboardEvent: {
        count: async () => 0
      },
      competitionSnapshot: {
        findUnique: async ({ where }: { where: { competitionId: string } }) => {
          const row = state.snapshots.find((s) => s.competitionId === where.competitionId);
          return row ? { ...row } : null;
        },
        create: async ({ data }: { data: Row }) => {
          const row = { id: randomUUID(), winnersJson: null, winnersLockedAt: null, createdAt: now, ...data };
          state.snapshots.push(row);
          return row;
        },
        update: async ({ where, data }: { where: { competitionId: string }; data: Row }) => {
          const row = state.snapshots.find((s) => s.competitionId === where.competitionId);
          if (!row) throw new Error("snapshot missing");
          Object.assign(row, data);
          return row;
        }
      },
      giveawayEligibilityCandidate: {
        create: async ({ data }: { data: Row }) => {
          const row = {
            id: randomUUID(),
            ineligibilityReason: null,
            resolvedAt: null,
            resolvedByUserId: null,
            resolutionReason: null,
            verificationSource: null,
            telegramChatMemberStatus: null,
            verifiedChannelId: null,
            botIntegrationId: null,
            verificationCheckedAt: null,
            verificationErrorCode: null,
            verificationErrorMessage: null,
            createdAt: now,
            updatedAt: now,
            ...data
          };
          state.eligibility.push(row);
          return row;
        },
        findMany: async ({
          where
        }: {
          where: {
            competitionId: string;
            ownerCoadminUserId?: string;
            leaderboardRank?: { gte?: number; lte?: number };
          };
        }) =>
          state.eligibility
            .filter((c) => {
              if (c.competitionId !== where.competitionId) return false;
              if (where.ownerCoadminUserId && c.ownerCoadminUserId !== where.ownerCoadminUserId) return false;
              if (where.leaderboardRank?.gte !== undefined && (c.leaderboardRank as number) < where.leaderboardRank.gte)
                return false;
              if (where.leaderboardRank?.lte !== undefined && (c.leaderboardRank as number) > where.leaderboardRank.lte)
                return false;
              return true;
            })
            .map((c) => ({ ...c }))
            .sort((a, b) => (a.leaderboardRank as number) - (b.leaderboardRank as number)),
        findUnique: async ({
          where
        }: {
          where: { competitionId_crmContactId: { competitionId: string; crmContactId: string } };
        }) => {
          const key = where.competitionId_crmContactId;
          const row = state.eligibility.find(
            (c) => c.competitionId === key.competitionId && c.crmContactId === key.crmContactId
          );
          return row ? { ...row } : null;
        },
        update: async ({ where, data }: { where: { id: string }; data: Row }) => {
          const row = state.eligibility.find((c) => c.id === where.id);
          if (!row) throw new Error("candidate missing");
          Object.assign(row, data);
          return row;
        }
      },
      giveawayPayout: {
        upsert: async ({
          where,
          create
        }: {
          where: { competitionId_prizeRank: { competitionId: string; prizeRank: number } };
          create: Row;
        }) => {
          const key = where.competitionId_prizeRank;
          const existing = state.payouts.find(
            (p) => p.competitionId === key.competitionId && p.prizeRank === key.prizeRank
          );
          if (existing) return existing;
          const row = {
            id: randomUUID(),
            paidAt: null,
            paidByUserId: null,
            notes: null,
            createdAt: now,
            updatedAt: now,
            ...create
          };
          state.payouts.push(row);
          return row;
        }
      },
      leaderboardBonusAward: {
        findUnique: async ({ where }: { where: { competitionId: string } }) =>
          state.bonusAwards.find((b) => b.competitionId === where.competitionId) ?? null,
        create: async ({ data }: { data: Row }) => {
          const row = { id: randomUUID(), ...data };
          state.bonusAwards.push(row);
          return row;
        }
      },
      freeplayClaim: {
        upsert: async ({ where, create }: { where: { idempotencyKey: string }; create: Row }) => {
          const existing = state.freeplayClaims.find((c) => c.idempotencyKey === where.idempotencyKey);
          if (existing) return existing;
          const row = { id: randomUUID(), ...create };
          state.freeplayClaims.push(row);
          return row;
        }
      }
    };
  }

  const prisma = {
    ...createTxClient(),
    $transaction: async <T>(fn: (tx: ReturnType<typeof createTxClient>) => Promise<T>) => {
      const before = snapshotState();
      try {
        return await fn(createTxClient());
      } catch (error) {
        restoreState(before);
        throw error;
      }
    },
    _state: state
  };

  return prisma as unknown as PrismaClient & { _state: typeof state };
}

function seedEnabledSettings(prisma: ReturnType<typeof createLifecyclePrisma>, ownerCoadminUserId: string) {
  prisma._state.settings.set(ownerCoadminUserId, {
    id: randomUUID(),
    workspaceId,
    ownerCoadminUserId,
    enabled: true,
    poolRateBps: 300,
    timezone: "America/Chicago",
    updatedByUserId: null
  });
}

function seedExpiredActiveCompetition(
  prisma: ReturnType<typeof createLifecyclePrisma>,
  ownerCoadminUserId: string,
  standingCount: 1 | 2 | 3 | 4
) {
  const window = competitionWindowContaining(now);
  const competitionId = randomUUID();
  prisma._state.competitions.push({
    id: competitionId,
    workspaceId,
    ownerCoadminUserId,
    sequence: window.sequence - 100,
    startsAt: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000),
    endsAt: new Date(now.getTime() - 60_000),
    status: "ACTIVE",
    prizePoolCents: 10_000,
    frozenAt: null,
    finalizedAt: null,
    finalizedByUserId: null,
    finalizationIdempotencyKey: null,
    createdAt: now,
    updatedAt: now
  });
  const contactIds: string[] = [];
  for (let i = 0; i < standingCount; i += 1) {
    const crmContactId = randomUUID();
    contactIds.push(crmContactId);
    prisma._state.standings.push({
      id: randomUUID(),
      workspaceId,
      ownerCoadminUserId,
      competitionId,
      crmContactId,
      totalPoints: 100 - i,
      pointsReachedAt: new Date(now.getTime() - (standingCount - i) * 60_000)
    });
  }
  return { competitionId, contactIds };
}

function resolveTop3(
  service: PrismaLeaderboardService,
  competitionId: string,
  ownerCoadminUserId: string,
  contactIds: readonly string[],
  statuses: readonly ("ELIGIBLE" | "NOT_ELIGIBLE")[]
) {
  return Promise.all(
    contactIds.map((crmContactId, index) =>
      service.setMembershipEligibility({
        workspaceId,
        ownerCoadminUserId,
        competitionId,
        crmContactId,
        membershipStatus: statuses[index] ?? "ELIGIBLE",
        actorUserId: staffActor,
        idempotencyKey: `resolve:${competitionId}:${crmContactId}`,
        verificationSource: "TELEGRAM_BOT_API",
        now
      })
    )
  );
}

describe("Lifecycle: ACTIVE expiry freezes independently of finalization", () => {
  it("commits ACTIVE -> FROZEN even though every candidate is PENDING_REVIEW", async () => {
    const prisma = createLifecyclePrisma();
    seedEnabledSettings(prisma, ownerA);
    const { competitionId, contactIds } = seedExpiredActiveCompetition(prisma, ownerA, 3);

    const service = new PrismaLeaderboardService(prisma, { audit: { record: async () => undefined } as never });
    await service.ensureCurrentCompetition(workspaceId, ownerA, now);

    const competition = prisma._state.competitions.find((c) => c.id === competitionId)!;
    expect(competition.status).toBe("FROZEN");

    const candidates = prisma._state.eligibility.filter((c) => c.competitionId === competitionId);
    expect(candidates).toHaveLength(3);
    expect(candidates.every((c) => c.membershipStatus === "PENDING_REVIEW")).toBe(true);
    expect(candidates.map((c) => c.crmContactId).sort()).toEqual([...contactIds].sort());
  });

  it("does not finalize while required membership remains unresolved", async () => {
    const prisma = createLifecyclePrisma();
    seedEnabledSettings(prisma, ownerA);
    const { competitionId } = seedExpiredActiveCompetition(prisma, ownerA, 3);
    const service = new PrismaLeaderboardService(prisma, { audit: { record: async () => undefined } as never });

    await service.ensureCurrentCompetition(workspaceId, ownerA, now);
    const outcome = await service.attemptAutoFinalize(workspaceId, ownerA, competitionId, now);

    expect(outcome.finalized).toBe(false);
    expect(outcome.competition.status).toBe("FROZEN");
    expect(prisma._state.payouts).toHaveLength(0);
  });

  it("emits onFrozen exactly once, only after the freeze transaction commits", async () => {
    const prisma = createLifecyclePrisma();
    seedEnabledSettings(prisma, ownerA);
    const { competitionId } = seedExpiredActiveCompetition(prisma, ownerA, 3);

    const onFrozenCalls: Array<{ workspaceId: string; ownerCoadminUserId: string; competitionId: string }> = [];
    const service = new PrismaLeaderboardService(prisma, {
      audit: { record: async () => undefined } as never,
      projectionHooks: {
        onFrozen: async (info) => {
          // Must observe post-commit state: candidates already persisted.
          const committed = prisma._state.competitions.find((c) => c.id === info.competitionId)!;
          expect(committed.status).toBe("FROZEN");
          onFrozenCalls.push(info);
        }
      }
    });

    await service.ensureCurrentCompetition(workspaceId, ownerA, now);
    expect(onFrozenCalls).toEqual([{ workspaceId, ownerCoadminUserId: ownerA, competitionId }]);
  });
});

describe("Lifecycle: automatic finalization resumes once membership resolves", () => {
  it("finalizes with correct winners/payouts once Top 3 is resolved", async () => {
    const prisma = createLifecyclePrisma();
    seedEnabledSettings(prisma, ownerA);
    const { competitionId, contactIds } = seedExpiredActiveCompetition(prisma, ownerA, 3);
    const service = new PrismaLeaderboardService(prisma, { audit: { record: async () => undefined } as never });

    await service.ensureCurrentCompetition(workspaceId, ownerA, now);
    await resolveTop3(service, competitionId, ownerA, contactIds, ["ELIGIBLE", "ELIGIBLE", "ELIGIBLE"]);

    const outcome = await service.attemptAutoFinalize(workspaceId, ownerA, competitionId, now);
    expect(outcome.finalized).toBe(true);
    expect(outcome.competition.status).toBe("FINALIZED");

    const payouts = prisma._state.payouts.filter((p) => p.competitionId === competitionId);
    expect(payouts).toHaveLength(3);
    expect(payouts.map((p) => p.crmContactId).sort()).toEqual([...contactIds].sort());
    expect(payouts.reduce((sum, p) => sum + (p.payoutCents as number), 0)).toBe(10_000);
  });

  it("supports fewer than 3 eligible winners", async () => {
    const prisma = createLifecyclePrisma();
    seedEnabledSettings(prisma, ownerA);
    const { competitionId, contactIds } = seedExpiredActiveCompetition(prisma, ownerA, 3);
    const service = new PrismaLeaderboardService(prisma, { audit: { record: async () => undefined } as never });

    await service.ensureCurrentCompetition(workspaceId, ownerA, now);
    // Rank 1 and 2 disqualified; only rank 3 is a real winner.
    await resolveTop3(service, competitionId, ownerA, contactIds, ["NOT_ELIGIBLE", "NOT_ELIGIBLE", "ELIGIBLE"]);

    const outcome = await service.attemptAutoFinalize(workspaceId, ownerA, competitionId, now);
    expect(outcome.finalized).toBe(true);
    const payouts = prisma._state.payouts.filter((p) => p.competitionId === competitionId);
    expect(payouts).toHaveLength(1);
    expect(payouts[0]?.crmContactId).toBe(contactIds[2]);
    expect(payouts[0]?.prizeRank).toBe(1);
  });

  it("duplicate lifecycle ticks/finalize calls do not duplicate candidates or payouts", async () => {
    const prisma = createLifecyclePrisma();
    seedEnabledSettings(prisma, ownerA);
    const { competitionId, contactIds } = seedExpiredActiveCompetition(prisma, ownerA, 3);
    const service = new PrismaLeaderboardService(prisma, { audit: { record: async () => undefined } as never });

    // Two lifecycle ticks before resolution: freeze must stay idempotent.
    await service.ensureCurrentCompetition(workspaceId, ownerA, now);
    await service.ensureCurrentCompetition(workspaceId, ownerA, now);
    expect(prisma._state.eligibility.filter((c) => c.competitionId === competitionId)).toHaveLength(3);

    await resolveTop3(service, competitionId, ownerA, contactIds, ["ELIGIBLE", "ELIGIBLE", "ELIGIBLE"]);

    const first = await service.attemptAutoFinalize(workspaceId, ownerA, competitionId, now);
    const second = await service.attemptAutoFinalize(workspaceId, ownerA, competitionId, now);
    expect(first.finalized).toBe(true);
    expect(second.finalized).toBe(false); // already FINALIZED — routine no-op, not an error
    const payouts = prisma._state.payouts.filter((p) => p.competitionId === competitionId);
    expect(payouts).toHaveLength(3);
  });
});

describe("Lifecycle: batch isolation across owners", () => {
  it("one owner's forced failure does not prevent another owner's expired competition from freezing", async () => {
    const prisma = createLifecyclePrisma();
    seedEnabledSettings(prisma, ownerA);
    seedEnabledSettings(prisma, ownerB);
    const { competitionId: blockedId } = seedExpiredActiveCompetition(prisma, ownerA, 2);
    const { competitionId: healthyId } = seedExpiredActiveCompetition(prisma, ownerB, 2);
    prisma._state.throwOnLockCompetitionId.add(blockedId);

    const service = new PrismaLeaderboardService(prisma, { audit: { record: async () => undefined } as never });
    const actioned = await service.completeExpiredCompetitions(now, 50);

    const blocked = prisma._state.competitions.find((c) => c.id === blockedId)!;
    const healthy = prisma._state.competitions.find((c) => c.id === healthyId)!;
    expect(blocked.status).toBe("ACTIVE"); // rolled back, unchanged
    expect(healthy.status).toBe("FROZEN"); // owner B still processed
    expect(actioned).toBeGreaterThanOrEqual(1);
  });
});

describe("Lifecycle: end-to-end regression (standings -> expiry -> freeze -> verify -> finalize)", () => {
  it("reproduces the production sequence and reaches FINALIZED without any manual intervention", async () => {
    const prisma = createLifecyclePrisma();
    seedEnabledSettings(prisma, ownerA);
    const { competitionId, contactIds } = seedExpiredActiveCompetition(prisma, ownerA, 3);

    let service!: PrismaLeaderboardService;
    let verifyCalls = 0;
    let autoFinalizeCalls = 0;
    service = new PrismaLeaderboardService(prisma, {
      audit: { record: async () => undefined } as never,
      projectionHooks: {
        // Mirrors leaderboard-telegram.plugin.ts's onFrozen: enqueue + run membership
        // verification, then resume finalization.
        onFrozen: async (info) => {
          verifyCalls += 1;
          await resolveTop3(service, info.competitionId, info.ownerCoadminUserId, contactIds, [
            "ELIGIBLE",
            "NOT_ELIGIBLE",
            "ELIGIBLE"
          ]);
          autoFinalizeCalls += 1;
          await service.attemptAutoFinalize(info.workspaceId, info.ownerCoadminUserId, info.competitionId, now);
        }
      }
    });

    // Simulates the production lifecycle sweep (completeExpiredCompetitions ->
    // ensureCurrentCompetition), invoked once, exactly as the 60s maintenance timer does.
    await service.completeExpiredCompetitions(now, 50);

    expect(verifyCalls).toBe(1);
    expect(autoFinalizeCalls).toBe(1);
    const competition = prisma._state.competitions.find((c) => c.id === competitionId)!;
    expect(competition.status).toBe("FINALIZED");
    const payouts = prisma._state.payouts.filter((p) => p.competitionId === competitionId);
    expect(payouts).toHaveLength(2);
    expect(payouts.map((p) => p.crmContactId).sort()).toEqual([contactIds[0], contactIds[2]].sort());
  });
});
