import { describe, expect, it } from "vitest";
import { selectPrizeWinnersFromEligibility } from "./prize-eligibility";

describe("selectPrizeWinnersFromEligibility", () => {
  it("skips NOT_ELIGIBLE and preserves leaderboard ranks on prize winners", () => {
    const result = selectPrizeWinnersFromEligibility([
      { crmContactId: "A", leaderboardRank: 1, totalPoints: 300, membershipStatus: "NOT_ELIGIBLE" },
      { crmContactId: "B", leaderboardRank: 2, totalPoints: 280, membershipStatus: "ELIGIBLE" },
      { crmContactId: "C", leaderboardRank: 3, totalPoints: 250, membershipStatus: "ELIGIBLE" },
      { crmContactId: "D", leaderboardRank: 4, totalPoints: 230, membershipStatus: "ELIGIBLE" }
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.winners.map((w) => ({ prize: w.prizeRank, id: w.crmContactId, board: w.leaderboardRank }))).toEqual([
      { prize: 1, id: "B", board: 2 },
      { prize: 2, id: "C", board: 3 },
      { prize: 3, id: "D", board: 4 }
    ]);
  });

  it("does not silently skip PENDING_REVIEW", () => {
    const result = selectPrizeWinnersFromEligibility([
      { crmContactId: "A", leaderboardRank: 1, totalPoints: 300, membershipStatus: "PENDING_REVIEW" },
      { crmContactId: "B", leaderboardRank: 2, totalPoints: 280, membershipStatus: "ELIGIBLE" }
    ]);
    expect(result).toEqual({
      ok: false,
      code: "PENDING_REVIEW_BLOCKS_SELECTION",
      pendingCrmContactIds: ["A"]
    });
  });
});
