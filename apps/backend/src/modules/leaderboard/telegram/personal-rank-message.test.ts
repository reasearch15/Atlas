import { describe, expect, it } from "vitest";
import {
  formatPersonalAnnouncementDm,
  formatPersonalFinalResultMessage,
  formatPersonalRankMessage,
  formatWheelSpinResultMessage,
  buildWheelSpinInlineKeyboard,
  LEADERBOARD_WHEEL_SPIN_CALLBACK_DATA
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
    expect(text).toContain("⏰ Ends Monday, Aug 17 at 9:00 PM CDT");
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
    expect(available).not.toContain("Open Atlas to spin");

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

describe("formatWheelSpinResultMessage", () => {
  it("formats a normal rank-movement result", () => {
    const text = formatWheelSpinResultMessage({
      pointsAwarded: 25,
      previousRank: 9,
      resultingRank: 6,
      totalPoints: 309,
      pointsAbove: 12
    });
    expect(text).toContain("🎡 WHEEL RESULT");
    expect(text).toContain("+25 POINTS!");
    expect(text).toContain("#9 → #6");
    expect(text).toContain("You're now 12 points behind #5.");
    expect(text).toContain("Total points: 309");
  });

  it("formats a zero-point success without looking like an error", () => {
    const text = formatWheelSpinResultMessage({
      pointsAwarded: 0,
      previousRank: 8,
      resultingRank: 8,
      totalPoints: 200,
      pointsAbove: 10
    });
    expect(text).toContain("0 POINTS");
    expect(text).toContain("No points this spin.");
    expect(text).toContain("You're still #8.");
    expect(text).toContain("Keep earning through deposits, referrals and promotions.");
    expect(text).not.toMatch(/error|failed|unavailable/i);
  });

  it("formats Top 3 / prize-zone entry", () => {
    const text = formatWheelSpinResultMessage({
      pointsAwarded: 35,
      previousRank: 5,
      resultingRank: 3,
      totalPoints: 344,
      pointsAbove: 0
    });
    expect(text).toContain("+35 POINTS!");
    expect(text).toContain("#5 → #3");
    expect(text).toContain("🏆 You're now in the prize zone!");
    expect(text).toContain("Total points: 344");
  });

  it("formats a forced 40-point result", () => {
    const text = formatWheelSpinResultMessage({
      pointsAwarded: 40,
      previousRank: 4,
      resultingRank: 2,
      totalPoints: 400,
      pointsAbove: null
    });
    expect(text).toContain("+40 POINTS!");
    expect(text).toContain("#4 → #2");
    expect(text).toContain("prize zone");
  });
});

describe("buildWheelSpinInlineKeyboard", () => {
  it("uses namespaced callback data without player/owner IDs", () => {
    const kb = buildWheelSpinInlineKeyboard();
    expect(kb.inline_keyboard[0]?.[0]?.text).toBe("🎡 Spin Now");
    expect(kb.inline_keyboard[0]?.[0]?.callback_data).toBe(LEADERBOARD_WHEEL_SPIN_CALLBACK_DATA);
    expect(LEADERBOARD_WHEEL_SPIN_CALLBACK_DATA).toBe("leaderboard:wheel:spin");
    expect(JSON.stringify(kb)).not.toMatch(/crmContact|participant|ownerCoadmin|uuid/i);
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
