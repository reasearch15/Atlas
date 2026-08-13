import { describe, expect, it } from "vitest";
import {
  buildPublicLeaderboardKeyboard,
  formatPublicLeaderboardCaption,
  formatPublicLeaderboardMessage,
  formatPublicResultsMessage,
  formatRankAnnouncement,
  PUBLIC_LEADERBOARD_SUBSCRIPTION_REMINDER
} from "./public-message";

const endsAt = new Date("2026-08-18T02:00:00.000Z");

describe("formatPublicLeaderboardMessage", () => {
  it("puts prize pool near the top with premium Top 3 formatting", () => {
    const text = formatPublicLeaderboardMessage({
      title: "BIWEEKLY LEADERBOARD",
      top10: [
        { rank: 1, displayName: "John Smith", points: 720 },
        { rank: 2, displayName: "Sarah Connor", points: 681 },
        { rank: 3, displayName: "Mike Jones", points: 640 },
        { rank: 4, displayName: "Alex Reed", points: 610 },
        { rank: 10, displayName: "David Lee", points: 390 }
      ],
      prizePoolCents: 62_000,
      endsAt,
      timezone: "America/Chicago"
    });

    expect(text).toContain("🏆 BIWEEKLY LEADERBOARD");
    expect(text.indexOf("💰 PRIZE POOL")).toBeLessThan(text.indexOf("🥇 1."));
    expect(text.indexOf("💵 $620.00")).toBeLessThan(text.indexOf("🥇 1."));
    expect(text).toContain("🥇 1. John Smith — 720 pts");
    expect(text).toContain("🥈 2. Sarah Connor — 681 pts");
    expect(text).toContain("🥉 3. Mike Jones — 640 pts");
    expect(text).toContain("4. Alex Reed — 610 pts");
    expect(text).toContain("10. David Lee — 390 pts");
    expect(text).toContain(PUBLIC_LEADERBOARD_SUBSCRIPTION_REMINDER);
    expect(text).toContain("🔥 Keep climbing.");
    expect(text).toContain("⏰ Ends Monday, Aug 17 at 9:00 PM CDT");
    expect(text).not.toMatch(/\b2%\b/);
    expect(text).not.toMatch(/rateBps/i);
  });

  it("never includes pool %, rateBps, or internal ids", () => {
    const text = formatPublicLeaderboardMessage({
      title: "BIWEEKLY LEADERBOARD",
      top10: [{ rank: 1, displayName: "John", points: 100 }],
      prizePoolCents: 12_345,
      endsAt,
      timezone: "America/Chicago"
    });

    expect(text).not.toMatch(/\b2%\b/);
    expect(text).not.toMatch(/\d+%/);
    expect(text).not.toMatch(/rateBps/i);
    expect(text).not.toMatch(/pool rate/i);
    expect(text).not.toMatch(/crmContactId|workspaceId|competitionId/i);
    expect(text).not.toMatch(/\b200\b|\b300\b|\b400\b|\b500\b/);
  });

  it("appends personal rank CTA when botUsername is provided", () => {
    const text = formatPublicLeaderboardMessage({
      title: "BIWEEKLY LEADERBOARD",
      top10: [{ rank: 1, displayName: "John", points: 100 }],
      prizePoolCents: 1000,
      endsAt,
      timezone: "America/Chicago",
      botUsername: "AtlasBoardBot"
    });
    expect(text).toContain("➡️ Check your personal rank:");
    expect(text).toContain("https://t.me/AtlasBoardBot?start=rank");
  });

  it("omits personal rank CTA when botUsername is missing", () => {
    const text = formatPublicLeaderboardMessage({
      title: "BIWEEKLY LEADERBOARD",
      top10: [{ rank: 1, displayName: "John", points: 100 }],
      prizePoolCents: 1000,
      endsAt,
      timezone: "America/Chicago"
    });
    expect(text).not.toContain("t.me/");
  });

  it("sanitizes unsafe display names in public posts", () => {
    const text = formatPublicLeaderboardMessage({
      title: "BIWEEKLY LEADERBOARD",
      top10: [{ rank: 1, displayName: "@secretuser", points: 50 }],
      prizePoolCents: 100,
      endsAt,
      timezone: "America/Chicago"
    });
    expect(text).toContain("1. Player — 50 pts");
    expect(text).not.toContain("@secretuser");
  });

  it("preserves initials that previously collapsed to Player", () => {
    const text = formatPublicLeaderboardMessage({
      title: "BIWEEKLY LEADERBOARD",
      top10: [
        { rank: 1, displayName: "L. J.", points: 0 },
        { rank: 2, displayName: "S F", points: 0 }
      ],
      prizePoolCents: 0,
      endsAt,
      timezone: "America/Chicago"
    });
    expect(text).toContain("🥇 1. L. J. — 0 pts");
    expect(text).toContain("🥈 2. S F — 0 pts");
  });

  it("renders intentional zero-point board copy", () => {
    const text = formatPublicLeaderboardMessage({
      title: "BIWEEKLY LEADERBOARD",
      top10: [
        { rank: 1, displayName: "Homer", points: 0 },
        { rank: 2, displayName: "Player", points: 0 },
        { rank: 3, displayName: "TanDra", points: 0 }
      ],
      prizePoolCents: 0,
      endsAt,
      timezone: "America/Chicago"
    });

    expect(text).toContain("💵 $0.00");
    expect(text.indexOf("💰 PRIZE POOL")).toBeLessThan(text.indexOf("🥇 1. Homer — 0 pts"));
    expect(text).toContain("🥇 1. Homer — 0 pts");
    expect(text).toContain("🥈 2. Player — 0 pts");
    expect(text).toContain("🥉 3. TanDra — 0 pts");
    expect(text).toContain("🔥 The competition has started — every point matters.");
    expect(text).not.toContain("Keep climbing.");
  });
});

describe("formatPublicResultsMessage", () => {
  it("lists prize winners and payouts without naming ineligible players", () => {
    const text = formatPublicResultsMessage({
      winners: [
        { prizeRank: 1, displayName: "Sarah Connor", payoutCents: 250_00 },
        { prizeRank: 2, displayName: "Mike Jones", payoutCents: 150_00 },
        { prizeRank: 3, displayName: "Alex Reed", payoutCents: 100_00 }
      ],
      prizePoolCents: 500_00
    });

    expect(text).toContain("COMPETITION RESULTS");
    expect(text).toContain("🥇 1. Sarah Connor — $250.00");
    expect(text).toContain("🥈 2. Mike Jones — $150.00");
    expect(text).toContain("🥉 3. Alex Reed — $100.00");
    expect(text).toContain("💵 $500.00");
    expect(text).not.toMatch(/not subscribed|ineligible|NOT_ELIGIBLE/i);
    expect(text).not.toMatch(/\b2%\b|rateBps/i);
  });
});

describe("formatRankAnnouncement", () => {
  it("formats NEW #1 announcements premium-style", () => {
    expect(
      formatRankAnnouncement({
        displayName: "Sarah Connor",
        fromRank: 2,
        toRank: 1,
        reason: "reaching #1",
        kind: "REACHED_NUMBER_1",
        totalPoints: 742
      })
    ).toBe("👑 NEW #1\nSarah Connor just took the top spot with 742 points.");
  });

  it("formats climb announcements with optional gap copy", () => {
    expect(
      formatRankAnnouncement({
        displayName: "Homer",
        fromRank: 6,
        toRank: 3,
        reason: "entering Top 3",
        kind: "ENTER_TOP_3",
        pointsGained: 35,
        pointsBehindNext: 18
      })
    ).toBe("🔥 Homer moved #6 → #3!\n+35 points\nNow only 18 points behind #2.");
  });
});

describe("public leaderboard caption + keyboard", () => {
  it("keeps caption short", () => {
    expect(formatPublicLeaderboardCaption()).toBe("🔥 Competition is live. Keep climbing.");
    expect(formatPublicLeaderboardCaption({ competitionStatus: "FROZEN" })).toContain("frozen");
  });

  it("builds My Rank URL button only", () => {
    const kb = buildPublicLeaderboardKeyboard("AtlasBoardBot");
    expect(kb).toEqual({
      inline_keyboard: [[{ text: "🏆 My Rank", url: "https://t.me/AtlasBoardBot?start=rank" }]]
    });
    expect(buildPublicLeaderboardKeyboard(null)).toBeNull();
  });
});
