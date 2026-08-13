import { describe, expect, it } from "vitest";
import {
  formatPublicLeaderboardMessage,
  formatPublicResultsMessage,
  formatRankAnnouncement,
  PUBLIC_LEADERBOARD_SUBSCRIPTION_REMINDER
} from "./public-message";

const endsAt = new Date("2026-08-18T02:00:00.000Z");

describe("formatPublicLeaderboardMessage", () => {
  it("formats top 10 with medals, pool dollars, and exact subscription reminder", () => {
    const text = formatPublicLeaderboardMessage({
      title: "BIWEEKLY LEADERBOARD",
      top10: [
        { rank: 1, displayName: "John Smith", points: 720 },
        { rank: 2, displayName: "Sarah Connor", points: 681 },
        { rank: 3, displayName: "Mike Jones", points: 640 },
        { rank: 4, displayName: "Alex Reed", points: 610 },
        { rank: 10, displayName: "David Lee", points: 390 }
      ],
      prizePoolCents: 48_500,
      endsAt,
      timezone: "America/Chicago"
    });

    expect(text).toContain("🏆 BIWEEKLY LEADERBOARD");
    expect(text).toContain("🥇 1. John — 720 pts");
    expect(text).toContain("🥈 2. Sarah — 681 pts");
    expect(text).toContain("🥉 3. Mike — 640 pts");
    expect(text).toContain("4. Alex — 610 pts");
    expect(text).toContain("10. David — 390 pts");
    expect(text).toContain("Current Prize Pool: $485.00");
    expect(text).toContain(PUBLIC_LEADERBOARD_SUBSCRIPTION_REMINDER);
    expect(text).toContain(
      "To receive a prize, winners must be subscribed to this channel at the eligibility deadline."
    );
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
    expect(text).toContain(
      "➡️ Check your personal rank: https://t.me/AtlasBoardBot?start=rank"
    );
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
    expect(text).toContain("🥇 1. Sarah — $250.00");
    expect(text).toContain("🥈 2. Mike — $150.00");
    expect(text).toContain("🥉 3. Alex — $100.00");
    expect(text).toContain("Prize Pool: $500.00");
    expect(text).not.toMatch(/not subscribed|ineligible|NOT_ELIGIBLE/i);
    expect(text).not.toMatch(/\b2%\b|rateBps/i);
  });
});

describe("formatRankAnnouncement", () => {
  it("formats a short movement announcement", () => {
    expect(
      formatRankAnnouncement({
        displayName: "Sarah Connor",
        fromRank: 5,
        toRank: 2,
        reason: "earning +75 referral points"
      })
    ).toBe("🔥 Sarah moved from #5 → #2 after earning +75 referral points.");
  });
});
