import { describe, expect, it } from "vitest";
import {
  buildPublicLeaderboardClimbTips,
  maxWheelPointsFromDistribution
} from "./public-leaderboard-climb-tips";

describe("buildPublicLeaderboardClimbTips", () => {
  it("includes deposit/referral/promotions by default and omits wheel", () => {
    const tips = buildPublicLeaderboardClimbTips();
    expect(tips.map((t) => t.title)).toEqual(["DEPOSIT", "REFER", "PROMOTIONS"]);
    expect(tips[0]!.detail).toBe("$1 = 1 PT");
    expect(tips.some((t) => t.title.includes("WHEEL"))).toBe(false);
  });

  it("includes wheel only when enabled, using real qualification/max", () => {
    const tips = buildPublicLeaderboardClimbTips({
      includeWheel: true,
      wheelQualificationCents: 4000,
      wheelMaxPoints: 40,
      wheelCycleHours: 48
    });
    const wheel = tips.find((t) => t.title.includes("WHEEL"));
    expect(wheel).toBeTruthy();
    expect(wheel!.detail).toContain("$40+");
    expect(wheel!.detail).toContain("40 PTS");
    expect(wheel!.title).toBe("48H WHEEL");
  });

  it("omits channels marked disabled", () => {
    const tips = buildPublicLeaderboardClimbTips({
      includeDeposit: false,
      includeReferral: false,
      includePromotions: true,
      includeWheel: false
    });
    expect(tips).toEqual([
      { icon: "🎁", title: "PROMOTIONS", detail: "Verified promo bonuses" }
    ]);
  });
});

describe("maxWheelPointsFromDistribution", () => {
  it("reads max points from distribution JSON", () => {
    expect(maxWheelPointsFromDistribution([{ points: 0, weight: 1 }, { points: 40, weight: 1 }])).toBe(
      40
    );
    expect(maxWheelPointsFromDistribution(null)).toBeNull();
    expect(maxWheelPointsFromDistribution([])).toBeNull();
  });
});
