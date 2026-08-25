import { describe, expect, it } from "vitest";
import { WHEEL_ROLLING_WINDOW_MS } from "./wheel-qualification";
import {
  eventCountsTowardQualification,
  nextWheelSpinAt,
  qualificationOccurredAtFilter,
  sumConsumedQualificationCents,
  sumQualifyingDepositCents,
  wheelCooldownSatisfied
} from "./wheel-qualification";

const HOUR = 60 * 60 * 1000;

describe("wheel rolling qualification math", () => {
  it("includes a deposit at exactly 48h and excludes 48h+1ms", () => {
    const depositedAt = new Date("2026-08-15T13:29:00.000Z");
    const at48h = new Date(depositedAt.getTime() + WHEEL_ROLLING_WINDOW_MS);
    const after48h = new Date(at48h.getTime() + 1);
    expect(eventCountsTowardQualification(depositedAt, at48h, null)).toBe(true);
    expect(eventCountsTowardQualification(depositedAt, after48h, null)).toBe(false);
  });

  it("excludes deposits at or before lastSpinAt", () => {
    const lastSpinAt = new Date("2026-08-15T12:00:00.000Z");
    const before = new Date(lastSpinAt.getTime() - 1000);
    const atSpin = lastSpinAt;
    const after = new Date(lastSpinAt.getTime() + 1000);
    const now = new Date(lastSpinAt.getTime() + HOUR);
    expect(eventCountsTowardQualification(before, now, lastSpinAt)).toBe(false);
    expect(eventCountsTowardQualification(atSpin, now, lastSpinAt)).toBe(false);
    expect(eventCountsTowardQualification(after, now, lastSpinAt)).toBe(true);
  });

  it("cooldown is satisfied at exactly lastSpinAt+48h", () => {
    const lastSpinAt = new Date("2026-08-14T04:00:00.000Z");
    const next = nextWheelSpinAt(lastSpinAt)!;
    expect(next.getTime()).toBe(lastSpinAt.getTime() + WHEEL_ROLLING_WINDOW_MS);
    expect(wheelCooldownSatisfied(new Date(next.getTime() - 1), lastSpinAt)).toBe(false);
    expect(wheelCooldownSatisfied(next, lastSpinAt)).toBe(true);
  });

  it("qualificationOccurredAtFilter uses exclusive lastSpinAt when it is inside the window", () => {
    const lastSpinAt = new Date("2026-08-16T01:00:00.000Z");
    const now = new Date("2026-08-16T10:00:00.000Z");
    expect(qualificationOccurredAtFilter(now, lastSpinAt)).toEqual({
      gt: lastSpinAt,
      lte: now
    });
  });

  it("sums only in-window deposits and reversals", () => {
    const now = new Date("2026-08-16T10:00:00.000Z");
    const cents = sumQualifyingDepositCents(
      [
        { type: "DEPOSIT", depositAmountCents: 1000, occurredAt: new Date(now.getTime() - 49 * HOUR) },
        { type: "DEPOSIT", depositAmountCents: 1500, occurredAt: new Date(now.getTime() - 10 * HOUR) },
        { type: "DEPOSIT_REVERSAL", depositAmountCents: -500, occurredAt: new Date(now.getTime() - HOUR) }
      ],
      now,
      null
    );
    expect(cents).toBe(1000);
  });

  it("consumed-window sum includes later reversals but not later deposits", () => {
    const lastSpinAt = new Date("2026-08-15T12:00:00.000Z");
    const cents = sumConsumedQualificationCents(
      [
        { type: "DEPOSIT", depositAmountCents: 4000, occurredAt: new Date(lastSpinAt.getTime() - HOUR) },
        { type: "DEPOSIT", depositAmountCents: 2000, occurredAt: new Date(lastSpinAt.getTime() + HOUR) },
        { type: "DEPOSIT_REVERSAL", depositAmountCents: -1000, occurredAt: new Date(lastSpinAt.getTime() + 2 * HOUR) }
      ],
      lastSpinAt,
      null
    );
    expect(cents).toBe(3000);
  });
});
