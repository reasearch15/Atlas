import { describe, expect, it } from "vitest";
import type { FreeplayStaffStatusDto } from "@atlas/shared";
import {
  buildFreeplayPlayerMessage,
  formatFreeplaySpinResultMessage,
  toFreeplayPlayerStatusDto
} from "./freeplay.messages";

describe("freeplay visibility rules", () => {
  it("player status never exposes the real $50 threshold or progress counters", () => {
    const dto = toFreeplayPlayerStatusDto({
      status: "NOT_ELIGIBLE",
      nextAvailableAt: null
    });
    expect(JSON.stringify(dto)).not.toContain("$50");
    expect(JSON.stringify(dto)).not.toContain("5000");
    expect(dto).not.toHaveProperty("thresholdCents");
    expect(dto).not.toHaveProperty("qualifyingRemainderCents");
    expect(dto).not.toHaveProperty("earnedSpinCredits");
  });

  it("Telegram/player not-eligible messaging hints at leaderboard activity without naming $50", () => {
    const message = buildFreeplayPlayerMessage("NOT_ELIGIBLE", null);
    expect(message).toContain("leaderboard points");
    expect(message).not.toContain("$50");
    expect(message).not.toContain("5000");
  });

  it("player rolling-limit state exposes only safe cooldown information", () => {
    const dto = toFreeplayPlayerStatusDto({
      status: "ROLLING_LIMIT",
      nextAvailableAt: "2026-08-16T03:22:00.000Z"
    });
    expect(dto.canSpin).toBe(false);
    expect(dto.nextAvailableAt).toBe("2026-08-16T03:22:00.000Z");
    expect(dto.playerMessage).toContain("24-hour window");
    expect(dto.playerMessage).not.toContain("$50");
  });

  it("eligible player status is safe and spin-enabled", () => {
    const dto = toFreeplayPlayerStatusDto({ status: "ELIGIBLE", nextAvailableAt: null });
    expect(dto.canSpin).toBe(true);
    expect(dto.playerMessage).toContain("Freeplay Wheel is ready");
    expect(JSON.stringify(dto)).not.toContain("threshold");
  });

  it("staff status can expose the real threshold and internal counters", () => {
    const staff: FreeplayStaffStatusDto = {
      eligible: false,
      playerStatus: "NOT_ELIGIBLE",
      thresholdCents: 5000,
      qualifyingRemainderCents: 3700,
      earnedSpinCredits: 0,
      consumedSpinCredits: 0,
      availableEconomicCredits: 0,
      spinsInRollingWindow: 0,
      maxSpinsPerWindow: 2,
      nextAvailableAt: null,
      eligibilityReason: "NO_EARNED_CREDIT",
      claims: []
    };
    expect(staff.thresholdCents).toBe(5000);
    expect(staff.qualifyingRemainderCents).toBe(3700);
  });

  it("$0 result still has player-safe copy", () => {
    const message = formatFreeplaySpinResultMessage(0);
    expect(message).toContain("No Freeplay this time");
    expect(message).toContain("leaderboard points");
    expect(message).not.toContain("$50");
  });

  it("positive result tells the player staff must load the reward", () => {
    const message = formatFreeplaySpinResultMessage(200);
    expect(message).toContain("$2 Freeplay");
    expect(message).toContain("staff to load");
  });
});
