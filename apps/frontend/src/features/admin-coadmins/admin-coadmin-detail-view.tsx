"use client";

import type { AdminCoadminDetail } from "@atlas/shared";
import { Archive, KeyRound, PauseCircle, PlayCircle, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

/**
 * Renders Platform Admin detail and controls for a single Coadmin.
 */
export function AdminCoadminDetailView({ coadminId }: { readonly coadminId: string }) {
  const [detail, setDetail] = useState<AdminCoadminDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [resetPassword, setResetPassword] = useState("");
  const [oneTimePassword, setOneTimePassword] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, [coadminId]);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      setDetail(await api.adminCoadmin(coadminId));
    } finally {
      setLoading(false);
    }
  }

  async function action(label: string, call: () => Promise<AdminCoadminDetail>): Promise<void> {
    try {
      setDetail(await call());
      toast.success(label);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action failed.");
    }
  }

  async function reset(): Promise<void> {
    try {
      const result = await api.resetCoadminPassword(coadminId, resetPassword);
      setDetail(result);
      setOneTimePassword(result.temporaryPassword);
      setResetPassword("");
      toast.success("Password reset. Copy the temporary password now.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Password reset failed.");
    }
  }

  if (loading) return <main className="p-6 text-sm text-muted-foreground lg:p-8">Loading Coadmin...</main>;
  if (!detail) return <main className="p-6 text-sm text-muted-foreground lg:p-8">Coadmin not found.</main>;

  return (
    <main className="space-y-6 p-4 pb-8 md:p-6 lg:p-8">
      <section className="rounded-lg border bg-white p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-2xl font-semibold">{detail.name}</h2>
            <p className="text-sm text-muted-foreground">@{detail.username}</p>
            <p className="text-sm text-muted-foreground">{detail.contactEmail ?? "No contact email"}</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {detail.workspaceName} / {detail.workspaceSlug}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {detail.status === "SUSPENDED" ? (
              <Button onClick={() => action("Coadmin reactivated.", () => api.reactivateCoadmin(detail.id))}>
                <PlayCircle className="size-4" aria-hidden="true" />
                Reactivate
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => action("Coadmin suspended.", () => api.suspendCoadmin(detail.id))}>
                <PauseCircle className="size-4" aria-hidden="true" />
                Suspend
              </Button>
            )}
            <Button variant="secondary" onClick={() => action("Coadmin archived.", () => api.archiveCoadmin(detail.id))}>
              <Archive className="size-4" aria-hidden="true" />
              Archive
            </Button>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card label="Status" value={detail.status} />
        <Card label="Password change required" value={detail.mustChangePassword ? "Yes" : "No"} />
        <Card label="Workspace" value={detail.workspaceStatus} />
        <Card label="Last login" value={detail.lastLoginAt ? new Date(detail.lastLoginAt).toLocaleString() : "Never"} />
        <Card label="Active sessions" value={detail.activeSessions} />
        <Card label="Trusted devices" value={detail.trustedDevices} />
        <Card label="Staff" value={detail.staffCount} />
        <Card label="Telegram accounts" value={detail.telegramAccountCount} />
        <Card label="Developer Apps" value={detail.developerAppCount} />
        <Card label="Temporary password issued" value={detail.lastTemporaryPasswordIssuedAt ? new Date(detail.lastTemporaryPasswordIssuedAt).toLocaleString() : "Not issued"} />
        <Card label="Created" value={new Date(detail.createdAt).toLocaleString()} />
      </section>

      <section className="rounded-lg border bg-white p-5">
        <h3 className="font-semibold">Reset password</h3>
        <div className="mt-3 flex max-w-xl gap-2">
          <Input type="password" placeholder="New temporary password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} />
          <Button onClick={reset} disabled={resetPassword.length < 12}>
            <KeyRound className="size-4" aria-hidden="true" />
            Reset
          </Button>
        </div>
        {oneTimePassword ? (
          <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-medium">Temporary password visible once</p>
            <p className="mt-2 font-mono text-sm">{oneTimePassword}</p>
          </div>
        ) : null}
      </section>

      <section className="rounded-lg border bg-white p-5">
        <div className="flex items-center justify-between gap-4">
          <h3 className="font-semibold">Sessions</h3>
          <Button variant="secondary" onClick={() => action("All sessions revoked.", () => api.revokeAllCoadminSessions(detail.id))}>
            <XCircle className="size-4" aria-hidden="true" />
            Revoke all
          </Button>
        </div>
        <div className="mt-3 divide-y rounded-md border">
          {detail.sessions.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">No sessions.</p>
          ) : (
            detail.sessions.map((session) => (
              <div key={session.id} className="grid gap-3 p-3 md:grid-cols-[1fr_auto]">
                <div className="text-sm">
                  <p className="font-medium">{session.deviceName}</p>
                  <p className="text-muted-foreground">
                    {session.ipAddress} - {new Date(session.lastSeenAt).toLocaleString()}
                  </p>
                  <p className="text-muted-foreground">{session.revokedAt ? "Revoked" : "Active"}</p>
                </div>
                <Button variant="secondary" disabled={Boolean(session.revokedAt)} onClick={() => action("Session revoked.", () => api.revokeCoadminSession(detail.id, session.id))}>
                  Revoke
                </Button>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="rounded-lg border bg-white p-5">
        <h3 className="font-semibold">Recent audit activity</h3>
        {detail.recentAuditEvents.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No workspace audit activity yet.</p>
        ) : (
          <div className="mt-3 divide-y">
            {detail.recentAuditEvents.map((event) => (
              <div key={event.id} className="py-3 text-sm">
                <p className="font-medium">{event.action}</p>
                <p className="text-muted-foreground">{new Date(event.createdAt).toLocaleString()}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function Card({ label, value }: { readonly label: string; readonly value: string | number }) {
  return (
    <div className="rounded-lg border bg-white p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-2 break-words font-semibold">{value}</p>
    </div>
  );
}
