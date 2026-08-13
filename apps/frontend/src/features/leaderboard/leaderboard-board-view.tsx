"use client";

import type { LeaderboardStandingFilter, LeaderboardStandingsPageDto } from "@atlas/shared";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { formatMoneyFromCents, mapLeaderboardError } from "./leaderboard-errors";

const FILTERS: readonly { readonly id: LeaderboardStandingFilter; readonly label: string }[] = [
  { id: "TOP_10", label: "Top 10" },
  { id: "TOP_50", label: "Top 50" },
  { id: "ALL", label: "All" },
  { id: "REFERRERS", label: "Referrers" },
  { id: "RECENTLY_CHANGED", label: "Recently changed" }
];

const SUBSCRIPTION_BANNER =
  "To receive a leaderboard prize, winners must be subscribed to the official leaderboard Telegram channel at the eligibility deadline.";

const PAGE_SIZE = 50;

/**
 * Shared Coadmin / Staff leaderboard standings board.
 * Ranks come only from the backend — never recomputed on the client.
 */
export function LeaderboardBoardView() {
  const [filter, setFilter] = useState<LeaderboardStandingFilter>("TOP_50");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<LeaderboardStandingsPageDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setQ(searchInput.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(handle);
  }, [searchInput]);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const next = await api.leaderboardStandings({
        filter,
        page: filter === "ALL" ? page : 1,
        pageSize: PAGE_SIZE,
        ...(q ? { q } : {})
      });
      setData(next);
      setError(null);
    } catch (loadError) {
      setData(null);
      setError(mapLeaderboardError(loadError));
    } finally {
      setLoading(false);
    }
  }, [filter, page, q]);

  useEffect(() => {
    void load();
  }, [load]);

  const competition = data?.competition ?? null;
  const rows = data?.rows ?? [];
  const totalPages =
    filter === "ALL" && data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <main className="space-y-4 p-4 pb-8 md:p-6 lg:p-8">
      <section className="rounded-lg border bg-white p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Current Prize Pool
            </p>
            <p className="text-3xl font-semibold tracking-tight text-foreground">
              {competition ? formatMoneyFromCents(competition.prizePoolCents) : "—"}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Competition ends
            </p>
            <p className="text-sm font-medium text-foreground">
              {competition ? formatCompetitionEnd(competition.endsAt) : "No active competition"}
            </p>
            {competition ? (
              <p className="mt-0.5 text-xs text-muted-foreground">Status: {competition.status}</p>
            ) : null}
          </div>
        </div>
        <p className="mt-4 rounded-md border bg-muted/40 px-3 py-2 text-xs leading-snug text-muted-foreground">
          {SUBSCRIPTION_BANNER}
        </p>
      </section>

      <section className="rounded-lg border bg-white p-4 md:p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((item) => {
              const active = filter === item.id;
              return (
                <Button
                  key={item.id}
                  type="button"
                  variant={active ? "primary" : "secondary"}
                  className="h-8 px-3 text-xs"
                  onClick={() => {
                    setFilter(item.id);
                    setPage(1);
                  }}
                >
                  {item.label}
                </Button>
              );
            })}
          </div>
          <div className="w-full md:max-w-xs">
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search players…"
              aria-label="Search leaderboard players"
              className="h-9"
            />
          </div>
        </div>

        {error ? (
          <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        ) : null}

        <div className="mt-4 overflow-x-auto">
          {loading && !data ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Loading standings…</p>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {competition ? "No players match this view." : "No active competition yet."}
            </p>
          ) : (
            <table className="min-w-[64rem] w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
                  <th className="px-2 py-2 font-semibold">Rank</th>
                  <th className="px-2 py-2 font-semibold">Player</th>
                  <th className="px-2 py-2 font-semibold">Total</th>
                  <th className="px-2 py-2 font-semibold">Deposit</th>
                  <th className="px-2 py-2 font-semibold">Referral</th>
                  <th className="px-2 py-2 font-semibold">Promotion</th>
                  <th className="px-2 py-2 font-semibold">Wheel</th>
                  <th className="px-2 py-2 font-semibold">Qualifying deposits</th>
                  <th className="px-2 py-2 font-semibold">Successful referrals</th>
                  <th className="px-2 py-2 font-semibold">Last change</th>
                  <th className="px-2 py-2 font-semibold">Reason</th>
                  <th className="px-2 py-2 font-semibold">Gap to next</th>
                  <th className="px-2 py-2 font-semibold">Gap to Top 3</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.crmContactId} className="border-b border-border/60 last:border-0">
                    <td className="px-2 py-2 font-medium tabular-nums">#{row.rank}</td>
                    <td className="px-2 py-2">
                      <div className="font-medium text-foreground">{row.displayName}</div>
                      {row.telegramUsername ? (
                        <div className="text-xs text-muted-foreground">@{row.telegramUsername}</div>
                      ) : null}
                    </td>
                    <td className="px-2 py-2 tabular-nums">{row.totalPoints}</td>
                    <td className="px-2 py-2 tabular-nums">{row.depositPoints}</td>
                    <td className="px-2 py-2 tabular-nums">{row.referralPoints}</td>
                    <td className="px-2 py-2 tabular-nums">{row.promotionPoints}</td>
                    <td className="px-2 py-2 tabular-nums">{row.wheelPoints}</td>
                    <td className="px-2 py-2 tabular-nums">
                      {formatMoneyFromCents(row.qualifyingDepositCents)}
                    </td>
                    <td className="px-2 py-2 tabular-nums">{row.successfulReferralCount}</td>
                    <td className="px-2 py-2 text-xs text-muted-foreground">
                      {row.lastEventAt ? formatDateTime(row.lastEventAt) : "—"}
                    </td>
                    <td className="max-w-[10rem] truncate px-2 py-2 text-xs text-muted-foreground">
                      {row.lastEventReason ?? "—"}
                    </td>
                    <td className="px-2 py-2 tabular-nums">
                      {row.gapToNextRankPoints != null ? row.gapToNextRankPoints : "—"}
                    </td>
                    <td className="px-2 py-2 tabular-nums">
                      {row.gapToTop3Points != null ? row.gapToTop3Points : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {filter === "ALL" && data && data.total > data.pageSize ? (
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Page {data.page} of {totalPages} · {data.total} players
            </p>
            <div className="flex gap-1.5">
              <Button
                type="button"
                variant="secondary"
                className="h-8 px-3 text-xs"
                disabled={pendingPage(loading, page <= 1)}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="h-8 px-3 text-xs"
                disabled={pendingPage(loading, page >= totalPages)}
                onClick={() => setPage((current) => current + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function pendingPage(loading: boolean, atEdge: boolean): boolean {
  return loading || atEdge;
}

function formatCompetitionEnd(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short"
  });
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
