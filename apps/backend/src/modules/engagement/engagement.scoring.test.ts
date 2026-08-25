import { describe, expect, it } from "vitest";
import { chicagoWallTimeToUtc } from "../leaderboard/competition-schedule";
import {
  pollPointsForVote,
  referralContributionAtDeclaration,
  referralDecaySteps,
  referralEngagementPoints,
  top3EngagementPlayers,
  votePercentages,
  winningOptionIndex
} from "./engagement.scoring";

describe("engagement scoring", () => {
  it("awards 5 for a non-winning option and 10 total for the winner", () => {
    expect(pollPointsForVote(1, 0)).toBe(5);
    expect(pollPointsForVote(0, 0)).toBe(10);
    expect(pollPointsForVote(0, 0) + pollPointsForVote(0, 0)).not.toBe(15);
  });

  it("breaks vote-count ties with the lowest option index", () => {
    expect(winningOptionIndex([20, 20, 15, 5])).toBe(0);
    expect(winningOptionIndex([10, 20, 20, 5])).toBe(1);
    expect(winningOptionIndex([0, 0, 0, 0])).toBe(0);
    expect(winningOptionIndex([3, 2, 2, 2])).toBe(0);
  });

  it("does not let rounded percentages choose the winner", () => {
    const counts = [3, 2, 2, 2];
    const percentages = votePercentages(counts);
    expect(percentages.reduce((sum, n) => sum + n, 0)).toBe(100);
    expect(winningOptionIndex(counts)).toBe(0);
    expect(percentages[0]).toBeGreaterThanOrEqual(percentages[1]!);
  });

  it("decays referral contribution 50 -> 40 -> 30 -> 20 and never below 20", () => {
    expect(referralEngagementPoints(0)).toBe(50);
    expect(referralEngagementPoints(1)).toBe(40);
    expect(referralEngagementPoints(2)).toBe(30);
    expect(referralEngagementPoints(3)).toBe(20);
    expect(referralEngagementPoints(40)).toBe(20);
  });

  it("treats qualification just before 11 PM as 50 that night", () => {
    const qualified = chicagoWallTimeToUtc("2026-08-25T22:59:00");
    const declare = chicagoWallTimeToUtc("2026-08-25T23:00:00");
    expect(referralDecaySteps(qualified, declare)).toBe(0);
    expect(referralContributionAtDeclaration(qualified, declare)).toBe(50);
  });

  it("treats qualification just after 11 PM as 50 on the next declaration", () => {
    const qualified = chicagoWallTimeToUtc("2026-08-25T23:00:01");
    const tonight = chicagoWallTimeToUtc("2026-08-25T23:00:00");
    const next = chicagoWallTimeToUtc("2026-08-26T23:00:00");
    expect(referralContributionAtDeclaration(qualified, tonight)).toBe(0);
    expect(referralContributionAtDeclaration(qualified, next)).toBe(50);
  });

  it("ages historical referrals to the 20-point floor", () => {
    const qualified = chicagoWallTimeToUtc("2026-01-01T12:00:00");
    const declare = chicagoWallTimeToUtc("2026-08-25T23:00:00");
    expect(referralContributionAtDeclaration(qualified, declare)).toBe(20);
  });

  it("counts DST-safe declaration boundaries", () => {
    const qualified = chicagoWallTimeToUtc("2026-03-07T22:00:00");
    const afterSpring = chicagoWallTimeToUtc("2026-03-08T23:00:00");
    expect(referralContributionAtDeclaration(qualified, afterSpring)).toBe(40);
  });

  it("ranks by total, earlier reached-at, then contact id", () => {
    const ranked = top3EngagementPlayers([
      { crmContactId: "c", totalPoints: 70, pointsReachedAt: new Date("2026-08-25T10:00:00Z") },
      { crmContactId: "a", totalPoints: 70, pointsReachedAt: new Date("2026-08-25T09:00:00Z") },
      { crmContactId: "b", totalPoints: 90, pointsReachedAt: new Date("2026-08-25T12:00:00Z") }
    ]);
    expect(ranked.map((row) => row.crmContactId)).toEqual(["b", "a", "c"]);
  });
});
