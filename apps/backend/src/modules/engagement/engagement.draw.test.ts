import { describe, expect, it } from "vitest";
import { chicagoWallTimeToUtc } from "../leaderboard/competition-schedule";
import { REFERRAL_MILESTONES } from "../leaderboard/leaderboard.constants";
import type { WheelRng } from "../leaderboard/wheel-rng";
import {
  DRAW_BASE_WEIGHT,
  DRAW_REFERRAL_FLOOR_WEIGHT,
  DRAW_WINNER_COOLDOWN_DRAWS,
  DAILY_DRAW_PRIZE_CENTS
} from "./engagement.constants";
import {
  candidateDrawWeight,
  dailyDrawFreeplayIdempotencyKey,
  drawReferralWeight,
  drawReferralWeightAtDeclaration,
  isDailyDrawEligibleChatMember,
  isInDailyDrawWinnerCooldown,
  selectWeightedDailyDrawCandidate,
  snapshotDailyDrawCandidates,
  stackReferralWeights
} from "./engagement.draw";
import { buildDailyDrawWinnerCardSvg, renderDailyDrawWinnerCard } from "./engagement.draw-card";
import { formatDailyDrawCaption } from "./engagement.messages";
import { addChicagoDays, chicagoDateDiffDays } from "./engagement.schedule";

function rngPick(pick: number): WheelRng {
  return {
    nextInt(maxExclusive: number) {
      if (pick < 0 || pick >= maxExclusive) {
        throw new Error(`pick ${pick} is outside 0..${maxExclusive - 1}`);
      }
      return pick;
    }
  };
}

describe("daily Freeplay draw referral weights", () => {
  it("starts FIRST_10 at 50 and decays 40/30/20/10 then 0 with no permanent floor", () => {
    expect(drawReferralWeight(0)).toBe(50);
    expect(drawReferralWeight(1)).toBe(40);
    expect(drawReferralWeight(2)).toBe(30);
    expect(drawReferralWeight(3)).toBe(20);
    expect(drawReferralWeight(4)).toBe(10);
    expect(drawReferralWeight(5)).toBe(0);
    expect(drawReferralWeight(40)).toBe(0);
    expect(drawReferralWeight(40)).toBeGreaterThanOrEqual(DRAW_REFERRAL_FLOOR_WEIGHT);
  });

  it("never returns a negative weight", () => {
    expect(drawReferralWeight(100)).toBe(0);
    expect(stackReferralWeights([-5, 50, 0])).toBe(50);
  });

  it("stacks multiple referrals onto the base weight", () => {
    const referralWeight = stackReferralWeights([50, 40, 20]);
    expect(referralWeight).toBe(110);
    expect(candidateDrawWeight(referralWeight)).toBe(DRAW_BASE_WEIGHT + 110);
    expect(candidateDrawWeight(0)).toBe(DRAW_BASE_WEIGHT);
  });

  it("ages a historical FIRST_10 to 0 by the draw date", () => {
    const qualified = chicagoWallTimeToUtc("2026-01-01T12:00:00");
    const declare = chicagoWallTimeToUtc("2026-08-25T23:00:00");
    expect(drawReferralWeightAtDeclaration(qualified, declare)).toBe(0);
  });

  it("gives 50 on qualification day and 40 the next Chicago day", () => {
    const qualified = chicagoWallTimeToUtc("2026-08-25T12:00:00");
    expect(drawReferralWeightAtDeclaration(qualified, chicagoWallTimeToUtc("2026-08-25T23:00:00"))).toBe(50);
    expect(drawReferralWeightAtDeclaration(qualified, chicagoWallTimeToUtc("2026-08-26T23:00:00"))).toBe(40);
  });
});

describe("daily Freeplay draw eligibility helpers", () => {
  it("allows verified members and restricted subscribers, not bots/admins", () => {
    expect(isDailyDrawEligibleChatMember({ status: "member", user: { isBot: false } })).toBe(true);
    expect(isDailyDrawEligibleChatMember({ status: "restricted", user: { isBot: false } })).toBe(true);
    expect(isDailyDrawEligibleChatMember({ status: "administrator", user: { isBot: false } })).toBe(false);
    expect(isDailyDrawEligibleChatMember({ status: "creator", user: { isBot: false } })).toBe(false);
    expect(isDailyDrawEligibleChatMember({ status: "left", user: { isBot: false } })).toBe(false);
    expect(isDailyDrawEligibleChatMember({ status: "member", user: { isBot: true } })).toBe(false);
  });

  it("excludes a winner for the next 7 draws and restores eligibility after that", () => {
    expect(DRAW_WINNER_COOLDOWN_DRAWS).toBe(7);
    expect(isInDailyDrawWinnerCooldown(["2026-08-25"], "2026-08-26")).toBe(true);
    expect(isInDailyDrawWinnerCooldown(["2026-08-25"], "2026-09-01")).toBe(true);
    expect(isInDailyDrawWinnerCooldown(["2026-08-25"], "2026-09-02")).toBe(false);
    expect(chicagoDateDiffDays("2026-08-25", "2026-09-01")).toBe(7);
    expect(addChicagoDays("2026-08-25", 8)).toBe("2026-09-02");
  });
});

describe("weighted daily draw selection", () => {
  it("selects from the weighted range instead of the highest weight", () => {
    const candidates = [
      { id: "high", totalWeight: 120 },
      { id: "low", totalWeight: 10 }
    ];
    expect(selectWeightedDailyDrawCandidate(candidates, rngPick(0)).selected.id).toBe("high");
    expect(selectWeightedDailyDrawCandidate(candidates, rngPick(119)).selected.id).toBe("high");
    expect(selectWeightedDailyDrawCandidate(candidates, rngPick(120)).selected.id).toBe("low");
    expect(selectWeightedDailyDrawCandidate(candidates, rngPick(120)).pick).toBe(120);
    expect(selectWeightedDailyDrawCandidate(candidates, rngPick(120)).totalWeight).toBe(130);
  });

  it("persists a candidate snapshot without changing weights", () => {
    const snapshot = snapshotDailyDrawCandidates([
      {
        crmContactId: "a",
        telegramUserId: "100",
        displayName: "Emily",
        baseWeight: 10,
        referralWeight: 50,
        totalWeight: 60,
        activeReferralCount: 1
      }
    ]);
    expect(snapshot).toEqual([
      {
        crmContactId: "a",
        telegramUserId: "100",
        baseWeight: 10,
        referralWeight: 50,
        totalWeight: 60,
        activeReferralCount: 1
      }
    ]);
  });
});

describe("daily draw Freeplay and announcement copy", () => {
  it("uses the deterministic $5 idempotency key and 500 cents", () => {
    expect(DAILY_DRAW_PRIZE_CENTS).toBe(500);
    expect(dailyDrawFreeplayIdempotencyKey("owner", "2026-08-25")).toBe("eng:daily-fp:owner:2026-08-25");
  });

  it("mentions increased chances when referral weight is present, not a causal win", () => {
    const boosted = formatDailyDrawCaption({
      displayName: "Emily",
      referralWeight: 110,
      activeReferralCount: 3
    });
    expect(boosted).toContain("Congratulations Emily");
    expect(boosted).toContain("$5 Freeplay");
    expect(boosted).toContain("increased your chances");
    expect(boosted).toContain("3 active referrals boosted today's winning chances");
    expect(boosted).not.toMatch(/won because/i);
    const plain = formatDailyDrawCaption({
      displayName: "John",
      referralWeight: 0,
      activeReferralCount: 0
    });
    expect(plain).not.toContain("increased your chances");
    expect(plain).not.toContain("REFERRAL");
  });

  it("renders a large celebration card with winner, $5, and optional referral boost", async () => {
    const boosted = buildDailyDrawWinnerCardSvg({
      displayName: "Emily",
      activeReferralCount: 3,
      referralWeight: 110
    });
    expect(boosted).toContain("DAILY WINNER");
    expect(boosted).toContain("$5 FREEPLAY");
    expect(boosted).toContain("Emily");
    expect(boosted).toContain("REFERRAL BOOST");
    expect(boosted).toContain("3 ACTIVE REFERRAL BOOSTS");
    const plain = buildDailyDrawWinnerCardSvg({
      displayName: "John",
      activeReferralCount: 0,
      referralWeight: 0
    });
    expect(plain).toContain("John");
    expect(plain).not.toContain("REFERRAL BOOST");
    const png = await renderDailyDrawWinnerCard({
      displayName: "Emily",
      activeReferralCount: 3,
      referralWeight: 110
    });
    expect(png.byteLength).toBeGreaterThan(10_000);
  });
});

describe("leaderboard referral isolation", () => {
  it("does not change existing 25/50/75/150 milestone rewards", () => {
    expect(REFERRAL_MILESTONES.map((row) => [row.code, row.points])).toEqual([
      ["FIRST_10", 25],
      ["CUM_50", 50],
      ["CUM_100", 75],
      ["CUM_250", 150]
    ]);
  });
});
