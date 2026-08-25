import { describe, expect, it } from "vitest";
import { validateWheelDistribution } from "./wheel-distribution";
import { selectWeightedPoints, type WheelRng } from "./wheel-rng";

describe("wheel-distribution", () => {
  it("rejects empty / invalid / out-of-range / duplicate points", () => {
    expect(() => validateWheelDistribution([])).toThrow(/at least one/i);
    expect(() => validateWheelDistribution([{ points: 41, weight: 1 }])).toThrow(/0, 40/);
    expect(() => validateWheelDistribution([{ points: 10, weight: 0 }])).toThrow(/weight/i);
    expect(() =>
      validateWheelDistribution([
        { points: 10, weight: 1 },
        { points: 10, weight: 2 }
      ])
    ).toThrow(/Duplicate/);
  });

  it("accepts injected test distributions (no production default)", () => {
    const validated = validateWheelDistribution([
      { points: 0, weight: 1 },
      { points: 40, weight: 3 }
    ]);
    expect(validated.outcomes).toHaveLength(2);
    expect(validated.totalWeight).toBe(4);
  });

  it("selectWeightedPoints uses injected RNG", () => {
    const outcomes = [
      { points: 0, weight: 1 },
      { points: 40, weight: 1 }
    ];
    const alwaysZero: WheelRng = { nextInt: () => 0 };
    const alwaysOne: WheelRng = {
      nextInt: (max) => {
        expect(max).toBeGreaterThan(0);
        return max - 1;
      }
    };
    expect(selectWeightedPoints(outcomes, alwaysZero)).toBe(0);
    expect(selectWeightedPoints(outcomes, alwaysOne)).toBe(40);
  });

  it("documents no production distribution selected", () => {
    // NO PRODUCTION DISTRIBUTION SELECTED — module has no default weights export.
    expect("DEFAULT_WHEEL_DISTRIBUTION" in globalThis).toBe(false);
  });
});
