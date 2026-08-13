import { describe, expect, it } from "vitest";
import type { RequestUser } from "../auth/auth.types";
import { AppError } from "../../utils/errors";
import { applyStandingFilterRows, LeaderboardApiService } from "./leaderboard.api-service";
import { computeStandingGaps, formatPrizePoolDisplay } from "./leaderboard.standing-helpers";
import { withRanks } from "./ranking";
import { ownerMismatch } from "./leaderboard.errors";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const coadminId = "44444444-4444-4444-8444-444444444444";
const staffId = "66666666-6666-4666-8666-666666666666";
const otherCoadminId = "77777777-7777-4777-8777-777777777777";
const sessionId = "55555555-5555-4555-8555-555555555555";

const coadmin: RequestUser = {
  id: coadminId,
  email: "coadmin@example.com",
  name: "Coadmin",
  role: "COADMIN",
  workspaceId,
  sessionId
};

const staff: RequestUser = {
  ...coadmin,
  id: staffId,
  email: "staff@example.com",
  name: "Staff",
  role: "STAFF"
};

function makeService(prisma: unknown): LeaderboardApiService {
  return new LeaderboardApiService({ prisma } as never);
}

describe("formatPrizePoolDisplay", () => {
  it("formats cents as dollars with two decimals and no percent", () => {
    expect(formatPrizePoolDisplay(0)).toBe("$0.00");
    expect(formatPrizePoolDisplay(12345)).toBe("$123.45");
    expect(formatPrizePoolDisplay(100)).toBe("$1.00");
    expect(formatPrizePoolDisplay(99)).toBe("$0.99");
  });
});

describe("computeStandingGaps", () => {
  const ranked = withRanks([
    { crmContactId: "a", totalPoints: 100, pointsReachedAt: new Date("2026-01-01T00:00:00Z") },
    { crmContactId: "b", totalPoints: 80, pointsReachedAt: new Date("2026-01-01T01:00:00Z") },
    { crmContactId: "c", totalPoints: 70, pointsReachedAt: new Date("2026-01-01T02:00:00Z") },
    { crmContactId: "d", totalPoints: 60, pointsReachedAt: new Date("2026-01-01T03:00:00Z") },
    { crmContactId: "e", totalPoints: 50, pointsReachedAt: new Date("2026-01-01T04:00:00Z") },
    { crmContactId: "f", totalPoints: 40, pointsReachedAt: new Date("2026-01-01T05:00:00Z") },
    { crmContactId: "g", totalPoints: 30, pointsReachedAt: new Date("2026-01-01T06:00:00Z") },
    { crmContactId: "h", totalPoints: 20, pointsReachedAt: new Date("2026-01-01T07:00:00Z") },
    { crmContactId: "i", totalPoints: 15, pointsReachedAt: new Date("2026-01-01T08:00:00Z") },
    { crmContactId: "j", totalPoints: 10, pointsReachedAt: new Date("2026-01-01T09:00:00Z") },
    { crmContactId: "k", totalPoints: 5, pointsReachedAt: new Date("2026-01-01T10:00:00Z") }
  ]);

  it("computes #1 lead over #2", () => {
    const gaps = computeStandingGaps(ranked, "a");
    expect(gaps).toMatchObject({
      isFirst: true,
      pointsAbove: 20,
      gapToNextRankPoints: null,
      gapToTop3Points: null,
      pointsToTop10: null
    });
  });

  it("computes mid-rank behind and top3 gaps", () => {
    const gaps = computeStandingGaps(ranked, "d");
    expect(gaps).toMatchObject({
      isFirst: false,
      pointsAbove: 10,
      gapToNextRankPoints: 10,
      gapToTop3Points: 10,
      pointsToTop3: 10,
      pointsToTop10: null
    });
  });

  it("computes outside top 10 need", () => {
    const gaps = computeStandingGaps(ranked, "k");
    expect(gaps).toMatchObject({
      isFirst: false,
      pointsToTop10: 5,
      gapToTop3Points: 65
    });
  });
});

describe("applyStandingFilterRows", () => {
  const ranked = withRanks(
    Array.from({ length: 12 }, (_, i) => ({
      crmContactId: `c${i}`,
      totalPoints: 100 - i,
      pointsReachedAt: new Date(`2026-01-01T0${Math.min(i, 9)}:00:00Z`),
      displayName: `Player ${i}`,
      telegramUsername: null,
      depositPoints: 0,
      referralPoints: 0,
      promotionPoints: 0,
      qualifyingDepositCents: 0,
      successfulReferralCount: i === 2 ? 3 : 0,
      lastEventAt: i === 5 ? new Date("2026-08-01T00:00:00Z") : null,
      lastEventReason: null
    }))
  );

  it("filters TOP_10 / REFERRERS / RECENTLY_CHANGED", () => {
    expect(applyStandingFilterRows(ranked, "TOP_10")).toHaveLength(10);
    expect(applyStandingFilterRows(ranked, "REFERRERS").map((r) => r.crmContactId)).toEqual(["c2"]);
    expect(applyStandingFilterRows(ranked, "RECENTLY_CHANGED").map((r) => r.crmContactId)).toEqual([
      "c5"
    ]);
  });
});

describe("LeaderboardApiService owner resolution", () => {
  it("resolves COADMIN owner to self", async () => {
    const service = makeService({});
    await expect(service.resolveBoardOwner(coadmin)).resolves.toBe(coadminId);
  });

  it("resolves STAFF owner to primaryCoadminId only", async () => {
    const service = makeService({
      workspace: {
        findUnique: async () => ({ primaryCoadminId: coadminId })
      }
    });
    await expect(service.resolveBoardOwner(staff)).resolves.toBe(coadminId);
  });

  it("throws LEADERBOARD_OWNER_UNRESOLVED when Staff workspace has no primary", async () => {
    const service = makeService({
      workspace: {
        findUnique: async () => ({ primaryCoadminId: null })
      }
    });
    await expect(service.resolveBoardOwner(staff)).rejects.toMatchObject({
      statusCode: 409,
      code: "LEADERBOARD_OWNER_UNRESOLVED"
    } satisfies Partial<AppError>);
  });

  it("assertActorMayMutatePlayer enforces coadmin self and staff primary", async () => {
    const service = makeService({
      workspace: {
        findUnique: async () => ({ primaryCoadminId: coadminId })
      },
      user: {
        findFirst: async ({ where }: { where: { id: string } }) =>
          where.id === coadminId ? { id: coadminId } : null
      }
    });

    await expect(service.assertActorMayMutatePlayer(coadmin, coadminId)).resolves.toBeUndefined();
    await expect(service.assertActorMayMutatePlayer(coadmin, otherCoadminId)).rejects.toMatchObject({
      code: "OWNER_MISMATCH"
    });

    await expect(service.assertActorMayMutatePlayer(staff, coadminId)).resolves.toBeUndefined();
    await expect(service.assertActorMayMutatePlayer(staff, otherCoadminId)).rejects.toBeInstanceOf(
      ownerMismatch().constructor
    );
  });
});
