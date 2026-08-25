"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, Building2, Clock3, History, MonitorSmartphone, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";
import { Panel } from "@/components/ui/panel";
import { TelegramWorkspace } from "@/features/telegram/telegram-workspace";

/**
 * Renders the authenticated dashboard with tenant, staff, session, and audit data.
 */
export function DashboardView() {
  const router = useRouter();
  const token = useAuthStore((state) => state.accessToken);

  useEffect(() => {
    if (!token) {
      router.replace("/login");
    }
  }, [router, token]);

  const me = useQuery({ queryKey: ["me"], queryFn: api.me, enabled: Boolean(token) });
  const stats = useQuery({ queryKey: ["dashboard-stats"], queryFn: api.dashboardStats, enabled: Boolean(token) });
  const users = useQuery({ queryKey: ["users"], queryFn: api.users, enabled: Boolean(token) });
  const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: api.workspaces, enabled: Boolean(token) });
  const audit = useQuery({ queryKey: ["audit"], queryFn: api.auditLogs, enabled: Boolean(token) });

  const cards = [
    { label: "Workspaces", value: stats.data?.workspaceCount ?? 0, icon: Building2 },
    { label: "Staff", value: stats.data?.staffCount ?? 0, icon: Users },
    { label: "Active sessions", value: stats.data?.activeSessionCount ?? 0, icon: MonitorSmartphone },
    { label: "Audit events", value: stats.data?.auditEventCount ?? 0, icon: History }
  ];

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-white px-6 py-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">Operational dashboard</p>
            <h1 className="text-2xl font-semibold tracking-normal">Workspace Control Center</h1>
          </div>
          <div className="rounded-md border bg-muted px-3 py-2 text-sm">
            {me.data?.user.email ?? "Loading session"} · {me.data?.user.role ?? "AUTHENTICATING"}
          </div>
        </div>
      </header>

      <main className="space-y-6 p-6">
        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {cards.map((card) => {
            const Icon = card.icon;
            return (
              <Panel key={card.label}>
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-muted-foreground">{card.label}</p>
                  <Icon className="size-5 text-primary" aria-hidden="true" />
                </div>
                <p className="mt-4 text-3xl font-semibold tracking-normal">{card.value}</p>
              </Panel>
            );
          })}
        </section>

        <section className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
          <Panel>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">People</h2>
              <Activity className="size-5 text-muted-foreground" aria-hidden="true" />
            </div>
            <div className="overflow-hidden rounded-md border">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Name</th>
                    <th className="px-4 py-3 font-medium">Role</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y bg-white">
                  {(users.data ?? []).map((user) => (
                    <tr key={user.id}>
                      <td className="px-4 py-3">
                        <p className="font-medium">{user.name}</p>
                        <p className="text-xs text-muted-foreground">{user.email}</p>
                      </td>
                      <td className="px-4 py-3">{user.role}</td>
                      <td className="px-4 py-3">{user.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel>
            <h2 className="mb-4 text-lg font-semibold">Tracked Sessions</h2>
            <div className="space-y-3">
              {(me.data?.sessions ?? []).map((session) => (
                <div key={session.id} className="rounded-md border bg-white p-3">
                  <p className="truncate text-sm font-medium">{session.deviceName}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{session.ipAddress}</p>
                  <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <Clock3 className="size-3.5" aria-hidden="true" />
                    {new Date(session.lastSeenAt).toLocaleString()}
                  </p>
                </div>
              ))}
            </div>
          </Panel>
        </section>

        <section className="grid gap-6 xl:grid-cols-[0.8fr_1.2fr]">
          <Panel>
            <h2 className="mb-4 text-lg font-semibold">Workspaces</h2>
            <div className="space-y-3">
              {(workspaces.data ?? []).map((workspace) => (
                <div key={workspace.id} className="flex items-center justify-between rounded-md border bg-white p-3">
                  <div>
                    <p className="font-medium">{workspace.name}</p>
                    <p className="text-xs text-muted-foreground">{workspace.slug}</p>
                  </div>
                  <p className="text-sm text-muted-foreground">{workspace._count.users} users</p>
                </div>
              ))}
            </div>
          </Panel>

          <Panel>
            <h2 className="mb-4 text-lg font-semibold">Audit Trail</h2>
            <div className="space-y-3">
              {(audit.data ?? []).map((event) => (
                <div key={event.id} className="rounded-md border bg-white p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium">{event.action}</p>
                    <p className="text-xs text-muted-foreground">{new Date(event.createdAt).toLocaleString()}</p>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{event.actorEmail}</p>
                </div>
              ))}
            </div>
          </Panel>
        </section>

        <TelegramWorkspace />
      </main>
    </div>
  );
}
