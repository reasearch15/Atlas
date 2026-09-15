import { describe, expect, it } from "vitest";
import { leaderboardRandomFreeplayIdempotencyKey, resolveLeaderboardBonusPool } from "./leaderboard-bonus-award";

const row = (leaderboardRank: number, membershipStatus: "ELIGIBLE" | "NOT_ELIGIBLE" | "PENDING_REVIEW") => ({
  crmContactId: `player-${leaderboardRank}`,
  leaderboardRank,
  membershipStatus
});

describe("leaderboard random Free Play candidate pool", () => {
  it("uses only eligible literal frozen ranks 4 through 10", () => {
    const result = resolveLeaderboardBonusPool([
      row(3, "ELIGIBLE"), row(4, "NOT_ELIGIBLE"), row(5, "ELIGIBLE"), row(10, "ELIGIBLE"), row(11, "ELIGIBLE")
    ]);
    expect(result).toEqual({ ok: true, candidates: [row(5, "ELIGIBLE"), row(10, "ELIGIBLE")] });
  });

  it("blocks on pending review inside the range", () => {
    expect(resolveLeaderboardBonusPool([row(4, "ELIGIBLE"), row(7, "PENDING_REVIEW")])).toEqual({
      ok: false,
      pendingCrmContactIds: ["player-7"]
    });
  });

  it("ignores pending review outside the range", () => {
    expect(resolveLeaderboardBonusPool([row(3, "PENDING_REVIEW"), row(4, "ELIGIBLE"), row(11, "PENDING_REVIEW")])).toEqual({
      ok: true,
      candidates: [row(4, "ELIGIBLE")]
    });
  });

  it("supports exactly four players and fewer than ten", () => {
    expect(resolveLeaderboardBonusPool([row(1, "ELIGIBLE"), row(2, "ELIGIBLE"), row(3, "ELIGIBLE"), row(4, "ELIGIBLE")])).toEqual({
      ok: true,
      candidates: [row(4, "ELIGIBLE")]
    });
  });

  it("returns an empty pool with fewer than four or no eligible in-range players", () => {
    expect(resolveLeaderboardBonusPool([row(1, "ELIGIBLE"), row(2, "ELIGIBLE"), row(3, "ELIGIBLE")])).toEqual({ ok: true, candidates: [] });
    expect(resolveLeaderboardBonusPool([row(4, "NOT_ELIGIBLE"), row(5, "NOT_ELIGIBLE")])).toEqual({ ok: true, candidates: [] });
  });

  it("uses a stable competition-derived claim key", () => {
    expect(leaderboardRandomFreeplayIdempotencyKey("competition-1")).toBe("leaderboard-random-freeplay:competition-1");
  });
});
