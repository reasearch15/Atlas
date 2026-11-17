import { describe, expect, it } from "vitest";
import { splitPrizePool } from "./points-math";
import { selectPrizeWinnersFromEligibility } from "./prize-eligibility";
import { planMembershipVerification } from "./telegram/membership-verify-plan";

/**
 * Sequence 73: rank 3 stayed PENDING_REVIEW after Telegram HTTP 400, and the
 * old finalizer skipped that player plus everyone below them.
 */
describe("sequence 73 winner guard", () => {
  const pool = 13_632;
  const candidates = [
    { crmContactId: "rank1", leaderboardRank: 1, totalPoints: 1269, membershipStatus: "ELIGIBLE" as const },
    { crmContactId: "rank2", leaderboardRank: 2, totalPoints: 650, membershipStatus: "ELIGIBLE" as const },
    { crmContactId: "rank3", leaderboardRank: 3, totalPoints: 476, membershipStatus: "PENDING_REVIEW" as const },
    { crmContactId: "rank4", leaderboardRank: 4, totalPoints: 469, membershipStatus: "ELIGIBLE" as const }
  ];

  it("still asks Telegram about rank 4 while rank 3 is unresolved", () => {
    const plan = planMembershipVerification(candidates);
    expect(plan.resolved).toBe(false);
    expect(plan.toVerify.map((row) => row.leaderboardRank)).toEqual([3]);
  });

  it("does not select rank 4 while rank 3 is unresolved and does not split the pool", () => {
    const selection = selectPrizeWinnersFromEligibility(candidates);
    expect(selection.ok).toBe(false);
    if (selection.ok) return;
    expect(selection.pendingCrmContactIds).toEqual(["rank3"]);
    expect(splitPrizePool(pool, 3).reduce((sum, row) => sum + row.payoutCents, 0)).toBe(pool);
  });

  it("promotes rank 4 only after rank 3 is conclusively ineligible", () => {
    const selection = selectPrizeWinnersFromEligibility([
      candidates[0]!,
      candidates[1]!,
      { ...candidates[2]!, membershipStatus: "NOT_ELIGIBLE" },
      candidates[3]!
    ]);
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.winners.map((winner) => winner.crmContactId)).toEqual(["rank1", "rank2", "rank4"]);
    const payouts = splitPrizePool(pool, 3);
    expect(payouts.map((row) => row.payoutCents)).toEqual([6816, 4089, 2727]);
    expect(payouts.reduce((sum, row) => sum + row.payoutCents, 0)).toBe(pool);
  });

  it("finalizes fewer than three winners only when nobody unresolved remains", () => {
    const selection = selectPrizeWinnersFromEligibility([
      candidates[0]!,
      candidates[1]!,
      { ...candidates[2]!, membershipStatus: "NOT_ELIGIBLE" },
      { ...candidates[3]!, membershipStatus: "NOT_ELIGIBLE" }
    ]);
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.winners).toHaveLength(2);
    const payouts = splitPrizePool(pool, 2);
    expect(payouts.map((row) => row.payoutCents)).toEqual([8520, 5112]);
  });

  it("does not invent winners when everyone is ineligible", () => {
    const selection = selectPrizeWinnersFromEligibility(
      candidates.map((row) => ({ ...row, membershipStatus: "NOT_ELIGIBLE" as const }))
    );
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.winners).toEqual([]);
  });
});
