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

async function buildPersistedWinners(
  rows: readonly ReturnType<typeof candidate>[],
  options?: { readonly force?: boolean }
) {
  const findMany = vi.fn().mockResolvedValue(rows);
  const prisma = { giveawayEligibilityCandidate: { findMany } } as unknown as PrismaClient;
  const service = new PrismaLeaderboardService(prisma);
  const result = await (
    service as unknown as {
      buildAutomaticWinnersPayloadTx(
        tx: PrismaClient,
        id: string,
        pool: number,
        options?: { readonly force?: boolean }
      ): Promise<{ winnersPayload: unknown[]; skippedPendingReviewCrmContactIds: readonly string[] }>;
    }
  ).buildAutomaticWinnersPayloadTx(prisma, competitionId, 10_000, options);
  return { ...result, findMany };
}

describe("Prisma leaderboard finalization eligibility (strict — manual finalize)", () => {
  it("skips NOT_ELIGIBLE while preserving leaderboard ranks and Top 3 prize ranks", async () => {
    const { winnersPayload, findMany } = await buildPersistedWinners([
      candidate(1, "NOT_ELIGIBLE"),
      candidate(2, "ELIGIBLE"),
      candidate(3, "ELIGIBLE"),
      candidate(4, "ELIGIBLE")
    ]);

    expect(findMany).toHaveBeenCalledWith({
      where: { competitionId },
      orderBy: { leaderboardRank: "asc" }
    });
    expect(winnersPayload).toEqual([
      expect.objectContaining({ prizeRank: 1, leaderboardRank: 2, payoutCents: 5_000 }),
      expect.objectContaining({ prizeRank: 2, leaderboardRank: 3, payoutCents: 3_000 }),
      expect.objectContaining({ prizeRank: 3, leaderboardRank: 4, payoutCents: 2_000 })
    ]);
  });

  it("blocks (strict/non-forced) when PENDING_REVIEW is reached before Top 3 is determined", async () => {
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

describe("Prisma leaderboard finalization eligibility (force — bounded automatic finalize)", () => {
  it("never blocks: skips unresolved PENDING_REVIEW for the prize and continues down the ranking", async () => {
    const { winnersPayload, skippedPendingReviewCrmContactIds } = await buildPersistedWinners(
      [
        candidate(1, "ELIGIBLE"),
        candidate(2, "PENDING_REVIEW"), // Telegram/API could not resolve in time
        candidate(3, "ELIGIBLE"),
        candidate(4, "ELIGIBLE")
      ],
      { force: true }
    );

    expect(winnersPayload).toEqual([
      expect.objectContaining({ prizeRank: 1, leaderboardRank: 1 }),
      expect.objectContaining({ prizeRank: 2, leaderboardRank: 3 }),
      expect.objectContaining({ prizeRank: 3, leaderboardRank: 4 })
    ]);
    expect(skippedPendingReviewCrmContactIds).toEqual([candidate(2, "PENDING_REVIEW").crmContactId]);
  });

  it("a confirmed NOT_ELIGIBLE #1 is skipped and #4 replaces them, unaffected by force mode", async () => {
    const { winnersPayload } = await buildPersistedWinners(
      [
        candidate(1, "NOT_ELIGIBLE"),
        candidate(2, "ELIGIBLE"),
        candidate(3, "ELIGIBLE"),
        candidate(4, "ELIGIBLE")
      ],
      { force: true }
    );
    expect(winnersPayload.map((w: any) => w.leaderboardRank)).toEqual([2, 3, 4]);
  });

  it("supports fewer than 3 winners when every remaining candidate is unresolved or ineligible", async () => {
    const { winnersPayload, skippedPendingReviewCrmContactIds } = await buildPersistedWinners(
      [
        candidate(1, "ELIGIBLE"),
        candidate(2, "NOT_ELIGIBLE"),
        candidate(3, "PENDING_REVIEW")
      ],
      { force: true }
    );
    expect(winnersPayload).toHaveLength(1);
    expect(winnersPayload[0]).toEqual(expect.objectContaining({ prizeRank: 1, leaderboardRank: 1 }));
    expect(skippedPendingReviewCrmContactIds).toEqual([candidate(3, "PENDING_REVIEW").crmContactId]);
  });

  it("multiple unresolved/non-eligible players in a row are all skipped without blocking", async () => {
    const { winnersPayload, skippedPendingReviewCrmContactIds } = await buildPersistedWinners(
      [
        candidate(1, "PENDING_REVIEW"),
        candidate(2, "NOT_ELIGIBLE"),
        candidate(3, "PENDING_REVIEW"),
        candidate(4, "ELIGIBLE"),
        candidate(5, "ELIGIBLE")
      ],
      { force: true }
    );
    expect(winnersPayload.map((w: any) => w.leaderboardRank)).toEqual([4, 5]);
    expect(skippedPendingReviewCrmContactIds.sort()).toEqual(
      [candidate(1, "PENDING_REVIEW").crmContactId, candidate(3, "PENDING_REVIEW").crmContactId].sort()
    );
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
      ensureLeaderboardBonusAwardTx(
        tx: PrismaClient,
        competition: object,
        now: Date
      ): Promise<{ award: unknown; skippedPendingReviewCrmContactIds: readonly string[] }>;
    }).ensureLeaderboardBonusAwardTx(tx as unknown as PrismaClient, {
      id: competitionId,
      workspaceId: "00000000-0000-4000-8000-000000000002",
      ownerCoadminUserId: "00000000-0000-4000-8000-000000000003"
    }, new Date("2026-09-15T00:00:00Z"));

    const first = await invoke();
    const replay = await invoke();
    expect(replay.award).toBe(first.award);
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
      ensureLeaderboardBonusAwardTx(
        tx: PrismaClient,
        competition: object,
        now: Date
      ): Promise<{ award: unknown; skippedPendingReviewCrmContactIds: readonly string[] }>;
    }).ensureLeaderboardBonusAwardTx(tx as unknown as PrismaClient, {
      id: competitionId,
      workspaceId: "00000000-0000-4000-8000-000000000002",
      ownerCoadminUserId: "00000000-0000-4000-8000-000000000003"
    }, new Date());
    expect(result.award).toBeNull();
    expect(tx.freeplayClaim.upsert).not.toHaveBeenCalled();
    expect(tx.leaderboardBonusAward.create).not.toHaveBeenCalled();
  });

  it("strict mode still blocks on an unresolved rank 4-10 candidate", async () => {
    const tx = {
      leaderboardBonusAward: { findUnique: vi.fn(async () => null), create: vi.fn() },
      giveawayEligibilityCandidate: {
        findMany: vi.fn(async () => [candidate(4, "PENDING_REVIEW"), candidate(5, "ELIGIBLE")])
      },
      freeplayClaim: { upsert: vi.fn() }
    };
    const service = new PrismaLeaderboardService(tx as unknown as PrismaClient);
    await expect(
      (service as unknown as {
        ensureLeaderboardBonusAwardTx(tx: PrismaClient, competition: object, now: Date): Promise<unknown>;
      }).ensureLeaderboardBonusAwardTx(tx as unknown as PrismaClient, {
        id: competitionId,
        workspaceId: "00000000-0000-4000-8000-000000000002",
        ownerCoadminUserId: "00000000-0000-4000-8000-000000000003"
      }, new Date())
    ).rejects.toMatchObject({ code: "PENDING_REVIEW_BLOCKS_FINALIZE" });
  });

  it("force mode excludes an unresolved rank 4-10 candidate from the draw instead of blocking", async () => {
    const rows = [candidate(4, "PENDING_REVIEW"), candidate(5, "ELIGIBLE")];
    let stored: Record<string, unknown> | null = null;
    const tx = {
      leaderboardBonusAward: {
        findUnique: vi.fn(async () => stored),
        create: vi.fn(async ({ data }: any) => (stored = { id: "award-1", ...data }))
      },
      giveawayEligibilityCandidate: { findMany: vi.fn(async () => rows) },
      freeplayClaim: { upsert: vi.fn(async ({ create }: any) => ({ id: "claim-1", ...create })) }
    };
    const service = new PrismaLeaderboardService(tx as unknown as PrismaClient, { bonusRandomIndex: () => 0 });
    const result = await (service as unknown as {
      ensureLeaderboardBonusAwardTx(
        tx: PrismaClient,
        competition: object,
        now: Date,
        options?: { readonly force?: boolean }
      ): Promise<{ award: unknown; skippedPendingReviewCrmContactIds: readonly string[] }>;
    }).ensureLeaderboardBonusAwardTx(
      tx as unknown as PrismaClient,
      {
        id: competitionId,
        workspaceId: "00000000-0000-4000-8000-000000000002",
        ownerCoadminUserId: "00000000-0000-4000-8000-000000000003"
      },
      new Date(),
      { force: true }
    );
    expect(result.skippedPendingReviewCrmContactIds).toEqual([rows[0]!.crmContactId]);
    expect(stored).toMatchObject({ crmContactId: rows[1]!.crmContactId, leaderboardRank: 5 });
  });
});
