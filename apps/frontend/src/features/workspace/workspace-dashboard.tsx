"use client";

import type { CoadminDashboardResponse } from "@atlas/shared";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

/**
 * Renders the Coadmin workspace-scoped dashboard.
 */
export function WorkspaceDashboard() {
  const [dashboard, setDashboard] = useState<CoadminDashboardResponse | null>(null);

  useEffect(() => {
    api.coadminDashboard().then(setDashboard).catch(() => setDashboard(null));
  }, []);

  if (!dashboard) return <main className="p-6 text-sm text-muted-foreground lg:p-8">Loading workspace...</main>;

  return (
    <main className="space-y-6 p-4 pb-8 md:p-6 lg:p-8">
      <section>
        <h1 className="text-2xl font-semibold">{dashboard.workspace.name}</h1>
        <p className="text-sm text-muted-foreground">
          {dashboard.coadmin.name} / @{dashboard.coadmin.username}
        </p>
      </section>
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Card label="Workspace status" value={dashboard.workspace.status} />
        <Card label="Staff" value={dashboard.counts.staff} />
        <Card label="Telegram accounts" value={dashboard.counts.telegramAccounts} />
        <Card label="Developer Apps" value={dashboard.counts.developerApps} />
        <Card label="Unclaimed conversations" value={dashboard.counts.unclaimedConversations ?? "Not available yet"} />
        <Card label="Active sessions" value={dashboard.counts.activeSessions} />
        <Card label="Trusted devices" value={dashboard.counts.trustedDevices} />
      </section>
    </main>
  );
}

function Card({ label, value }: { readonly label: string; readonly value: string | number }) {
  return (
    <div className="rounded-lg border bg-white p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-3 text-2xl font-semibold">{value}</p>
    </div>
  );
}
