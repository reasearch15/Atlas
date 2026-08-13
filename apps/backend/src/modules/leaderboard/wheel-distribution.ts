import { WHEEL_MAX_POINTS, WHEEL_MIN_POINTS } from "./leaderboard.constants";

/**
 * NO PRODUCTION DISTRIBUTION inventing here — validation only.
 * Approved weights live in approved-wheel-distribution.ts (Phase 6.1).
 */

export interface WheelDistributionOutcome {
  readonly points: number;
  readonly weight: number;
}

export interface ValidatedWheelDistribution {
  readonly outcomes: readonly WheelDistributionOutcome[];
  readonly totalWeight: number;
}

export class WheelDistributionError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "WheelDistributionError";
    this.code = code;
  }
}

/**
 * Validates rewardDistributionJson shape before publish/activate.
 * Rules: ≥1 outcome, points in [0,40] integers, weight > 0 finite, unique points preferred (required).
 */
export function validateWheelDistribution(
  raw: unknown
): ValidatedWheelDistribution {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new WheelDistributionError(
      "WHEEL_DISTRIBUTION_EMPTY",
      "Wheel distribution must include at least one outcome."
    );
  }

  const outcomes: WheelDistributionOutcome[] = [];
  const seenPoints = new Set<number>();
  let totalWeight = 0;

  for (const entry of raw) {
    if (entry == null || typeof entry !== "object") {
      throw new WheelDistributionError(
        "WHEEL_DISTRIBUTION_INVALID",
        "Each outcome must be an object with points and weight."
      );
    }
    const rawPoints = (entry as { points?: unknown }).points;
    const rawWeight = (entry as { weight?: unknown }).weight;
    if (
      typeof rawPoints !== "number" ||
      !Number.isInteger(rawPoints) ||
      rawPoints < WHEEL_MIN_POINTS ||
      rawPoints > WHEEL_MAX_POINTS
    ) {
      throw new WheelDistributionError(
        "WHEEL_DISTRIBUTION_POINTS",
        `Wheel points must be integers in [${WHEEL_MIN_POINTS}, ${WHEEL_MAX_POINTS}].`
      );
    }
    if (typeof rawWeight !== "number" || !(rawWeight > 0) || !Number.isFinite(rawWeight)) {
      throw new WheelDistributionError(
        "WHEEL_DISTRIBUTION_WEIGHT",
        "Wheel outcome weight must be a positive finite number."
      );
    }
    const points = rawPoints;
    const weight = rawWeight;
    if (seenPoints.has(points)) {
      throw new WheelDistributionError(
        "WHEEL_DISTRIBUTION_DUPLICATE_POINTS",
        `Duplicate points value ${points} in wheel distribution.`
      );
    }
    seenPoints.add(points);
    outcomes.push({ points, weight });
    totalWeight += weight;
  }

  if (!(totalWeight > 0)) {
    throw new WheelDistributionError(
      "WHEEL_DISTRIBUTION_WEIGHT",
      "Wheel distribution total weight must be positive."
    );
  }

  return { outcomes, totalWeight };
}

export function parseRewardDistributionJson(json: unknown): ValidatedWheelDistribution {
  return validateWheelDistribution(json);
}
