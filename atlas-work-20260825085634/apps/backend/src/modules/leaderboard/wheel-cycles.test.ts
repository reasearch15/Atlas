import { describe, expect, it } from "vitest";
import { competitionWindowContaining } from "./competition-schedule";
import { assertCycleSequence, cycleContaining, listCycles } from "./wheel-cycles";
import { WHEEL_CYCLES_PER_COMPETITION } from "./leaderboard.constants";

describe("wheel-cycles", () => {
  it("lists exactly 7 half-open cycles covering a Chicago competition window", () => {
    // Mid-summer Chicago window (no DST transition inside).
    const window = competitionWindowContaining(new Date("2026-07-08T03:00:00.000Z"));
    const competition = { id: "c1", startsAt: window.startsAt, endsAt: window.endsAt };
    const cycles = listCycles(competition);
    expect(cycles).toHaveLength(WHEEL_CYCLES_PER_COMPETITION);
    assertCycleSequence(cycles);
    expect(cycles[0]!.startsAt.getTime()).toBe(window.startsAt.getTime());
    expect(cycles[6]!.endsAt.getTime()).toBe(window.endsAt.getTime());
    for (let i = 0; i < 6; i += 1) {
      expect(cycles[i]!.endsAt.getTime()).toBe(cycles[i + 1]!.startsAt.getTime());
    }
  });

  it("assigns cycleEnd instant to the next cycle (half-open)", () => {
    const window = competitionWindowContaining(new Date("2026-07-08T03:00:00.000Z"));
    const competition = { id: "c1", startsAt: window.startsAt, endsAt: window.endsAt };
    const cycles = listCycles(competition);
    const boundary = cycles[0]!.endsAt;
    expect(cycleContaining(competition, boundary)?.sequence).toBe(2);
    expect(cycleContaining(competition, new Date(boundary.getTime() - 1))?.sequence).toBe(1);
  });

  it("handles DST via Chicago schedule competition bounds", () => {
    // Competition spanning US spring-forward (March) — duration ≠ 14*24h UTC.
    const aroundDst = competitionWindowContaining(new Date("2026-03-10T12:00:00.000Z"));
    const competition = { id: "dst", startsAt: aroundDst.startsAt, endsAt: aroundDst.endsAt };
    const cycles = listCycles(competition);
    expect(cycles).toHaveLength(7);
    assertCycleSequence(cycles);
    const mid = new Date(
      (aroundDst.startsAt.getTime() + aroundDst.endsAt.getTime()) / 2
    );
    const containing = cycleContaining(competition, mid);
    expect(containing).not.toBeNull();
    expect(containing!.sequence).toBeGreaterThanOrEqual(1);
    expect(containing!.sequence).toBeLessThanOrEqual(7);
  });

  it("returns null outside competition window", () => {
    const window = competitionWindowContaining(new Date("2026-07-08T03:00:00.000Z"));
    const competition = { id: "c1", startsAt: window.startsAt, endsAt: window.endsAt };
    expect(cycleContaining(competition, new Date(window.startsAt.getTime() - 1))).toBeNull();
    expect(cycleContaining(competition, window.endsAt)).toBeNull();
  });
});
