"use client";

import type { LeaderboardWheelSpinResultDto, LeaderboardWheelStatusDto } from "@atlas/shared";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { mapLeaderboardError, newIdempotencyKey } from "./leaderboard-errors";

/** Approved visual outcomes — weights are server-authoritative; do not imply equal odds. */
const SEGMENTS = [0, 5, 10, 15, 20, 25, 30, 35, 40];

export interface WheelSpinPanelProps {
  readonly crmContactId: string;
  readonly status: LeaderboardWheelStatusDto | null;
  readonly canSpin: boolean;
  readonly onSpun?: (result: LeaderboardWheelSpinResultDto) => void;
  readonly onRefresh?: () => Promise<void>;
}

/**
 * Atlas UI wheel spin — server result is authoritative.
 * Bot Spin callback is DEFERRED.
 */
export function WheelSpinPanel({
  crmContactId,
  status,
  canSpin,
  onSpun,
  onRefresh
}: WheelSpinPanelProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LeaderboardWheelSpinResultDto | null>(null);
  const [rotation, setRotation] = useState(0);
  const spinKeyRef = useRef(newIdempotencyKey());

  useEffect(() => {
    spinKeyRef.current = newIdempotencyKey();
    setResult(null);
    setError(null);
    setRotation(0);
  }, [crmContactId]);

  if (!status || !status.wheelEnabled) {
    return null;
  }

  const have = Math.floor(status.qualifyingDepositCents / 100);
  const need = Math.floor(status.qualificationCentsRequired / 100);
  const remaining = Math.max(0, need - have);
  const qualified =
    status.qualified ?? status.qualifyingDepositCents >= status.qualificationCentsRequired;
  const progress = Math.min(
    100,
    (status.qualifyingDepositCents / status.qualificationCentsRequired) * 100
  );

  async function runSpin(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const spun = await api.leaderboardWheelSpin({
        crmContactId,
        idempotencyKey: spinKeyRef.current
      });
      setResult(spun);
      const segmentIndex = Math.max(
        0,
        SEGMENTS.findIndex((p) => p === spun.pointsAwarded)
      );
      const target =
        360 * 4 +
        (360 - (segmentIndex / SEGMENTS.length) * 360) -
        360 / SEGMENTS.length / 2;
      requestAnimationFrame(() => setRotation(target));
      onSpun?.(spun);
      spinKeyRef.current = newIdempotencyKey();
      await onRefresh?.();
    } catch (spinError) {
      setError(mapLeaderboardError(spinError));
    } finally {
      setPending(false);
    }
  }

  function resultCopy(spun: LeaderboardWheelSpinResultDto): string {
    if (spun.pointsAwarded === 0) {
      return "🎡 0 POINTS — No points this spin. Your normal deposits, referrals and promotions continue earning leaderboard points.";
    }
    const from =
      spun.previousRank != null && spun.resultingRank != null
        ? ` #${spun.previousRank} → #${spun.resultingRank}.`
        : "";
    const prizeZone =
      spun.resultingRank != null && spun.resultingRank <= 3
        ? " 🏆 You're now in the prize zone!"
        : "";
    return `🎡 +${spun.pointsAwarded} POINTS!${from}${prizeZone}`;
  }

  const tone = status.available
    ? "border-emerald-300 bg-emerald-50/90"
    : qualified
      ? "border-amber-200 bg-amber-50/70"
      : "border-border/70 bg-muted/30";

  return (
    <div className={`space-y-2 rounded-lg border p-2.5 ${tone}`} data-testid="crm-wheel-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold tracking-wide text-foreground">
          {status.available
            ? "🎡 SPIN AVAILABLE"
            : qualified
              ? "🎡 Qualified ✓"
              : "🎡 Next Spin"}
        </p>
        {status.nextSpinAt && !status.available ? (
          <span className="text-[11px] text-muted-foreground">
            Next spin available {new Date(status.nextSpinAt).toLocaleString()}
          </span>
        ) : null}
      </div>

      <div className="h-2 overflow-hidden rounded-full bg-white/80" aria-hidden="true">
        <div
          className="h-full rounded-full bg-emerald-700 transition-[width] duration-500"
          style={{ width: `${progress}%` }}
        />
      </div>
      <p className="text-sm font-semibold tabular-nums text-foreground">
        ${have} / ${need}
      </p>
      {status.available ? null : qualified ? (
        <p className="text-xs text-amber-900">
          Qualification is ready. Spin unlocks when the 48-hour cooldown ends.
        </p>
      ) : (
        <p className="text-xs text-amber-900">${remaining} remaining</p>
      )}
      <p className="text-[11px] text-muted-foreground">Eligible deposits from the last 48 hours</p>
      {status.pointsAwarded != null && status.consumed ? (
        <p className="text-xs text-foreground">Awarded +{status.pointsAwarded} pts on the last spin.</p>
      ) : null}

      {status.qualificationInvalidated ? (
        <p className="text-[11px] text-amber-800">
          Qualification invalidated after reversal — historical spin points kept.
        </p>
      ) : null}

      {canSpin && status.available ? (
        <Button
          type="button"
          className="h-10 w-full text-xs font-semibold bg-emerald-800 text-white hover:bg-emerald-900"
          disabled={pending}
          onClick={() => {
            setOpen(true);
            setResult(null);
            setRotation(0);
          }}
        >
          Spin Now
        </Button>
      ) : null}

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-lg border bg-background p-4 shadow-lg">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Wheel spin</h3>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setOpen(false)}
                disabled={pending}
              >
                Close
              </button>
            </div>

            <p className="mb-2 text-center text-[11px] text-muted-foreground">
              Possible rewards: {SEGMENTS.join(" · ")}
            </p>

            <div className="relative mx-auto mb-4 h-52 w-52">
              <div className="absolute left-1/2 top-0 z-10 -translate-x-1/2 text-emerald-700">
                ▼
              </div>
              <div
                className="h-full w-full rounded-full border-4 border-emerald-900/30 transition-transform duration-[2200ms] ease-out"
                style={{
                  transform: `rotate(${rotation}deg)`,
                  background:
                    "conic-gradient(from 0deg, #1f3a2e 0deg 40deg, #2d5a45 40deg 80deg, #1f3a2e 80deg 120deg, #2d5a45 120deg 160deg, #1f3a2e 160deg 200deg, #2d5a45 200deg 240deg, #1f3a2e 240deg 280deg, #2d5a45 280deg 320deg, #1f3a2e 320deg 360deg)"
                }}
              />
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="rounded-full bg-background/90 px-3 py-1 text-xs font-semibold">
                  {result ? `+${result.pointsAwarded}` : "Spin"}
                </div>
              </div>
            </div>

            {error ? <p className="mb-2 text-xs text-red-600">{error}</p> : null}
            {result ? <p className="mb-2 text-xs text-foreground">{resultCopy(result)}</p> : null}

            <Button
              type="button"
              className="h-9 w-full"
              disabled={pending || result != null}
              onClick={() => void runSpin()}
            >
              {pending ? "Spinning…" : result ? "Done" : "Confirm spin"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
