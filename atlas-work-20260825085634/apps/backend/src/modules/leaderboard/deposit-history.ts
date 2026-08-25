/**
 * Cursor/keyset helpers for Staff/Coadmin deposit history.
 * Ordering: createdAt DESC, id DESC.
 */

export const DEPOSIT_HISTORY_PAGE_SIZE = 30;

export type DepositHistoryActorRole = "COADMIN" | "STAFF" | "PLATFORM_ADMIN" | string;

/**
 * Formats who recorded a deposit for history UI.
 * Coadmins are labeled with "(Coadmin)"; Staff show display name only.
 */
export function formatDepositHistoryRecordedBy(
  actor: { readonly name?: string | null; readonly username?: string | null; readonly role?: DepositHistoryActorRole | null } | null | undefined
): { readonly recordedByDisplayName: string; readonly recordedByIsCoadmin: boolean } {
  if (!actor) {
    return { recordedByDisplayName: "Unknown", recordedByIsCoadmin: false };
  }
  const name = (actor.name ?? "").trim() || (actor.username ?? "").trim() || null;
  const isCoadmin = actor.role === "COADMIN";
  if (!name) {
    return { recordedByDisplayName: "Unknown", recordedByIsCoadmin: isCoadmin };
  }
  return {
    recordedByDisplayName: isCoadmin ? `${name} (Coadmin)` : name,
    recordedByIsCoadmin: isCoadmin
  };
}

export interface DepositHistoryCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export function encodeDepositHistoryCursor(cursor: DepositHistoryCursor): string {
  const payload = `${cursor.createdAt.toISOString()}|${cursor.id}`;
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeDepositHistoryCursor(raw: string): DepositHistoryCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    throw new Error("INVALID_DEPOSIT_HISTORY_CURSOR");
  }
  const sep = decoded.indexOf("|");
  if (sep <= 0 || sep === decoded.length - 1) {
    throw new Error("INVALID_DEPOSIT_HISTORY_CURSOR");
  }
  const iso = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  const createdAt = new Date(iso);
  if (!Number.isFinite(createdAt.getTime()) || !id) {
    throw new Error("INVALID_DEPOSIT_HISTORY_CURSOR");
  }
  return { createdAt, id };
}

/**
 * Prisma-compatible keyset clause for rows strictly older than the cursor
 * under (createdAt DESC, id DESC).
 */
export function depositHistoryOlderThanCursor(cursor: DepositHistoryCursor): {
  OR: Array<Record<string, unknown>>;
} {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } }
    ]
  };
}

export interface DepositHistoryPageSlice<T extends { id: string; createdAt: Date }> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** Slice a limit+1 query result into a page with hasMore / nextCursor. */
export function sliceDepositHistoryPage<T extends { id: string; createdAt: Date }>(
  rows: readonly T[],
  limit: number
): DepositHistoryPageSlice<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : [...rows];
  const last = items[items.length - 1];
  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? encodeDepositHistoryCursor({ createdAt: last.createdAt, id: last.id })
        : null
  };
}
