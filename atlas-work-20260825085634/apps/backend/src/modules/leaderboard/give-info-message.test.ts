import { describe, expect, it } from "vitest";
import { buildGiveInfoMessage } from "./give-info-message";

const endsAt = new Date("2026-08-18T02:00:00.000Z");

describe("buildGiveInfoMessage", () => {
  it("builds a #1 crown lead message with lead over #2", () => {
    const text = buildGiveInfoMessage({
      rank: 1,
      totalPoints: 500,
      pointsAbove: 40,
      pointsToTop10: null,
      pointsToTop3: null,
      prizePoolCents: 12_345,
      competitionEndsAt: endsAt,
      isFirst: true
    });

    expect(text).toContain("You're #1");
    expect(text).toContain("leading by 40");
    expect(text).toContain("over #2");
    expect(text).toContain("Current prize pool: $123.45.");
    expect(text).toContain("Competition ends Monday, Aug 17 at 9:00 PM CDT.");
    expect(text).toMatch(/subscribed to the official leaderboard channel/i);
    expect(text).not.toMatch(/\d+%/);
    expect(text).not.toMatch(/bps/i);
    expect(text).not.toMatch(/\b2%\b|\b3%\b|\b4%\b|\b5%\b/);
    expect(text).not.toMatch(/not subscribed|you are subscribed/i);
  });

  it("builds a mid-rank message with behind and Top 3 gaps", () => {
    const text = buildGiveInfoMessage({
      rank: 5,
      totalPoints: 220,
      pointsAbove: 15,
      pointsToTop10: null,
      pointsToTop3: 60,
      prizePoolCents: 5000,
      competitionEndsAt: endsAt,
      isFirst: false
    });

    expect(text).toContain("You're #5");
    expect(text).toContain("15 points behind #4");
    expect(text).toContain("60 points away from Top 3");
    expect(text).toContain("Current prize pool: $50.00.");
    expect(text).toContain("Competition ends Monday, Aug 17 at 9:00 PM CDT.");
    expect(text).toMatch(/subscribed to the official leaderboard channel/i);
  });

  it("builds an outside top-10 message with points needed for Top 10", () => {
    const text = buildGiveInfoMessage({
      rank: 23,
      totalPoints: 80,
      pointsAbove: 5,
      pointsToTop10: 35,
      pointsToTop3: 120,
      prizePoolCents: 999,
      competitionEndsAt: endsAt,
      isFirst: false
    });

    expect(text).toContain("You're #23");
    expect(text).toContain("you need 35 more points to reach Top 10");
    expect(text).toContain("Current prize pool: $9.99.");
    expect(text).toMatch(/subscribed to the official leaderboard channel/i);
    expect(text).not.toMatch(/\d+%/);
  });

  it("keeps prize pool privacy (no contribution formula language)", () => {
    const text = buildGiveInfoMessage({
      rank: 2,
      totalPoints: 100,
      pointsAbove: 10,
      pointsToTop10: null,
      pointsToTop3: null,
      prizePoolCents: 250_00,
      competitionEndsAt: endsAt,
      isFirst: false
    });

    expect(text).toContain("$250.00");
    expect(text).not.toMatch(/pool rate|contribution|percent|%/i);
    expect(text).not.toMatch(/\b200\b|\b300\b|\b400\b|\b500\b/);
  });
});
