"use client";

import type { AdminDashboardResponse, AdminHealthStatus } from "@atlas/shared";
import { Activity, AlertCircle, CheckCircle2, Clock, Users } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

const healthLabels: Record<AdminHealthStatus, string> = {
  HEALTHY: "Healthy",
  DEGRADED: "Degraded",
  UNAVAILABLE: "Unavailable"
};

/**
 * Renders the Platform Admin home dashboard.
 */
export function AdminDashboardView() {
  const [dashboard, setDashboard] = useState<AdminDashboardResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .adminDashboard()
      .then(setDashboard)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <main className="p-6 text-sm text-muted-foreground lg:p-8">Loading platform dashboard...</main>;
  }

  if (!dashboard) {
    return <main className="p-6 text-sm text-muted-foreground lg:p-8">Unable to load dashboard.</main>;
  }

  return (
    <main className="space-y-6 p-4 pb-8 md:p-6 lg:p-8">
      <section>
        <h2 className="text-xl font-semibold">Platform Overview</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <MetricCard label="Total Coadmins" value={dashboard.counts.coadmins} />
          <MetricCard label="Active Workspaces" value={dashboard.counts.workspaces} />
          <MetricCard label="Total Staff" value={dashboard.counts.staff} />
          <MetricCard label="Connected Telegram Accounts" value={dashboard.counts.telegramAccounts} />
          <MetricCard label="Unclaimed Conversations" value={dashboard.counts.unclaimedConversations ?? "Not available yet"} muted />
          <MetricCard label="Platform Health" value={overallHealth(dashboard.health)} />
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <section className="rounded-lg border bg-white">
          <div className="flex items-center justify-between border-b p-5">
            <div>
              <h2 className="font-semibold">Recent Coadmins</h2>
              <p className="text-sm text-muted-foreground">Latest coadmin accounts across workspaces</p>
            </div>
            <div className="text-right">
              <Button variant="secondary" disabled title="Coadmin creation has not been built yet.">
                Create Coadmin
              </Button>
              <p className="mt-1 text-xs text-muted-foreground">Creation flow not built yet.</p>
            </div>
          </div>
          {dashboard.recentCoadmins.length === 0 ? (
            <EmptyState icon={<Users className="size-5" />} title="No coadmins have been created yet." />
          ) : (
            <div className="divide-y">
              {dashboard.recentCoadmins.map((coadmin) => (
                <div key={coadmin.id} className="grid gap-2 p-5 sm:grid-cols-[1fr_auto]">
                  <div>
                    <p className="font-medium">{coadmin.name}</p>
                    <p className="text-sm text-muted-foreground">{coadmin.email}</p>
                    <p className="text-sm text-muted-foreground">{coadmin.workspaceName ?? "No workspace"}</p>
                  </div>
                  <div className="text-sm text-muted-foreground sm:text-right">
                    <p>{coadmin.status}</p>
                    <p>{new Date(coadmin.createdAt).toLocaleString()}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-lg border bg-white">
          <div className="border-b p-5">
            <h2 className="font-semibold">Security Summary</h2>
            <p className="text-sm text-muted-foreground">Admin access posture</p>
          </div>
          <div className="grid gap-4 p-5">
            <SummaryRow label="Active admin sessions" value={dashboard.security.activeSessions} />
            <SummaryRow label="Trusted devices" value={dashboard.security.trustedDevices} />
            <SummaryRow label="Recent failed logins" value={dashboard.security.recentFailedLogins} />
            <SummaryRow
              label="Last successful login"
              value={dashboard.security.lastLoginAt ? new Date(dashboard.security.lastLoginAt).toLocaleString() : "Never"}
            />
          </div>
        </section>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="rounded-lg border bg-white">
          <div className="border-b p-5">
            <h2 className="font-semibold">Recent Audit Activity</h2>
          </div>
          {dashboard.recentAuditEvents.length === 0 ? (
            <EmptyState icon={<Activity className="size-5" />} title="No platform audit activity yet." />
          ) : (
            <div className="divide-y">
              {dashboard.recentAuditEvents.map((event) => (
                <div key={event.id} className="p-5">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium">{event.action}</p>
                    {event.status ? <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">{event.status}</span> : null}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {event.actorEmail} - {new Date(event.createdAt).toLocaleString()}
                  </p>
                  {event.ipAddress ? <p className="text-sm text-muted-foreground">IP {event.ipAddress}</p> : null}
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-lg border bg-white">
          <div className="border-b p-5">
            <h2 className="font-semibold">System Health</h2>
          </div>
          <div className="grid gap-3 p-5">
            {Object.entries(dashboard.health).map(([name, status]) => (
              <div key={name} className="flex items-center justify-between rounded-md border p-3">
                <span className="capitalize">{name.replace(/([A-Z])/g, " $1")}</span>
                <HealthBadge status={status} />
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function MetricCard({ label, value, muted = false }: { readonly label: string; readonly value: number | string; readonly muted?: boolean }) {
  return (
    <div className="rounded-lg border bg-white p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className={`mt-3 text-2xl font-semibold ${muted ? "text-muted-foreground" : ""}`}>{value}</p>
    </div>
  );
}

function SummaryRow({ label, value }: { readonly label: string; readonly value: number | string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border p-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

function HealthBadge({ status }: { readonly status: AdminHealthStatus }) {
  const Icon = status === "HEALTHY" ? CheckCircle2 : status === "DEGRADED" ? Clock : AlertCircle;
  const className =
    status === "HEALTHY"
      ? "bg-emerald-50 text-emerald-700"
      : status === "DEGRADED"
        ? "bg-amber-50 text-amber-700"
        : "bg-red-50 text-red-700";
  return (
    <span className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${className}`}>
      <Icon className="size-3.5" aria-hidden="true" />
      {healthLabels[status]}
    </span>
  );
}

function EmptyState({ icon, title }: { readonly icon: ReactNode; readonly title: string }) {
  return (
    <div className="flex items-center gap-3 p-5 text-sm text-muted-foreground">
      <div className="flex size-9 items-center justify-center rounded-md bg-muted">{icon}</div>
      {title}
    </div>
  );
}

function overallHealth(health: AdminDashboardResponse["health"]): string {
  const statuses = Object.values(health);
  if (statuses.includes("UNAVAILABLE")) return "Unavailable";
  if (statuses.includes("DEGRADED")) return "Degraded";
  return "Healthy";
}
