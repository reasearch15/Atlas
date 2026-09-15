import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { PrismaLeaderboardService } from "./leaderboard.prisma-service";

const competitionId = "00000000-0000-4000-8000-000000000001";

function candidate(
  leaderboardRank: number,
  membershipStatus: "ELIGIBLE" | "NOT_ELIGIBLE" | "PENDING_REVIEW"
) {
  return {
    id: `candidate-${leaderboardRank}`,
    workspaceId: "00000000-0000-4000-8000-000000000002",
    ownerCoadminUserId: "00000000-0000-4000-8000-000000000003",
    competitionId,
    crmContactId: `00000000-0000-4000-8000-${String(leaderboardRank).padStart(12, "0")}`,
    leaderboardRank,
    totalPoints: 100 - leaderboardRank,
    membershipStatus,
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
    createdAt: new Date(0),
    updatedAt: new Date(0)
  } as const;
}

async function buildPersistedWinners(rows: readonly ReturnType<typeof candidate>[]) {
  const findMany = vi.fn().mockResolvedValue(rows);
  const prisma = { giveawayEligibilityCandidate: { findMany } } as unknown as PrismaClient;
  const service = new PrismaLeaderboardService(prisma);
  const winners = await (
    service as unknown as {
      buildAutomaticWinnersPayloadTx(tx: PrismaClient, id: string, pool: number): Promise<unknown[]>;
    }
  ).buildAutomaticWinnersPayloadTx(prisma, competitionId, 10_000);
  return { winners, findMany };
}

describe("Prisma leaderboard finalization eligibility", () => {
  it("skips NOT_ELIGIBLE while preserving leaderboard ranks and Top 3 prize ranks", async () => {
    const { winners, findMany } = await buildPersistedWinners([
      candidate(1, "NOT_ELIGIBLE"),
      candidate(2, "ELIGIBLE"),
      candidate(3, "ELIGIBLE"),
      candidate(4, "ELIGIBLE")
    ]);

    expect(findMany).toHaveBeenCalledWith({
      where: { competitionId },
      orderBy: { leaderboardRank: "asc" }
    });
    expect(winners).toEqual([
      expect.objectContaining({ prizeRank: 1, leaderboardRank: 2, payoutCents: 5_000 }),
      expect.objectContaining({ prizeRank: 2, leaderboardRank: 3, payoutCents: 3_000 }),
      expect.objectContaining({ prizeRank: 3, leaderboardRank: 4, payoutCents: 2_000 })
    ]);
  });

  it("blocks persisted finalization when PENDING_REVIEW is reached before Top 3 is determined", async () => {
    await expect(
      buildPersistedWinners([
        candidate(1, "ELIGIBLE"),
        candidate(2, "PENDING_REVIEW"),
        candidate(3, "ELIGIBLE"),
        candidate(4, "ELIGIBLE")
      ])
    ).rejects.toMatchObject({ code: "PENDING_REVIEW_BLOCKS_FINALIZE" });
  });
});

describe("Prisma leaderboard bonus persistence", () => {
  it("persists one $15 award and claim, then reuses it without redrawing", async () => {
    const rows = [candidate(4, "NOT_ELIGIBLE"), candidate(5, "ELIGIBLE"), candidate(10, "ELIGIBLE"), candidate(11, "ELIGIBLE")];
    let stored: Record<string, unknown> | null = null;
    let claim: Record<string, unknown> | null = null;
    let randomCalls = 0;
    const tx = {
      leaderboardBonusAward: {
        findUnique: vi.fn(async () => stored),
        create: vi.fn(async ({ data }) => (stored = { id: "award-1", ...data }))
      },
      giveawayEligibilityCandidate: { findMany: vi.fn(async () => rows.filter((row) => row.leaderboardRank <= 10)) },
      freeplayClaim: {
        upsert: vi.fn(async ({ create }) => (claim ??= { id: "claim-1", ...create }))
      }
    };
    const service = new PrismaLeaderboardService(tx as unknown as PrismaClient, {
      bonusRandomIndex: () => {
        randomCalls += 1;
        return 1;
      }
    });
    const invoke = () => (service as unknown as {
      ensureLeaderboardBonusAwardTx(tx: PrismaClient, competition: object, now: Date): Promise<unknown>;
    }).ensureLeaderboardBonusAwardTx(tx as unknown as PrismaClient, {
      id: competitionId,
      workspaceId: "00000000-0000-4000-8000-000000000002",
      ownerCoadminUserId: "00000000-0000-4000-8000-000000000003"
    }, new Date("2026-09-15T00:00:00Z"));

    const first = await invoke();
    const replay = await invoke();
    expect(replay).toBe(first);
    expect(randomCalls).toBe(1);
    expect(tx.leaderboardBonusAward.create).toHaveBeenCalledTimes(1);
    expect(stored).toMatchObject({ crmContactId: rows[2]!.crmContactId, leaderboardRank: 10, rewardAmountCents: 1_500 });
    expect(claim).toMatchObject({ source: "LEADERBOARD_RANDOM", rewardAmountCents: 1_500, status: "UNCLAIMED" });
  });

  it("creates no award or claim when the frozen range has no eligible candidate", async () => {
    const tx = {
      leaderboardBonusAward: { findUnique: vi.fn(async () => null), create: vi.fn() },
      giveawayEligibilityCandidate: { findMany: vi.fn(async () => [candidate(4, "NOT_ELIGIBLE")]) },
      freeplayClaim: { upsert: vi.fn() }
    };
    const service = new PrismaLeaderboardService(tx as unknown as PrismaClient);
    const result = await (service as unknown as {
      ensureLeaderboardBonusAwardTx(tx: PrismaClient, competition: object, now: Date): Promise<unknown>;
    }).ensureLeaderboardBonusAwardTx(tx as unknown as PrismaClient, {
      id: competitionId,
      workspaceId: "00000000-0000-4000-8000-000000000002",
      ownerCoadminUserId: "00000000-0000-4000-8000-000000000003"
    }, new Date());
    expect(result).toBeNull();
    expect(tx.freeplayClaim.upsert).not.toHaveBeenCalled();
    expect(tx.leaderboardBonusAward.create).not.toHaveBeenCalled();
  });
});
