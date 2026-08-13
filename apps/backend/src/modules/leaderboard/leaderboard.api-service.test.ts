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
      wheelPoints: 0,
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

describe("LeaderboardApiService.searchPlayers", () => {
  const contactSelf = "a1111111-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const contactPic = "a2222222-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
  const contactOtherOwner = "a3333333-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
  const contactChannel = "a4444444-aaaa-4aaa-8aaa-aaaaaaaaaaa4";

  function searchPrisma(captured: { where: unknown[] }) {
    return {
      leaderboardParticipant: {
        findMany: async ({ where }: { where: unknown }) => {
          captured.where.push(where);
          // Simulate DB already scoped; return only owner PRIVATE rows matching OR loosely.
          const rows = [
            {
              crmContact: {
                id: contactPic,
                displayName: "Other Label",
                username: "Piccaso47",
                chats: [{ firstName: "Pic", lastName: null, username: "Piccaso47" }]
              }
            },
            {
              crmContact: {
                id: contactSelf,
                displayName: "Self Player",
                username: "selfuser",
                chats: []
              }
            }
          ];
          // Channel / other-owner never returned by this mock (scoped out by where).
          void contactOtherOwner;
          void contactChannel;
          return rows.filter((row) => {
            const w = where as {
              ownerCoadminUserId?: string;
              crmContactId?: { not?: string };
              crmContact?: { kind?: string };
            };
            if (w.ownerCoadminUserId !== coadminId) return false;
            if (w.crmContact?.kind !== "PRIVATE") return false;
            if (w.crmContactId?.not && row.crmContact.id === w.crmContactId.not) return false;
            return true;
          });
        }
      }
    };
  }

  it("accepts 1-char query, matches username, excludes self, returns crmContactId", async () => {
    const captured: { where: unknown[] } = { where: [] };
    const service = makeService(searchPrisma(captured));
    const hits = await service.searchPlayers(coadmin, "p", contactSelf, 25);
    expect(hits.some((h) => h.crmContactId === contactPic)).toBe(true);
    expect(hits.some((h) => h.crmContactId === contactSelf)).toBe(false);
    expect(hits[0]?.crmContactId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(JSON.stringify(captured.where[0])).toContain("PRIVATE");
    expect(JSON.stringify(captured.where[0])).toContain(coadminId);
  });

  it("treats @Piccaso47 like Piccaso47", async () => {
    const service = makeService(searchPrisma({ where: [] }));
    const withAt = await service.searchPlayers(coadmin, "@Piccaso47", contactSelf, 25);
    const without = await service.searchPlayers(coadmin, "Piccaso47", contactSelf, 25);
    expect(withAt.map((h) => h.crmContactId)).toEqual(without.map((h) => h.crmContactId));
  });

  it("scopes STAFF search to primary coadmin owner only", async () => {
    const captured: { where: unknown[] } = { where: [] };
    const service = makeService({
      workspace: {
        findUnique: async () => ({ primaryCoadminId: coadminId })
      },
      ...searchPrisma(captured)
    });
    await service.searchPlayers(staff, "p", undefined, 25);
    expect((captured.where[0] as { ownerCoadminUserId: string }).ownerCoadminUserId).toBe(coadminId);
  });
});

describe("LeaderboardApiService.listReferrals display names", () => {
  const referrerId = "b1111111-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const referredId = "b2222222-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
  const referralId = "b3333333-bbbb-4bbb-8bbb-bbbbbbbbbbb3";
  const foreignOwnerReferralId = "b4444444-bbbb-4bbb-8bbb-bbbbbbbbbbb4";

  it("resolves Unknown* CRM names from Telegram identity and keeps referral direction", async () => {
    const capturedWhere: unknown[] = [];
    const service = makeService({
      leaderboardReferral: {
        findMany: async ({
          where
        }: {
          where: { workspaceId: string; ownerCoadminUserId: string };
        }) => {
          capturedWhere.push(where);
          expect(where.workspaceId).toBe(workspaceId);
          expect(where.ownerCoadminUserId).toBe(coadminId);
          return [
            {
              id: referralId,
              referrerCrmContactId: referrerId,
              referredCrmContactId: referredId,
              createdAt: new Date("2026-01-10T12:00:00Z"),
              overriddenAt: null,
              overrideReason: null,
              referrer: {
                displayName: "Unknown User",
                username: null,
                chats: [{ firstName: "Picasso", lastName: null, username: null }]
              },
              referred: {
                displayName: "Unknown User",
                username: null,
                chats: [{ firstName: "Charles", lastName: "McBride", username: null }]
              },
              milestoneAwards: []
            }
          ];
        }
      },
      leaderboardPlayerStats: {
        findMany: async () => []
      }
    });

    const rows = await service.listReferrals(coadmin);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.referrerCrmContactId).toBe(referrerId);
    expect(rows[0]?.referredCrmContactId).toBe(referredId);
    expect(rows[0]?.referrerDisplayName).toBe("Picasso");
    expect(rows[0]?.referredDisplayName).toBe("Charles McBride");
    expect(capturedWhere[0]).toMatchObject({
      workspaceId,
      ownerCoadminUserId: coadminId
    });
    void foreignOwnerReferralId;
  });

  it("keeps usable CRM initials and rejects Staff via assertCoadmin", async () => {
    const service = makeService({
      leaderboardReferral: {
        findMany: async () => [
          {
            id: referralId,
            referrerCrmContactId: referrerId,
            referredCrmContactId: referredId,
            createdAt: new Date("2026-01-10T12:00:00Z"),
            overriddenAt: null,
            overrideReason: null,
            referrer: {
              displayName: "A.",
              username: null,
              chats: [{ firstName: "Ignored", lastName: "Name", username: null }]
            },
            referred: {
              displayName: "Unknown User",
              username: "Piccaso47",
              chats: []
            },
            milestoneAwards: []
          }
        ]
      },
      leaderboardPlayerStats: {
        findMany: async () => [{ crmContactId: referredId, lifetimeQualifyingDepositCents: 500 }]
      }
    });

    const rows = await service.listReferrals(coadmin);
    expect(rows[0]?.referrerDisplayName).toBe("A.");
    expect(rows[0]?.referredDisplayName).toBe("Piccaso47");
    expect(rows[0]?.lifetimeQualifyingDepositCents).toBe(500);

    await expect(service.listReferrals(staff)).rejects.toMatchObject({
      statusCode: 403
    } satisfies Partial<AppError>);
  });
});
