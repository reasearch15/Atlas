"use client";

import type { LeaderboardDepositHistoryItemDto } from "@atlas/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { formatMoneyFromCents, mapLeaderboardError } from "./leaderboard-errors";

function formatDepositHistoryWhen(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * Staff/Coadmin deposit history with cursor "Load more" pagination.
 * Fetches only when mounted; never preloads subsequent pages.
 */
export function DepositHistorySection() {
  const [items, setItems] = useState<LeaderboardDepositHistoryItemDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const loadMoreInFlightRef = useRef(false);

  const resetAndLoadFirst = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const page = await api.leaderboardDepositHistory();
      seenIdsRef.current = new Set(page.items.map((row) => row.id));
      setItems([...page.items]);
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (loadError) {
      setItems([]);
      setNextCursor(null);
      setHasMore(false);
      setError(mapLeaderboardError(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void resetAndLoadFirst();
  }, [resetAndLoadFirst]);

  async function loadMore(): Promise<void> {
    if (!hasMore || !nextCursor || loadMoreInFlightRef.current) return;
    loadMoreInFlightRef.current = true;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await api.leaderboardDepositHistory({ cursor: nextCursor });
      setItems((prev) => {
        const appended: LeaderboardDepositHistoryItemDto[] = [];
        for (const row of page.items) {
          if (seenIdsRef.current.has(row.id)) continue;
          seenIdsRef.current.add(row.id);
          appended.push(row);
        }
        return appended.length === 0 ? prev : [...prev, ...appended];
      });
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (loadError) {
      setError(mapLeaderboardError(loadError));
    } finally {
      setLoadingMore(false);
      loadMoreInFlightRef.current = false;
    }
  }

  return (
    <section className="rounded-lg border bg-white p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-wide text-foreground">Deposit History</h2>
        <Button
          type="button"
          variant="secondary"
          className="h-8 px-3 text-xs"
          disabled={loading}
          onClick={() => void resetAndLoadFirst()}
        >
          Refresh
        </Button>
      </div>

      {loading ? (
        <p className="mt-3 text-sm text-muted-foreground">Loading deposits…</p>
      ) : error ? (
        <p className="mt-3 text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : items.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No deposits recorded yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-border/70">
          {items.map((row) => (
            <li key={row.id} className="py-3 first:pt-1">
              <p className="text-sm font-semibold text-foreground">{row.displayName}</p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {formatMoneyFromCents(row.amountCents)}
                {" · "}
                <span className="font-medium text-emerald-700">
                  +{row.pointsAdded} pts
                </span>
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {formatDepositHistoryWhen(row.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      )}

      {!loading && items.length > 0 ? (
        <div className="mt-3 flex flex-col items-stretch gap-2 sm:items-start">
          {hasMore ? (
            <Button
              type="button"
              variant="secondary"
              className="h-9 px-4 text-sm"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">No more deposits</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
