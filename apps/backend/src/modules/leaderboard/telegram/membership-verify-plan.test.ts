import { describe, expect, it } from "vitest";
import { planMembershipVerification } from "./membership-verify-plan";

describe("planMembershipVerification", () => {
  it("locks the prize set when Top 3 are eligible and still queues an unchecked freeplay rank", () => {
    const plan = planMembershipVerification([
      { crmContactId: "a", leaderboardRank: 1, membershipStatus: "ELIGIBLE" },
      { crmContactId: "b", leaderboardRank: 2, membershipStatus: "ELIGIBLE" },
      { crmContactId: "c", leaderboardRank: 3, membershipStatus: "ELIGIBLE" },
      { crmContactId: "d", leaderboardRank: 4, membershipStatus: "PENDING_REVIEW" }
    ]);
    expect(plan.prizeResolved).toBe(true);
    expect(plan.freeplayResolved).toBe(false);
    expect(plan.resolved).toBe(false);
    expect(plan.toVerify.map((candidate) => candidate.crmContactId)).toEqual(["d"]);
    expect(plan.eligibleCount).toBe(3);
  });

  it("checks the blocking pending player and the next ranked player", () => {
    const plan = planMembershipVerification([
      { crmContactId: "a", leaderboardRank: 1, membershipStatus: "NOT_ELIGIBLE" },
      { crmContactId: "b", leaderboardRank: 2, membershipStatus: "ELIGIBLE" },
      { crmContactId: "c", leaderboardRank: 3, membershipStatus: "PENDING_REVIEW" },
      { crmContactId: "d", leaderboardRank: 4, membershipStatus: "ELIGIBLE" },
      { crmContactId: "e", leaderboardRank: 5, membershipStatus: "PENDING_REVIEW" }
    ]);
    expect(plan.prizeResolved).toBe(false);
    expect(plan.resolved).toBe(false);
    expect(plan.eligibleCount).toBe(2);
    expect(plan.toVerify.map((c) => c.crmContactId)).toEqual(["c", "e"]);
  });

  it("queues past the first unresolved player so a lower rank is not hidden", () => {
    const plan = planMembershipVerification([
      { crmContactId: "a", leaderboardRank: 1, membershipStatus: "PENDING_REVIEW" },
      { crmContactId: "b", leaderboardRank: 2, membershipStatus: "PENDING_REVIEW" },
      { crmContactId: "c", leaderboardRank: 3, membershipStatus: "PENDING_REVIEW" },
      { crmContactId: "d", leaderboardRank: 4, membershipStatus: "PENDING_REVIEW" }
    ]);
    expect(plan.toVerify.map((c) => c.crmContactId)).toEqual(["a", "b", "c", "d"]);
    expect(plan.prizeResolved).toBe(false);
    expect(plan.resolved).toBe(false);
    expect(plan.eligibleCount).toBe(0);
  });

  it("keeps freeplay rank 6 queued after three prize winners are already eligible", () => {
    const plan = planMembershipVerification([
      { crmContactId: "a", leaderboardRank: 1, membershipStatus: "NOT_ELIGIBLE" },
      { crmContactId: "b", leaderboardRank: 2, membershipStatus: "ELIGIBLE" },
      { crmContactId: "c", leaderboardRank: 3, membershipStatus: "NOT_ELIGIBLE" },
      { crmContactId: "d", leaderboardRank: 4, membershipStatus: "ELIGIBLE" },
      { crmContactId: "e", leaderboardRank: 5, membershipStatus: "ELIGIBLE" },
      { crmContactId: "f", leaderboardRank: 6, membershipStatus: "PENDING_REVIEW" }
    ]);
    expect(plan.prizeResolved).toBe(true);
    expect(plan.freeplayResolved).toBe(false);
    expect(plan.toVerify.map((candidate) => candidate.leaderboardRank)).toEqual([6]);
    expect(plan.eligibleCount).toBe(3);
  });

  it("does not treat the tail as resolved while the first eight are still pending", () => {
    const plan = planMembershipVerification(
      Array.from({ length: 20 }, (_, index) => ({
        crmContactId: `p${index + 1}`,
        leaderboardRank: index + 1,
        membershipStatus: "PENDING_REVIEW" as const
      }))
    );
    expect(plan.prizeResolved).toBe(false);
    expect(plan.toVerify.map((candidate) => candidate.leaderboardRank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(plan.resolved).toBe(false);
  });

  it("includes rank nine on the next pass after the first eight are conclusively ineligible", () => {
    const candidates = Array.from({ length: 20 }, (_, index) => ({
      crmContactId: `p${index + 1}`,
      leaderboardRank: index + 1,
      membershipStatus: (index < 8 ? "NOT_ELIGIBLE" : "PENDING_REVIEW") as "NOT_ELIGIBLE" | "PENDING_REVIEW"
    }));
    const plan = planMembershipVerification(candidates);
    expect(plan.prizeResolved).toBe(false);
    expect(plan.toVerify[0]?.leaderboardRank).toBe(9);
    expect(plan.toVerify.map((candidate) => candidate.leaderboardRank)).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
  });
});
