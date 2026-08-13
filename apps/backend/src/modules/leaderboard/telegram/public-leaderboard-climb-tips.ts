/**
 * Player-facing "how to climb" copy for the public leaderboard card.
 * Derived from Atlas scoring constants / live wheel config — never invents disabled paths.
 */

import {
  CENTS_PER_DEPOSIT_POINT,
  MAX_REFERRAL_POINTS_PER_REFERRED,
  WHEEL_CYCLE_HOURS,
  WHEEL_MAX_POINTS,
  WHEEL_QUALIFICATION_CENTS
} from "../leaderboard.constants";

export interface LeaderboardClimbTip {
  readonly icon: string;
  readonly title: string;
  readonly detail: string;
}

export interface BuildClimbTipsInput {
  /** Deposit scoring is always active when a public board posts. */
  readonly includeDeposit?: boolean;
  readonly includeReferral?: boolean;
  readonly includePromotions?: boolean;
  /** Only include when the owner's wheel is enabled + configured. */
  readonly includeWheel?: boolean;
  readonly centsPerDepositPoint?: number;
  readonly wheelQualificationCents?: number;
  readonly wheelMaxPoints?: number;
  readonly wheelCycleHours?: number;
  readonly maxReferralPointsPerReferred?: number;
}

function formatDollarsFromCents(cents: number): string {
  const dollars = cents / 100;
  if (Number.isInteger(dollars)) return `$${dollars.toLocaleString("en-US")}`;
  return `$${dollars.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

/**
 * Build compact climb tips from real Atlas rules.
 * Omits any channel the caller marks disabled/unavailable.
 */
export function buildPublicLeaderboardClimbTips(
  input: BuildClimbTipsInput = {}
): readonly LeaderboardClimbTip[] {
  const tips: LeaderboardClimbTip[] = [];
  const centsPerPoint = input.centsPerDepositPoint ?? CENTS_PER_DEPOSIT_POINT;
  const wheelQual = input.wheelQualificationCents ?? WHEEL_QUALIFICATION_CENTS;
  const wheelMax = input.wheelMaxPoints ?? WHEEL_MAX_POINTS;
  const wheelHours = input.wheelCycleHours ?? WHEEL_CYCLE_HOURS;
  const maxReferral = input.maxReferralPointsPerReferred ?? MAX_REFERRAL_POINTS_PER_REFERRED;

  if (input.includeDeposit !== false) {
    tips.push({
      icon: "💵",
      title: "DEPOSIT",
      detail: `${formatDollarsFromCents(centsPerPoint)} = 1 PT`
    });
  }

  if (input.includeReferral !== false) {
    tips.push({
      icon: "🤝",
      title: "REFER",
      detail: `Milestones up to ${maxReferral} PTS`
    });
  }

  if (input.includePromotions !== false) {
    tips.push({
      icon: "🎁",
      title: "PROMOTIONS",
      detail: "Verified promo bonuses"
    });
  }

  if (input.includeWheel === true) {
    tips.push({
      icon: "🎡",
      title: `${wheelHours}H WHEEL`,
      detail: `${formatDollarsFromCents(wheelQual)}+ → spin up to ${wheelMax} PTS`
    });
  }

  return tips;
}

/** Extract max spin points from a published wheel distribution JSON, if present. */
export function maxWheelPointsFromDistribution(json: unknown): number | null {
  if (!Array.isArray(json)) return null;
  let max = 0;
  let found = false;
  for (const entry of json) {
    if (!entry || typeof entry !== "object") continue;
    const points = (entry as { points?: unknown }).points;
    if (typeof points === "number" && Number.isFinite(points)) {
      found = true;
      max = Math.max(max, Math.trunc(points));
    }
  }
  return found ? max : null;
}
