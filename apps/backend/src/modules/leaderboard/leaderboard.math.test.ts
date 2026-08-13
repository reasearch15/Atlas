import { describe, expect, it } from "vitest";
import { competitionWindowContaining, isInCompetitionWindow, chicagoWallTimeToUtc } from "./competition-schedule";
import { depositPointsFromCumulativeCents, poolContributionCents, splitPrizePool } from "./points-math";
import { createFixedRandomSource, resolvePromotionPoints } from "./promotion-points";
import { compareStandings, sortStandings } from "./ranking";

describe("deposit points cumulative formula", () => {
  it("maps standard amounts ($1 = 1 point)", () => {
    expect(depositPointsFromCumulativeCents(100)).toBe(1);
    expect(depositPointsFromCumulativeCents(1000)).toBe(10);
    expect(depositPointsFromCumulativeCents(2000)).toBe(20);
    expect(depositPointsFromCumulativeCents(5000)).toBe(50);
    expect(depositPointsFromCumulativeCents(7500)).toBe(75);
    expect(depositPointsFromCumulativeCents(10000)).toBe(100);
    expect(depositPointsFromCumulativeCents(25000)).toBe(250);
  });

  it("does not award points for sub-$1 remainders until cumulative crosses", () => {
    expect(depositPointsFromCumulativeCents(99)).toBe(0);
    expect(depositPointsFromCumulativeCents(100)).toBe(1);
    expect(depositPointsFromCumulativeCents(300)).toBe(3);
    expect(depositPointsFromCumulativeCents(500)).toBe(5);
  });

  it("prevents split advantage vs single deposit", () => {
    const one = depositPointsFromCumulativeCents(10000);
    let cents = 0;
    let points = 0;
    for (let i = 0; i < 10; i += 1) {
      cents += 1000;
      points = depositPointsFromCumulativeCents(cents);
    }
    expect(points).toBe(one);
    expect(points).toBe(100);

    cents = 0;
    for (let i = 0; i < 5; i += 1) {
      cents += 2000;
      points = depositPointsFromCumulativeCents(cents);
    }
    expect(points).toBe(100);
  });
});

describe("pool contribution math", () => {
  it("computes 2% and 5% with integer cents", () => {
    expect(poolContributionCents(1000, 200)).toBe(20);
    expect(poolContributionCents(5000, 200)).toBe(100);
    expect(poolContributionCents(10000, 200)).toBe(200);
    expect(poolContributionCents(10000, 500)).toBe(500);
  });

  it("floors fractional cents", () => {
    expect(poolContributionCents(333, 200)).toBe(6);
  });
});

describe("payout split", () => {
  it("uses 50/30/20 with remainder on third", () => {
    expect(splitPrizePool(100)).toEqual([
      { rank: 1, payoutCents: 50 },
      { rank: 2, payoutCents: 30 },
      { rank: 3, payoutCents: 20 }
    ]);
  });

  it("distributes awkward cent pools with no leftover across the three prize slots", () => {
    const splits = splitPrizePool(101);
    expect(splits.reduce((sum, s) => sum + s.payoutCents, 0)).toBe(101);
    expect(splits[0]?.payoutCents).toBe(50);
    expect(splits[1]?.payoutCents).toBe(30);
    expect(splits[2]?.payoutCents).toBe(21);
  });
});

describe("competition windows America/Chicago DST", () => {
  it("assigns CST boundary Tuesday 20:59:59 to old window and 21:00:00 to new", () => {
    // 2024-01-16 was Tuesday; CST (UTC-6)
    const before = chicagoWallTimeToUtc("2024-01-16T20:59:59");
    const at = chicagoWallTimeToUtc("2024-01-16T21:00:00");
    const oldWindow = competitionWindowContaining(before);
    const newWindow = competitionWindowContaining(at);
    expect(isInCompetitionWindow(before, oldWindow.startsAt, oldWindow.endsAt)).toBe(true);
    expect(isInCompetitionWindow(at, oldWindow.startsAt, oldWindow.endsAt)).toBe(false);
    expect(newWindow.sequence).toBe(oldWindow.sequence + 1);
    expect(at.getTime()).toBe(newWindow.startsAt.getTime());
  });

  it("assigns CDT boundary correctly across DST", () => {
    // 2024-07-16 was Tuesday; CDT (UTC-5)
    const before = chicagoWallTimeToUtc("2024-07-16T20:59:59");
    const at = chicagoWallTimeToUtc("2024-07-16T21:00:00");
    const oldWindow = competitionWindowContaining(before);
    const newWindow = competitionWindowContaining(at);
    expect(oldWindow.sequence + 1).toBe(newWindow.sequence);
    expect(isInCompetitionWindow(before, oldWindow.startsAt, oldWindow.endsAt)).toBe(true);
    expect(isInCompetitionWindow(at, newWindow.startsAt, newWindow.endsAt)).toBe(true);
  });

  it("uses half-open interval [startsAt, endsAt)", () => {
    const window = competitionWindowContaining(chicagoWallTimeToUtc("2024-01-16T21:00:00"));
    expect(isInCompetitionWindow(window.startsAt, window.startsAt, window.endsAt)).toBe(true);
    expect(isInCompetitionWindow(window.endsAt, window.startsAt, window.endsAt)).toBe(false);
  });
});

describe("promotion rolling 24h window", () => {
  it("first is random, additional within window are +1, after expiry random again", () => {
    const start = new Date("2026-08-01T10:00:00.000Z");
    const random = createFixedRandomSource([3, 2]);
    expect(resolvePromotionPoints([], start, random)).toBe(3);
    expect(resolvePromotionPoints([start], new Date(start.getTime() + 4 * 3600_000), random)).toBe(1);
    expect(resolvePromotionPoints([start], new Date(start.getTime() + 11 * 3600_000), random)).toBe(1);
    expect(resolvePromotionPoints([start], new Date(start.getTime() + 24 * 3600_000), random)).toBe(2);
  });
});

describe("tie ranking", () => {
  it("prefers earlier pointsReachedAt then contact id", () => {
    const a = { crmContactId: "b", totalPoints: 10, pointsReachedAt: new Date("2026-01-01T00:00:02.000Z") };
    const b = { crmContactId: "a", totalPoints: 10, pointsReachedAt: new Date("2026-01-01T00:00:01.000Z") };
    const c = { crmContactId: "c", totalPoints: 10, pointsReachedAt: new Date("2026-01-01T00:00:01.000Z") };
    expect(compareStandings(b, a)).toBeLessThan(0);
    const sorted = sortStandings([a, b, c]);
    expect(sorted.map((s) => s.crmContactId)).toEqual(["a", "c", "b"]);
  });
});
