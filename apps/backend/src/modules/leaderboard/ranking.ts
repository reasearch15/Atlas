export interface RankableStanding {
  readonly crmContactId: string;
  readonly totalPoints: number;
  readonly pointsReachedAt: Date;
}

/**
 * Deterministic ranking:
 * 1) higher totalPoints
 * 2) earlier pointsReachedAt
 * 3) crmContactId ASC
 */
export function compareStandings(a: RankableStanding, b: RankableStanding): number {
  if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
  const aReached = a.pointsReachedAt.getTime();
  const bReached = b.pointsReachedAt.getTime();
  if (aReached !== bReached) return aReached - bReached;
  return a.crmContactId < b.crmContactId ? -1 : a.crmContactId > b.crmContactId ? 1 : 0;
}

export function sortStandings<T extends RankableStanding>(rows: readonly T[]): T[] {
  return [...rows].sort(compareStandings);
}

export function withRanks<T extends RankableStanding>(
  rows: readonly T[]
): Array<T & { rank: number }> {
  return sortStandings(rows).map((row, index) => ({ ...row, rank: index + 1 }));
}
