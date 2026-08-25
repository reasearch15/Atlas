/**
 * Formats prize pool cents as a dollar string with two decimals.
 * Never includes contribution rates or percentages.
 */
export function formatPrizePoolDisplay(cents: number): string {
  const safe = Number.isFinite(cents) ? Math.max(0, Math.trunc(cents)) : 0;
  return `$${(safe / 100).toFixed(2)}`;
}

export interface StandingGapRow {
  readonly rank: number;
  readonly crmContactId: string;
  readonly totalPoints: number;
}

export interface StandingGaps {
  readonly gapToNextRankPoints: number | null;
  readonly gapToTop3Points: number | null;
  readonly pointsAbove: number | null;
  readonly pointsToTop10: number | null;
  readonly pointsToTop3: number | null;
  readonly isFirst: boolean;
}

/**
 * Computes rank gaps for standings DTOs and Give Info messaging.
 * `ranked` must already be ordered with dense ranks (1..n) via withRanks.
 */
export function computeStandingGaps(
  ranked: readonly StandingGapRow[],
  crmContactId: string
): StandingGaps | null {
  const index = ranked.findIndex((row) => row.crmContactId === crmContactId);
  if (index < 0) return null;

  const me = ranked[index]!;
  const isFirst = me.rank === 1;
  const above = index > 0 ? ranked[index - 1]! : null;
  const second = ranked.length > 1 ? ranked[1]! : null;
  const third = ranked.length >= 3 ? ranked[2]! : null;
  const tenth = ranked.length >= 10 ? ranked[9]! : null;

  const pointsAbove = isFirst
    ? second != null
      ? Math.max(0, me.totalPoints - second.totalPoints)
      : null
    : above != null
      ? Math.max(0, above.totalPoints - me.totalPoints)
      : null;

  const gapToNextRankPoints = isFirst
    ? null
    : above != null
      ? Math.max(0, above.totalPoints - me.totalPoints)
      : null;

  const gapToTop3Points =
    me.rank <= 3 || third == null ? null : Math.max(0, third.totalPoints - me.totalPoints);

  const pointsToTop3 = gapToTop3Points;

  const pointsToTop10 =
    me.rank <= 10 || tenth == null ? null : Math.max(0, tenth.totalPoints - me.totalPoints);

  return {
    gapToNextRankPoints,
    gapToTop3Points,
    pointsAbove,
    pointsToTop10,
    pointsToTop3,
    isFirst
  };
}
