"use client";

import type { AdminTrustedDeviceDto } from "@atlas/shared";
import { MonitorSmartphone, ShieldAlert, Trash2 } from "lucide-react";
import type { Route } from "next";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";

/**
 * Renders the Platform Admin trusted-device management screen.
 */
export function AdminDevicesView() {
  const router = useRouter();
  const token = useAuthStore((state) => state.accessToken);
  const clearSession = useAuthStore((state) => state.clearSession);
  const [devices, setDevices] = useState<AdminTrustedDeviceDto[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadDevices(): Promise<void> {
    try {
      const response = await api.adminDevices();
      setDevices(response);
    } catch {
      clearSession();
      router.replace("/admin/login" as Route);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!token) {
      router.replace("/admin/login" as Route);
      return;
    }
    void loadDevices();
  }, [token]);

  async function revoke(deviceId: string): Promise<void> {
    await api.revokeAdminDevice(deviceId);
    toast.success("Device revoked");
    const revokedCurrentDevice = devices.some((device) => device.id === deviceId && device.isCurrent);
    if (revokedCurrentDevice) {
      clearSession();
      router.push("/admin/login" as Route);
      return;
    }
    await loadDevices();
  }

  async function revokeAll(): Promise<void> {
    await api.revokeAllAdminDevices();
    clearSession();
    toast.success("All devices logged out");
    router.push("/admin/login" as Route);
  }

  return (
    <main className="min-h-screen bg-background p-6 lg:p-8">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-primary">Admin Settings / Security</p>
          <h1 className="mt-1 text-2xl font-semibold">Devices</h1>
        </div>
        <Button variant="danger" onClick={revokeAll}>
          <ShieldAlert className="size-4" aria-hidden="true" />
          Log out all devices
        </Button>
      </div>

      <section className="overflow-hidden rounded-lg border bg-white">
        {loading ? (
          <div className="p-6 text-sm text-muted-foreground">Loading devices...</div>
        ) : (
          <div className="divide-y">
            {devices.map((device) => (
              <article key={device.id} className="grid gap-4 p-5 lg:grid-cols-[1fr_auto] lg:items-center">
                <div className="flex gap-4">
                  <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted text-primary">
                    <MonitorSmartphone className="size-5" aria-hidden="true" />
                  </div>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold">{device.displayName}</h2>
                      {device.isCurrent ? <span className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground">Current</span> : null}
                      {device.revokedAt ? <span className="rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">Revoked</span> : null}
                    </div>
                    <dl className="mt-3 grid gap-2 text-sm text-muted-foreground sm:grid-cols-2 xl:grid-cols-3">
                      <div>Browser: {device.browser}</div>
                      <div>OS: {device.operatingSystem}</div>
                      <div>IP: {device.lastIp}</div>
                      <div>First trusted: {new Date(device.firstTrustedAt).toLocaleString()}</div>
                      <div>Last active: {new Date(device.lastUsedAt).toLocaleString()}</div>
                      <div>Expires: {new Date(device.expiresAt).toLocaleString()}</div>
                    </dl>
                  </div>
                </div>
                <Button variant="secondary" onClick={() => revoke(device.id)} disabled={Boolean(device.revokedAt)}>
                  <Trash2 className="size-4" aria-hidden="true" />
                  Revoke
                </Button>
              </article>
            ))}
            {devices.length === 0 ? <div className="p-6 text-sm text-muted-foreground">No trusted devices are active for this admin.</div> : null}
          </div>
        )}
      </section>
    </main>
  );
}
