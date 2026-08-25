import {
  ALLOWED_POOL_RATE_BPS,
  CENTS_PER_DEPOSIT_POINT,
  FIRST_PLACE_PAYOUT_BPS,
  MAX_POOL_RATE_BPS,
  MIN_POOL_RATE_BPS,
  SECOND_PLACE_PAYOUT_BPS
} from "./leaderboard.constants";
import { invalidPoolRate } from "./leaderboard.errors";

/**
 * Deposit points from cumulative qualifying cents in the active competition.
 * floor(cents / 100) — $1 = 1 point. Splitting deposits cannot create extra points.
 */
export function depositPointsFromCumulativeCents(qualifyingDepositCents: number): number {
  if (qualifyingDepositCents <= 0) return 0;
  return Math.floor(qualifyingDepositCents / CENTS_PER_DEPOSIT_POINT);
}

/**
 * Pool contribution in cents using floor(amount * bps / 10000).
 */
export function poolContributionCents(amountCents: number, poolRateBps: number): number {
  assertAllowedPoolRate(poolRateBps);
  if (amountCents <= 0) return 0;
  return Math.floor((amountCents * poolRateBps) / 10000);
}

export function assertAllowedPoolRate(poolRateBps: number): void {
  if (
    !Number.isInteger(poolRateBps) ||
    poolRateBps < MIN_POOL_RATE_BPS ||
    poolRateBps > MAX_POOL_RATE_BPS ||
    !(ALLOWED_POOL_RATE_BPS as readonly number[]).includes(poolRateBps)
  ) {
    throw invalidPoolRate(poolRateBps);
  }
}

export interface RankedPayout {
  readonly rank: 1 | 2 | 3;
  readonly payoutCents: number;
}

/**
 * Deterministic prize split with no lost cents when at least one winner exists.
 * Three winners use the normal 50/30/remainder split.
 * Two winners redistribute the full pool using the relative 50:30 weighting.
 * One winner receives the full prize pool.
 */
export function splitPrizePool(
  prizePoolCents: number,
  winnerCount: 1 | 2 | 3 = 3
): readonly RankedPayout[] {
  if (!Number.isInteger(prizePoolCents) || prizePoolCents < 0) {
    throw new Error("prizePoolCents must be a non-negative integer");
  }
  if (winnerCount === 1) {
    return [{ rank: 1, payoutCents: prizePoolCents }];
  }
  if (winnerCount === 2) {
    const first = Math.floor(
      (prizePoolCents * FIRST_PLACE_PAYOUT_BPS) /
        (FIRST_PLACE_PAYOUT_BPS + SECOND_PLACE_PAYOUT_BPS)
    );
    return [
      { rank: 1, payoutCents: first },
      { rank: 2, payoutCents: prizePoolCents - first }
    ];
  }
  const first = Math.floor((prizePoolCents * FIRST_PLACE_PAYOUT_BPS) / 10000);
  const second = Math.floor((prizePoolCents * SECOND_PLACE_PAYOUT_BPS) / 10000);
  const third = prizePoolCents - first - second;
  return [
    { rank: 1, payoutCents: first },
    { rank: 2, payoutCents: second },
    { rank: 3, payoutCents: third }
  ];
}
