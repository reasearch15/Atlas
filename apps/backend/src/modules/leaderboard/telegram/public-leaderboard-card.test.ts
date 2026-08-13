import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildPublicLeaderboardCardSvg,
  computeRankMovement,
  formatCountdownLeft,
  formatPrizePoolHero,
  formatRankMovementLabel,
  isValidPngBuffer,
  LEADERBOARD_CARD_HEIGHT,
  LEADERBOARD_CARD_WIDTH,
  renderPublicLeaderboardCard,
  truncateLeaderboardName,
  type LeaderboardCardStanding
} from "./public-leaderboard-card";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SAMPLE_DIR = join(__dirname, "__fixtures__", "leaderboard-cards");

const NOW = new Date("2026-08-13T15:00:00.000Z");
const ENDS = new Date("2026-08-25T02:00:00.000Z"); // ~Tue Aug 25 9PM CDT-ish window

function standing(
  rank: number,
  displayName: string,
  points: number,
  movement?: LeaderboardCardStanding["movement"]
): LeaderboardCardStanding {
  return {
    rank,
    displayName,
    points,
    ...(movement ? { movement } : {})
  };
}

const FULL_TEN: LeaderboardCardStanding[] = [
  standing(1, "Picasso", 67, { kind: "same" }),
  standing(2, "Skylar", 51, { kind: "up", delta: 2 }),
  standing(3, "Alex", 46, { kind: "down", delta: 1 }),
  standing(4, "Jordan", 41, { kind: "up", delta: 1 }),
  standing(5, "Riley", 38),
  standing(6, "Casey", 35, { kind: "down", delta: 2 }),
  standing(7, "Morgan", 30, { kind: "new" }),
  standing(8, "Quinn", 28),
  standing(9, "Avery", 22),
  standing(10, "Reese", 18)
];

describe("public-leaderboard-card helpers", () => {
  it("formats prize pool hero amounts without clipping", () => {
    expect(formatPrizePoolHero(100)).toBe("$1");
    expect(formatPrizePoolHero(25000)).toBe("$250");
    expect(formatPrizePoolHero(100_000)).toBe("$1,000");
    expect(formatPrizePoolHero(1_000_000)).toBe("$10,000");
    expect(formatPrizePoolHero(12_345_678)).toBe("$123,456.78");
  });

  it("formats countdown buckets", () => {
    expect(formatCountdownLeft(new Date(NOW.getTime() + 4 * 86400_000 + 12 * 3600_000), NOW)).toBe(
      "4D 12H LEFT"
    );
    expect(formatCountdownLeft(new Date(NOW.getTime() - 1000), NOW)).toBe("ENDED");
  });

  it("computes rank movement safely", () => {
    expect(computeRankMovement("a", 1, null)).toBeNull();
    expect(computeRankMovement("a", 1, [])).toBeNull();
    expect(computeRankMovement("a", 1, [{ crmContactId: "b", rank: 1 }])).toEqual({ kind: "new" });
    expect(computeRankMovement("a", 1, [{ crmContactId: "a", rank: 3 }])).toEqual({
      kind: "up",
      delta: 2
    });
    expect(computeRankMovement("a", 4, [{ crmContactId: "a", rank: 2 }])).toEqual({
      kind: "down",
      delta: 2
    });
    expect(formatRankMovementLabel({ kind: "up", delta: 2 })).toBe("▲2");
    expect(formatRankMovementLabel({ kind: "down", delta: 1 })).toBe("▼1");
    expect(formatRankMovementLabel({ kind: "same" })).toBe("—");
    expect(formatRankMovementLabel({ kind: "new" })).toBe("NEW");
  });

  it("truncates unicode names safely", () => {
    expect(truncateLeaderboardName("Picasso", 14)).toBe("Picasso");
    expect(truncateLeaderboardName("AlexanderTheGreat123", 14).endsWith("…")).toBe(true);
    expect(truncateLeaderboardName("🔥PLAYER🔥EXTRA", 8).includes("…")).toBe(true);
    expect(truncateLeaderboardName("José", 14)).toBe("José");
  });
});

describe("renderPublicLeaderboardCard", () => {
  async function assertPng(input: Parameters<typeof renderPublicLeaderboardCard>[0]) {
    const result = await renderPublicLeaderboardCard(input);
    expect(isValidPngBuffer(result.png)).toBe(true);
    expect(result.width).toBe(LEADERBOARD_CARD_WIDTH);
    expect(result.height).toBe(LEADERBOARD_CARD_HEIGHT);
    expect(result.imageBytes).toBeGreaterThan(5_000);
    expect(result.renderMs).toBeLessThan(5_000);
    const meta = await (await import("sharp")).default(result.png).metadata();
    expect(meta.width).toBe(LEADERBOARD_CARD_WIDTH);
    expect(meta.height).toBe(LEADERBOARD_CARD_HEIGHT);
    expect(meta.format).toBe("png");
    return result;
  }

  it("renders 0 players", async () => {
    await assertPng({
      brandName: "SAYU GAMING HUB",
      prizePoolCents: 25000,
      endsAt: ENDS,
      timezone: "America/Chicago",
      competitionStatus: "ACTIVE",
      standings: [],
      now: NOW
    });
  });

  it("renders 1–3 players and full top 10", async () => {
    await assertPng({
      brandName: "SAYU GAMING HUB",
      prizePoolCents: 100,
      endsAt: ENDS,
      timezone: "America/Chicago",
      competitionStatus: "ACTIVE",
      standings: [standing(1, "Solo", 0)],
      now: NOW
    });
    await assertPng({
      brandName: "SAYU GAMING HUB",
      prizePoolCents: 100,
      endsAt: ENDS,
      timezone: "America/Chicago",
      competitionStatus: "ACTIVE",
      standings: [standing(1, "A", 10), standing(2, "B", 5)],
      now: NOW
    });
    await assertPng({
      brandName: "SAYU GAMING HUB",
      prizePoolCents: 100,
      endsAt: ENDS,
      timezone: "America/Chicago",
      competitionStatus: "ACTIVE",
      standings: [standing(1, "A", 10), standing(2, "B", 5), standing(3, "C", 1)],
      now: NOW
    });
    await assertPng({
      brandName: "SAYU GAMING HUB",
      prizePoolCents: 25000,
      endsAt: ENDS,
      timezone: "America/Chicago",
      competitionStatus: "ACTIVE",
      standings: FULL_TEN,
      now: NOW
    });
  });

  it("handles prize sizes, long/unicode names, large points, frozen", async () => {
    for (const cents of [100, 25000, 100_000, 1_000_000, 12_345_678]) {
      await assertPng({
        brandName: "SAYU GAMING HUB",
        prizePoolCents: cents,
        endsAt: ENDS,
        timezone: "America/Chicago",
        competitionStatus: "ACTIVE",
        standings: FULL_TEN,
        now: NOW
      });
    }

    await assertPng({
      brandName: "SAYU GAMING HUB",
      prizePoolCents: 25000,
      endsAt: ENDS,
      timezone: "America/Chicago",
      competitionStatus: "ACTIVE",
      standings: [
        standing(1, "AlexanderTheGreat123", 999_999),
        standing(2, "🔥PLAYER🔥", 50),
        standing(3, "José María", 40),
        standing(4, "Владимир", 30),
        standing(5, "玩家名字很长", 20)
      ],
      now: NOW
    });

    await assertPng({
      brandName: "SAYU GAMING HUB",
      prizePoolCents: 25000,
      endsAt: new Date(NOW.getTime() + 45 * 60_000),
      timezone: "America/Chicago",
      competitionStatus: "ACTIVE",
      standings: FULL_TEN.slice(0, 3),
      now: NOW
    });

    await assertPng({
      brandName: "SAYU GAMING HUB",
      prizePoolCents: 25000,
      endsAt: ENDS,
      timezone: "America/Chicago",
      competitionStatus: "FROZEN",
      standings: FULL_TEN,
      now: NOW,
      theme: "FROZEN"
    });
  });

  it("SVG includes empty-state copy and prize text", () => {
    const svg = buildPublicLeaderboardCardSvg({
      brandName: "SAYU GAMING HUB",
      prizePoolCents: 25000,
      endsAt: ENDS,
      timezone: "America/Chicago",
      competitionStatus: "ACTIVE",
      standings: [],
      now: NOW
    });
    expect(svg).toContain("The race starts here.");
    expect(svg).toContain("$250");
  });

  it("writes visual inspection sample PNGs", async () => {
    mkdirSync(SAMPLE_DIR, { recursive: true });

    const samples: Array<{ name: string; cents: number; standings: LeaderboardCardStanding[] }> = [
      { name: "sample-1-250-full10.png", cents: 25000, standings: FULL_TEN },
      { name: "after-250-full10.png", cents: 25000, standings: FULL_TEN },
      {
        name: "sample-2-1-three.png",
        cents: 100,
        standings: [standing(1, "Picasso", 12), standing(2, "Skylar", 8), standing(3, "Alex", 3)]
      },
      {
        name: "sample-3-10000-long-names.png",
        cents: 1_000_000,
        standings: [
          standing(1, "AlexanderTheGreat123", 901),
          standing(2, "SuperLongDisplayNameXYZ", 880),
          standing(3, "🔥ChampionKing🔥", 850),
          standing(4, "JoséMaríaGonzález", 720),
          standing(5, "PlayerWithVeryLongHandle99", 610),
          standing(6, "AnotherExtremelyLongUser", 500),
          standing(7, "Shorty", 400),
          standing(8, "中文昵称测试选手", 300),
          standing(9, "ВладимирИванов", 200),
          standing(10, "Quinn", 100)
        ]
      }
    ];

    const renderTimes: number[] = [];
    for (const sample of samples) {
      const result = await renderPublicLeaderboardCard({
        brandName: "SAYU GAMING HUB",
        prizePoolCents: sample.cents,
        endsAt: ENDS,
        timezone: "America/Chicago",
        competitionStatus: "ACTIVE",
        standings: sample.standings,
        now: NOW
      });
      writeFileSync(join(SAMPLE_DIR, sample.name), result.png);
      expect(isValidPngBuffer(result.png)).toBe(true);
      renderTimes.push(result.renderMs);
    }

    // Telegram-ish mobile preview (~420px wide in chat).
    const full = await renderPublicLeaderboardCard({
      brandName: "SAYU GAMING HUB",
      prizePoolCents: 25000,
      endsAt: ENDS,
      timezone: "America/Chicago",
      competitionStatus: "ACTIVE",
      standings: FULL_TEN,
      now: NOW
    });
    const mobile = await (await import("sharp")).default(full.png)
      .resize(420, Math.round((420 * LEADERBOARD_CARD_HEIGHT) / LEADERBOARD_CARD_WIDTH), {
        fit: "fill"
      })
      .png()
      .toBuffer();
    writeFileSync(join(SAMPLE_DIR, "mobile-preview-420.png"), mobile);
    expect(isValidPngBuffer(mobile)).toBe(true);
    expect(Math.max(...renderTimes)).toBeLessThan(5000);
  });
});
