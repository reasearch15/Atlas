/** Leaderboard constants. Pool percentage is internal/private. */

export const LEADERBOARD_TIMEZONE = "America/Chicago" as const;

/** Biweekly grid origin: Tuesday 2024-01-02 21:00 America/Chicago. */
export const LEADERBOARD_EPOCH_ISO_CHICAGO = "2024-01-02T21:00:00";

export const COMPETITION_DURATION_DAYS = 14;

export const DEFAULT_POOL_RATE_BPS = 200;
export const MIN_POOL_RATE_BPS = 200;
export const MAX_POOL_RATE_BPS = 500;
/** Phase 1.2 keeps configurable 2–5% in code; product direction defaults to 2%. */
export const ALLOWED_POOL_RATE_BPS = [200, 300, 400, 500] as const;

/** $1 qualifying deposit = 100 cents → 1 deposit point. */
export const CENTS_PER_DEPOSIT_POINT = 100;

/**
 * Idempotent ACTIVE-competition migration from legacy $5=1 deposit scoring to $1=1.
 * See deposit-scoring-reconciliation.ts.
 */
export const DEPOSIT_SCORING_RECONCILIATION_REASON = "active_deposit_scoring_v2_reconciliation" as const;

export const PROMOTION_WINDOW_MS = 24 * 60 * 60 * 1000;

export const REFERRAL_MILESTONES = [
  { code: "FIRST_10" as const, thresholdCents: 1000, points: 25 },
  { code: "CUM_50" as const, thresholdCents: 5000, points: 50 },
  { code: "CUM_100" as const, thresholdCents: 10000, points: 75 },
  { code: "CUM_250" as const, thresholdCents: 25000, points: 150 }
] as const;

export type ReferralMilestoneCodeValue = (typeof REFERRAL_MILESTONES)[number]["code"];

/** Max referral milestone points from one referred player. */
export const MAX_REFERRAL_POINTS_PER_REFERRED = 300;

export const FIRST_PLACE_PAYOUT_BPS = 5000;
export const SECOND_PLACE_PAYOUT_BPS = 3000;
