import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { buildWinnersPictureSvg, renderWinnersPictureCard, type WinnersPictureInput } from "./winners-picture-card";

const base: WinnersPictureInput = {
  brandName: "Atlas",
  startsAt: new Date("2026-09-01T00:00:00Z"),
  endsAt: new Date("2026-09-15T00:00:00Z"),
  timezone: "America/Chicago",
  prizePoolCents: 10_000,
  winners: [
    { prizeRank: 1, displayName: "One", payoutCents: 5_000 },
    { prizeRank: 2, displayName: "Two", payoutCents: 3_000 },
    { prizeRank: 3, displayName: "Three", payoutCents: 2_000 }
  ]
};

describe("winners picture card", () => {
  it("keeps Top 3 and adds the stored bonus winner to the same SVG", () => {
    const svg = buildWinnersPictureSvg({ ...base, bonusWinner: { displayName: "Bonus", leaderboardRank: 7, rewardAmountCents: 1_500 } });
    expect(svg).toContain("RANDOM FREE PLAY WINNER");
    expect(svg).toContain("Bonus");
    expect(svg).toContain("$15 FREE PLAY");
    expect(svg).toContain("LEADERBOARD RANK #7");
    expect(svg).toContain("1ST PLACE");
    expect(svg).toContain("3RD PLACE");
  });

  it("supports fewer Top 3 winners plus a bonus and no bonus at all", () => {
    expect(buildWinnersPictureSvg({ ...base, winners: base.winners.slice(0, 1), bonusWinner: { displayName: "Player", leaderboardRank: 4, rewardAmountCents: 1_500 } })).toContain("Player");
    expect(buildWinnersPictureSvg(base)).not.toContain("RANDOM FREE PLAY WINNER");
  });

  it("escapes special characters, preserves Unicode, and truncates long names", () => {
    const svg = buildWinnersPictureSvg({ ...base, bonusWinner: { displayName: "🎰 A&B <Winner> with an extremely long player name", leaderboardRank: 10, rewardAmountCents: 1_500 } });
    expect(svg).toContain("🎰 A&amp;B &lt;Winner&gt;");
    expect(svg).not.toContain("<Winner>");
    expect(svg).toContain("...");
  });

  it("renders a non-empty 1080 by 1580 PNG", async () => {
    const png = await renderWinnersPictureCard({ ...base, bonusWinner: { displayName: "Bonus", leaderboardRank: 5, rewardAmountCents: 1_500 } });
    const metadata = await sharp(png).metadata();
    expect(png.length).toBeGreaterThan(1_000);
    expect(metadata).toMatchObject({ format: "png", width: 1080, height: 1580 });
  });
});
