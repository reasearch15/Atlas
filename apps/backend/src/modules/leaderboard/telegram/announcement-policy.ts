/**
 * Conservative public channel announcement policy.
 * Announce threshold crossings and Top 3 reorders — never every point tick.
 */

export type AnnouncementKind =
  | "ENTER_TOP_10"
  | "ENTER_TOP_3"
  | "REACHED_NUMBER_1"
  | "TOP_3_ORDER_CHANGED";

export interface AnnouncementStandingRow {
  readonly crmContactId: string;
  readonly rank: number;
  readonly displayName: string;
  readonly totalPoints?: number;
}

export interface AnnouncementEvent {
  readonly kind: AnnouncementKind;
  readonly crmContactId: string;
  readonly displayName: string;
  readonly fromRank: number | null;
  readonly toRank: number;
  /** Short reason fragment for formatRankAnnouncement. */
  readonly reason: string;
}

const KIND_PRIORITY: Record<AnnouncementKind, number> = {
  REACHED_NUMBER_1: 4,
  ENTER_TOP_3: 3,
  ENTER_TOP_10: 2,
  TOP_3_ORDER_CHANGED: 1
};

/**
 * Diff previous vs next Top 10 snapshots and return meaningful announcement events only.
 */
export function detectRankAnnouncements(
  prevTop10: readonly AnnouncementStandingRow[],
  nextTop10: readonly AnnouncementStandingRow[]
): AnnouncementEvent[] {
  const prevById = indexByContact(prevTop10);
  const nextOrdered = [...nextTop10].sort((a, b) => a.rank - b.rank);
  const events: AnnouncementEvent[] = [];

  for (const row of nextOrdered) {
    if (row.rank < 1 || row.rank > 10) continue;
    const prev = prevById.get(row.crmContactId);
    const fromRank = prev?.rank ?? null;
    const toRank = row.rank;

    if (toRank === 1 && fromRank !== 1) {
      events.push({
        kind: "REACHED_NUMBER_1",
        crmContactId: row.crmContactId,
        displayName: row.displayName,
        fromRank,
        toRank,
        reason: "reaching #1"
      });
      continue;
    }

    if (toRank <= 3 && (fromRank == null || fromRank > 3)) {
      events.push({
        kind: "ENTER_TOP_3",
        crmContactId: row.crmContactId,
        displayName: row.displayName,
        fromRank,
        toRank,
        reason: "entering Top 3"
      });
      continue;
    }

    if (toRank <= 10 && (fromRank == null || fromRank > 10)) {
      events.push({
        kind: "ENTER_TOP_10",
        crmContactId: row.crmContactId,
        displayName: row.displayName,
        fromRank,
        toRank,
        reason: "entering Top 10"
      });
      continue;
    }

    if (
      toRank <= 3 &&
      fromRank != null &&
      fromRank <= 3 &&
      fromRank !== toRank &&
      top3OrderChanged(prevTop10, nextTop10)
    ) {
      events.push({
        kind: "TOP_3_ORDER_CHANGED",
        crmContactId: row.crmContactId,
        displayName: row.displayName,
        fromRank,
        toRank,
        reason: "a Top 3 reorder"
      });
    }
  }

  return events.sort((a, b) => {
    const byKind = KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind];
    if (byKind !== 0) return byKind;
    return a.toRank - b.toRank;
  });
}

function indexByContact(
  rows: readonly AnnouncementStandingRow[]
): Map<string, AnnouncementStandingRow> {
  const map = new Map<string, AnnouncementStandingRow>();
  for (const row of rows) {
    map.set(row.crmContactId, row);
  }
  return map;
}

function top3OrderChanged(
  prevTop10: readonly AnnouncementStandingRow[],
  nextTop10: readonly AnnouncementStandingRow[]
): boolean {
  const prev = orderedTop3Ids(prevTop10);
  const next = orderedTop3Ids(nextTop10);
  if (prev.length !== next.length) return true;
  return prev.some((id, i) => id !== next[i]);
}

function orderedTop3Ids(rows: readonly AnnouncementStandingRow[]): string[] {
  return [...rows]
    .filter((r) => r.rank >= 1 && r.rank <= 3)
    .sort((a, b) => a.rank - b.rank)
    .map((r) => r.crmContactId);
}
