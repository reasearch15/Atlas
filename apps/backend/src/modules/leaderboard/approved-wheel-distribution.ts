/**
 * Phase 6.1 — APPROVED production wheel reward distribution.
 *
 * Locked product probabilities (do not change without explicit product approval):
 * 0→8%, 5→18%, 10→24%, 15→20%, 20→14%, 25→8%, 30→5%, 35→2%, 40→1%
 *
 * Expected value = 13.7 points/spin (deterministic Σ p·w / Σw).
 * Note: brief figure 13.45 was arithmetic error; locked weights yield 13.7.
 * Players must NOT be shown these percentages.
 */
import type { WheelDistributionOutcome } from "./wheel-distribution";
import { validateWheelDistribution } from "./wheel-distribution";

export const APPROVED_WHEEL_DISTRIBUTION_CODE = "APPROVED_V1_100" as const;

/**
 * Weights sum to 100 (= percentages).
 */
export const APPROVED_WHEEL_DISTRIBUTION: readonly WheelDistributionOutcome[] = [
  { points: 0, weight: 8 },
  { points: 5, weight: 18 },
  { points: 10, weight: 24 },
  { points: 15, weight: 20 },
  { points: 20, weight: 14 },
  { points: 25, weight: 8 },
  { points: 30, weight: 5 },
  { points: 35, weight: 2 },
  { points: 40, weight: 1 }
] as const;

export const APPROVED_WHEEL_EXPECTED_VALUE = 13.7;

/**
 * Returns a validated copy of the approved distribution.
 */
export function getApprovedWheelDistribution() {
  return validateWheelDistribution([...APPROVED_WHEEL_DISTRIBUTION]);
}

/**
 * Deterministic expected value: Σ(points × weight) / totalWeight.
 */
export function expectedValueFromDistribution(
  outcomes: readonly WheelDistributionOutcome[]
): number {
  const validated = validateWheelDistribution([...outcomes]);
  let sum = 0;
  for (const outcome of validated.outcomes) {
    sum += outcome.points * outcome.weight;
  }
  return sum / validated.totalWeight;
}

/**
 * True when outcomes match the approved table (points + weights), order-insensitive.
 */
export function isApprovedWheelDistribution(raw: unknown): boolean {
  try {
    const validated = validateWheelDistribution(raw);
    if (validated.outcomes.length !== APPROVED_WHEEL_DISTRIBUTION.length) return false;
    if (validated.totalWeight !== 100) return false;
    const byPoints = new Map(validated.outcomes.map((o) => [o.points, o.weight]));
    for (const expected of APPROVED_WHEEL_DISTRIBUTION) {
      if (byPoints.get(expected.points) !== expected.weight) return false;
    }
    return true;
  } catch {
    return false;
  }
}
