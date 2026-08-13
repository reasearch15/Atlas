import { describe, expect, it } from "vitest";
import {
  formatPersonalAnnouncementDm,
  formatPersonalFinalResultMessage,
  formatPersonalRankMessage
} from "./personal-rank-message";

describe("formatPersonalRankMessage", () => {
  it("formats gaps and never includes pool %", () => {
    const text = formatPersonalRankMessage({
      rank: 7,
      totalPoints: 284,
      pointsAbove: 18,
      pointsToTop3: 61,
      prizePoolCents: 62_000,
      endsAt: new Date("2026-08-18T02:00:00.000Z"),
      timezone: "America/Chicago",
      isFirst: false
    });
    expect(text).toContain("Rank: #7");
    expect(text).toContain("18 points behind #6");
    expect(text).toContain("61 points away from Top 3");
    expect(text).toContain("$620.00");
    expect(text).not.toMatch(/2%|rateBps|poolRate/i);
  });

  it("includes optional wheel status lines", () => {
    const text = formatPersonalRankMessage({
      rank: 3,
      totalPoints: 100,
      pointsAbove: 5,
      pointsToTop3: null,
      prizePoolCents: 10_000,
      endsAt: new Date("2026-08-18T02:00:00.000Z"),
      timezone: "America/Chicago",
      isFirst: false,
      wheelStatus: {
        qualifyingDepositCents: 2600,
        qualificationCentsRequired: 4000,
        available: false,
        consumed: false,
        pointsAwarded: null,
        cycleSequence: 2
      }
    });
    expect(text).toContain("🎡 Wheel: $26 / $40");
    expect(text).toContain("$14 more qualifying deposits needed this cycle.");
    expect(text).not.toMatch(/%|probability|weight/i);
  });

  it("shows spin available and used states without probabilities", () => {
    const available = formatPersonalRankMessage({
      rank: 5,
      totalPoints: 50,
      pointsAbove: 10,
      pointsToTop3: 20,
      prizePoolCents: 10_000,
      endsAt: new Date("2026-08-18T02:00:00.000Z"),
      timezone: "America/Chicago",
      isFirst: false,
      wheelStatus: {
        qualifyingDepositCents: 4000,
        qualificationCentsRequired: 4000,
        available: true,
        consumed: false,
        pointsAwarded: null,
        cycleSequence: 1
      }
    });
    expect(available).toContain("Wheel Spin Available");

    const used = formatPersonalRankMessage({
      rank: 5,
      totalPoints: 80,
      pointsAbove: 10,
      pointsToTop3: 20,
      prizePoolCents: 10_000,
      endsAt: new Date("2026-08-18T02:00:00.000Z"),
      timezone: "America/Chicago",
      isFirst: false,
      wheelStatus: {
        qualifyingDepositCents: 4000,
        qualificationCentsRequired: 4000,
        available: false,
        consumed: true,
        pointsAwarded: 30,
        cycleSequence: 1
      }
    });
    expect(used).toContain("Used for this cycle");
  });
});

describe("formatPersonalFinalResultMessage", () => {
  it("preserves leaderboard #1 for ineligible NOT_SUBSCRIBED player", () => {
    const text = formatPersonalFinalResultMessage({
      leaderboardRank: 1,
      totalPoints: 900,
      prizeRank: null,
      payoutCents: null,
      membershipStatus: "NOT_ELIGIBLE",
      ineligibilityReason: "NOT_SUBSCRIBED",
      prizePoolCents: 100_000
    });
    expect(text).toContain("You finished #1 with 900 points");
    expect(text).toContain("not subscribed");
    expect(text).toContain("#1 leaderboard finish remains recorded");
    expect(text).not.toContain("finished #2");
    expect(text).not.toContain("YOU WON");
  });

  it("explains prize promotion when leaderboard rank differs from prize rank", () => {
    const text = formatPersonalFinalResultMessage({
      leaderboardRank: 2,
      totalPoints: 850,
      prizeRank: 1,
      payoutCents: 50_000,
      membershipStatus: "ELIGIBLE",
      ineligibilityReason: null,
      prizePoolCents: 100_000
    });
    expect(text).toContain("YOU WON");
    expect(text).toContain("finished #2");
    expect(text).toContain("Prize #1");
    expect(text).toContain("higher-ranked player was not prize-eligible");
    expect(text).toContain("$500.00");
    expect(text).not.toContain("finished #1 on the leaderboard");
  });
});

describe("formatPersonalAnnouncementDm", () => {
  it("formats referral milestone with points delta", () => {
    const text = formatPersonalAnnouncementDm({
      kind: "REFERRAL_MILESTONE",
      fromRank: null,
      toRank: 0,
      totalPoints: 50
    });
    expect(text).toContain("referral reached a milestone");
    expect(text).toContain("+50 leaderboard points");
  });
});
