import { describe, expect, it } from "vitest";
import { planMembershipVerification } from "./membership-verify-plan";

describe("planMembershipVerification", () => {
  it("returns empty when Top 3 are already ELIGIBLE", () => {
    const plan = planMembershipVerification([
      { crmContactId: "a", leaderboardRank: 1, membershipStatus: "ELIGIBLE" },
      { crmContactId: "b", leaderboardRank: 2, membershipStatus: "ELIGIBLE" },
      { crmContactId: "c", leaderboardRank: 3, membershipStatus: "ELIGIBLE" },
      { crmContactId: "d", leaderboardRank: 4, membershipStatus: "PENDING_REVIEW" }
    ]);
    expect(plan.resolved).toBe(true);
    expect(plan.toVerify).toEqual([]);
    expect(plan.eligibleCount).toBe(3);
  });

  it("skips NOT_ELIGIBLE and verifies enough PENDING to fill prize slots", () => {
    const plan = planMembershipVerification([
      { crmContactId: "a", leaderboardRank: 1, membershipStatus: "NOT_ELIGIBLE" },
      { crmContactId: "b", leaderboardRank: 2, membershipStatus: "ELIGIBLE" },
      { crmContactId: "c", leaderboardRank: 3, membershipStatus: "PENDING_REVIEW" },
      { crmContactId: "d", leaderboardRank: 4, membershipStatus: "ELIGIBLE" },
      { crmContactId: "e", leaderboardRank: 5, membershipStatus: "PENDING_REVIEW" }
    ]);
    expect(plan.resolved).toBe(false);
    expect(plan.eligibleCount).toBe(2);
    expect(plan.toVerify.map((c) => c.crmContactId)).toEqual(["c"]);
  });

  it("queues the first three PENDING when none are yet ELIGIBLE", () => {
    const plan = planMembershipVerification([
      { crmContactId: "a", leaderboardRank: 1, membershipStatus: "PENDING_REVIEW" },
      { crmContactId: "b", leaderboardRank: 2, membershipStatus: "PENDING_REVIEW" },
      { crmContactId: "c", leaderboardRank: 3, membershipStatus: "PENDING_REVIEW" },
      { crmContactId: "d", leaderboardRank: 4, membershipStatus: "PENDING_REVIEW" }
    ]);
    expect(plan.toVerify.map((c) => c.crmContactId)).toEqual(["a", "b", "c"]);
    expect(plan.resolved).toBe(false);
    expect(plan.eligibleCount).toBe(0);
  });

  it("walks past ineligible leaders until three ELIGIBLE are secured", () => {
    const plan = planMembershipVerification([
      { crmContactId: "a", leaderboardRank: 1, membershipStatus: "NOT_ELIGIBLE" },
      { crmContactId: "b", leaderboardRank: 2, membershipStatus: "ELIGIBLE" },
      { crmContactId: "c", leaderboardRank: 3, membershipStatus: "NOT_ELIGIBLE" },
      { crmContactId: "d", leaderboardRank: 4, membershipStatus: "ELIGIBLE" },
      { crmContactId: "e", leaderboardRank: 5, membershipStatus: "ELIGIBLE" },
      { crmContactId: "f", leaderboardRank: 6, membershipStatus: "PENDING_REVIEW" }
    ]);
    expect(plan.resolved).toBe(true);
    expect(plan.toVerify).toEqual([]);
    expect(plan.eligibleCount).toBe(3);
  });
});
