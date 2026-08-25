"use client";

import type { LeaderboardWheelSettingsDto } from "@atlas/shared";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { mapLeaderboardError } from "./leaderboard-errors";

/**
 * Coadmin Phase 6.1 wheel controls.
 * Product locks: $40 / 48h / 1 spin / CYCLE_DEPOSITS_ALL / approved distribution.
 * Coadmin may only enable/disable and activate the approved reward version.
 */
export function WheelCoadminControls() {
  const [settings, setSettings] = useState<LeaderboardWheelSettingsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const next = await api.leaderboardWheelSettings();
      setSettings(next);
      setError(null);
    } catch (loadError) {
      setError(mapLeaderboardError(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(action: () => Promise<void>): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(mapLeaderboardError(actionError));
    } finally {
      setPending(false);
    }
  }

  async function activateApproved(): Promise<void> {
    await run(async () => {
      const next = await api.leaderboardWheelEnsureApproved();
      setSettings(next);
      toast.success("Approved reward distribution activated");
    });
  }

  async function toggleEnabled(enabled: boolean): Promise<void> {
    await run(async () => {
      const next = await api.leaderboardWheelPatchSettings({ enabled });
      setSettings(next);
      toast.success(enabled ? "Wheel enabled" : "Wheel disabled");
    });
  }

  const activeDistribution = settings?.versions.find((v) => v.isActive)?.distribution ?? null;

  return (
    <section className="space-y-4 rounded-lg border bg-white p-5">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">48-hour Wheel</h3>
        <p className="text-xs text-muted-foreground">
          Independent of the leaderboard toggle. Enabling the wheel activates the approved rewards
          and counts all qualifying deposits in the current 48-hour cycle toward the $40 spin
          threshold (max one spin per cycle).
        </p>
      </div>

      {error ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700">
          {error}
        </p>
      ) : null}

      {loading && !settings ? (
        <p className="text-sm text-muted-foreground">Loading wheel settings…</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm md:grid-cols-3">
            <div>
              <dt className="text-xs text-muted-foreground">Status</dt>
              <dd className="font-medium text-foreground">
                {settings?.enabled ? "Enabled" : "Disabled"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Rewards</dt>
              <dd className="font-medium text-foreground">
                {settings?.needsConfiguration ? "Not activated" : "Approved active"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Active version</dt>
              <dd className="font-medium text-foreground">
                {settings?.activeVersionId?.slice(0, 8) ?? "None"}
              </dd>
            </div>
          </dl>

          <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Locked product rules</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>$40 qualifying deposits → 1 spin max per 48h cycle</li>
              <li>All deposits in the current cycle count (including before enable)</li>
              <li>No spins for prior completed cycles</li>
              <li>Rewards: 0, 5, 10, 15, 20, 25, 30, 35, 40 (server-weighted)</li>
            </ul>
          </div>

          {activeDistribution ? (
            <p className="text-xs text-muted-foreground">
              Active outcomes: {activeDistribution.map((d) => d.points).join(", ")} pts
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              className="h-8 px-3 text-xs"
              disabled={pending}
              onClick={() => void activateApproved()}
            >
              Activate approved rewards
            </Button>
            <Button
              type="button"
              variant={settings?.enabled ? "danger" : "primary"}
              className="h-8 px-3 text-xs"
              disabled={pending || settings == null}
              onClick={() => void toggleEnabled(!settings?.enabled)}
            >
              {settings?.enabled ? "Disable wheel" : "Enable wheel"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
