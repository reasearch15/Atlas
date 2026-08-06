"use client";

import type { NotificationHistoryItemDto, NotificationPreferencesDto, PushDeviceDto } from "@atlas/shared";
import { Bell, History, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  ensurePushRegistration,
  fetchNotificationHistory,
  fetchNotificationPreferences,
  listPushDevices,
  reconcileNotifications,
  sendTestPush,
  updateNotificationPreferences
} from "@/features/notifications/push-client";

/**
 * User-facing notification preference, history, and device management panel.
 */
export function NotificationSettingsView() {
  const [prefs, setPrefs] = useState<NotificationPreferencesDto>(DEFAULT_NOTIFICATION_PREFERENCES);
  const [devices, setDevices] = useState<PushDeviceDto[]>([]);
  const [history, setHistory] = useState<NotificationHistoryItemDto[]>([]);
  const [historyFilter, setHistoryFilter] = useState<"unread" | "read" | "dismissed" | "failed" | "all">("all");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabling, setEnabling] = useState(false);

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    void loadHistory(historyFilter);
  }, [historyFilter]);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [nextPrefs, nextDevices] = await Promise.all([fetchNotificationPreferences(), listPushDevices()]);
      setPrefs(nextPrefs);
      setDevices(nextDevices);
      await loadHistory(historyFilter);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load notification settings.");
    } finally {
      setLoading(false);
    }
  }

  async function loadHistory(status: typeof historyFilter): Promise<void> {
    try {
      setHistory(await fetchNotificationHistory(status));
    } catch {
      // History is best-effort in the settings panel.
    }
  }

  async function save(next: NotificationPreferencesDto): Promise<void> {
    setSaving(true);
    try {
      const saved = await updateNotificationPreferences(next);
      setPrefs(saved);
      toast.success("Notification settings saved.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save settings.");
    } finally {
      setSaving(false);
    }
  }

  function toggle<K extends keyof NotificationPreferencesDto>(key: K, value: NotificationPreferencesDto[K]): void {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    void save(next);
  }

  async function enablePush(): Promise<void> {
    setEnabling(true);
    try {
      const result = await ensurePushRegistration();
      if (result.status === "registered") {
        const reconcile = await reconcileNotifications().catch(() => null);
        toast.success(
          reconcile && reconcile.requeued > 0
            ? `Push enabled. Re-queued ${reconcile.requeued} pending notification(s).`
            : "Push notifications enabled on this device."
        );
        await load();
      } else if (result.status === "denied") {
        toast.error("Notification permission was denied in the browser.");
      } else if (result.status === "disabled") {
        toast.error("Push notifications are not configured on the server yet.");
      } else {
        toast.error(result.detail || "Unable to enable push notifications.");
      }
    } finally {
      setEnabling(false);
    }
  }

  async function test(): Promise<void> {
    try {
      const result = await sendTestPush();
      if (result.queued === 0) {
        toast.error("No registered devices. Enable push on this device first.");
      } else {
        toast.success(`Test notification queued for ${result.queued} device(s).`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Test notification failed.");
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading notification settings…</p>;
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-4 md:p-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Bell className="h-5 w-5" />
          Notifications
        </div>
        <p className="text-sm text-muted-foreground">
          Customer messages create independent notifications that stay pending until delivered. Offline devices are
          automatically caught up when they reconnect.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => void enablePush()} disabled={enabling}>
            {enabling ? "Enabling…" : "Enable on this device"}
          </Button>
          <Button type="button" variant="secondary" onClick={() => void test()}>
            Send test notification
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              void reconcileNotifications()
                .then((r) => toast.success(`Requeued ${r.requeued} · pending ${r.pendingNotifications}`))
                .catch((error) => toast.error(error instanceof Error ? error.message : "Reconcile failed"))
            }
          >
            Reconcile now
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Preferences</h2>
        <ToggleRow label="Enable notifications" checked={prefs.enabled} disabled={saving} onChange={(checked) => toggle("enabled", checked)} />
        <ToggleRow label="Mute all" checked={prefs.muteAll} disabled={saving} onChange={(checked) => toggle("muteAll", checked)} />
        <ToggleRow label="Customer messages" checked={prefs.customerMessages} disabled={saving} onChange={(checked) => toggle("customerMessages", checked)} />
        <ToggleRow label="Assignments" checked={prefs.assignments} disabled={saving} onChange={(checked) => toggle("assignments", checked)} />
        <ToggleRow label="Mentions" checked={prefs.mentions} disabled={saving} onChange={(checked) => toggle("mentions", checked)} />
        <ToggleRow label="Urgent only" checked={prefs.urgentOnly} disabled={saving} onChange={(checked) => toggle("urgentOnly", checked)} />
        <ToggleRow label="Sound" checked={prefs.sound} disabled={saving} onChange={(checked) => toggle("sound", checked)} />
        <ToggleRow label="Vibration" checked={prefs.vibration} disabled={saving} onChange={(checked) => toggle("vibration", checked)} />
        <ToggleRow label="Preview text" checked={prefs.previewText} disabled={saving} onChange={(checked) => toggle("previewText", checked)} />
        <ToggleRow label="Show customer names" checked={prefs.showCustomerNames} disabled={saving} onChange={(checked) => toggle("showCustomerNames", checked)} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
          <History className="h-4 w-4" />
          Notification history
        </h2>
        <div className="flex flex-wrap gap-2">
          {(["all", "unread", "read", "dismissed", "failed"] as const).map((status) => (
            <Button
              key={status}
              type="button"
              variant={historyFilter === status ? "primary" : "secondary"}
              onClick={() => setHistoryFilter(status)}
            >
              {status}
            </Button>
          ))}
        </div>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">No notifications in this filter.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {history.map((item) => (
              <li key={item.id} className="rounded-md border border-border/60 px-3 py-2 text-sm">
                <div className="font-medium">{item.title}</div>
                <div className="text-muted-foreground">{item.body}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {item.status} · {new Date(item.createdAt).toLocaleString()}
                  {item.customerName ? ` · ${item.customerName}` : ""}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="flex items-center gap-2 text-sm font-medium uppercase tracking-wide text-muted-foreground">
          <Smartphone className="h-4 w-4" />
          Registered devices
        </h2>
        {devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No devices registered yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {devices.map((device) => (
              <li key={device.id} className="rounded-md border border-border/60 px-3 py-2 text-sm">
                <div className="font-medium">{device.deviceName || device.platform}</div>
                <div className="text-xs text-muted-foreground">
                  {device.platform} · last seen {new Date(device.lastSeenAt).toLocaleString()}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ToggleRow(props: {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4 rounded-md border border-border/50 px-3 py-2 text-sm">
      <span>{props.label}</span>
      <input
        type="checkbox"
        className="h-4 w-4"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.checked)}
      />
    </label>
  );
}
