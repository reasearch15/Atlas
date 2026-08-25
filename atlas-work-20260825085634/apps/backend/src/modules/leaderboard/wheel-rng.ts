import { randomInt } from "node:crypto";

export type WheelRng = { nextInt(maxExclusive: number): number };

/**
 * Cryptographic RNG for production spins. Tests inject a fake WheelRng.
 */
export function createCryptoWheelRng(): WheelRng {
  return {
    nextInt(maxExclusive: number): number {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new Error("nextInt maxExclusive must be a positive integer");
      }
      return randomInt(maxExclusive);
    }
  };
}

export interface WeightedOutcome {
  readonly points: number;
  readonly weight: number;
}

/**
 * Weighted selection over validated outcomes. `rng.nextInt(totalWeight)` picks the bucket.
 */
export function selectWeightedPoints(
  outcomes: readonly WeightedOutcome[],
  rng: WheelRng
): number {
  if (outcomes.length === 0) {
    throw new Error("Cannot select from empty wheel distribution");
  }
  let total = 0;
  for (const outcome of outcomes) {
    if (!(outcome.weight > 0) || !Number.isFinite(outcome.weight)) {
      throw new Error("Wheel outcome weight must be a positive finite number");
    }
    total += outcome.weight;
  }
  // Scale to integer space for nextInt when weights are non-integers.
  const scale = 1_000_000;
  const scaledTotal = Math.round(total * scale);
  if (scaledTotal <= 0) {
    throw new Error("Wheel distribution total weight must be positive");
  }
  let pick = rng.nextInt(scaledTotal);
  for (const outcome of outcomes) {
    const w = Math.round(outcome.weight * scale);
    if (pick < w) return outcome.points;
    pick -= w;
  }
  return outcomes[outcomes.length - 1]!.points;
}
