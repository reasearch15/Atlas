"use client";

import type { NotificationPreferencesDto } from "@atlas/shared";
import { Bell } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  disablePushOnThisDevice,
  enablePushOnThisDevice,
  fetchNotificationPreferences,
  getLocalPushDeviceId,
  isThisDeviceRegistered,
  listPushDevices,
  reconcileNotifications,
  sendTestPush,
  updateNotificationPreferences
} from "@/features/notifications/push-client";

/**
 * Push notification configuration for staff and workspace users.
 */
export function NotificationSettingsView() {
  const [prefs, setPrefs] = useState<NotificationPreferencesDto>(DEFAULT_NOTIFICATION_PREFERENCES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deviceActionPending, setDeviceActionPending] = useState(false);
  const [thisDeviceRegistered, setThisDeviceRegistered] = useState(false);

  useEffect(() => {
    void load();
  }, []);

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const [nextPrefs, nextDevices] = await Promise.all([fetchNotificationPreferences(), listPushDevices()]);
      setPrefs(nextPrefs);
      setThisDeviceRegistered(isThisDeviceRegistered(nextDevices));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load notification settings.");
    } finally {
      setLoading(false);
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
    if (!thisDeviceRegistered) return;
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    void save(next);
  }

  async function enablePush(): Promise<void> {
    setDeviceActionPending(true);
    try {
      const result = await enablePushOnThisDevice();
      if (result.status === "registered") {
        toast.success("Notifications enabled on this device.");
        await load();
      } else if (result.status === "denied") {
        toast.error("Notification permission was denied in the browser.");
      } else if (result.status === "disabled") {
        toast.error("Push notifications are not configured on the server yet.");
      } else {
        toast.error(result.detail || "Unable to enable push notifications.");
      }
    } finally {
      setDeviceActionPending(false);
    }
  }

  async function disablePush(): Promise<void> {
    setDeviceActionPending(true);
    try {
      await disablePushOnThisDevice();
      setThisDeviceRegistered(false);
      toast.success("Notifications disabled on this device.");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to disable push notifications.");
    } finally {
      setDeviceActionPending(false);
    }
  }

  async function test(): Promise<void> {
    const deviceTokenId = getLocalPushDeviceId();
    if (!deviceTokenId) {
      toast.error("No registered devices. Enable push on this device first.");
      return;
    }

    try {
      const result = await sendTestPush(deviceTokenId);
      if (result.queued === 0) {
        toast.error("No registered devices. Enable push on this device first.");
      } else {
        toast.success("Test notification queued for this device.");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Test notification failed.");
    }
  }

  const preferencesDisabled = !thisDeviceRegistered || saving;

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
          Configure push alerts for this device. Messages and assignments live in Atlas — notifications are only the
          delivery alert.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          {thisDeviceRegistered ? (
            <Button type="button" variant="danger" onClick={() => void disablePush()} disabled={deviceActionPending}>
              {deviceActionPending ? "Disabling…" : "Disable on this device"}
            </Button>
          ) : (
            <Button type="button" onClick={() => void enablePush()} disabled={deviceActionPending}>
              {deviceActionPending ? "Enabling…" : "Enable on this device"}
            </Button>
          )}
          <Button type="button" variant="secondary" onClick={() => void test()} disabled={!thisDeviceRegistered}>
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
        {!thisDeviceRegistered ? (
          <p className="rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            Push notifications are disabled for this device. Enable them to receive customer messages and assignments.
          </p>
        ) : null}
        <div className={!thisDeviceRegistered ? "flex flex-col gap-3 opacity-50" : "flex flex-col gap-3"}>
          <ToggleRow label="Enable notifications" checked={prefs.enabled} disabled={preferencesDisabled} onChange={(checked) => toggle("enabled", checked)} />
          <ToggleRow label="Mute all" checked={prefs.muteAll} disabled={preferencesDisabled} onChange={(checked) => toggle("muteAll", checked)} />
          <ToggleRow label="Customer messages" checked={prefs.customerMessages} disabled={preferencesDisabled} onChange={(checked) => toggle("customerMessages", checked)} />
          <ToggleRow label="Assignments" checked={prefs.assignments} disabled={preferencesDisabled} onChange={(checked) => toggle("assignments", checked)} />
          <ToggleRow label="Mentions" checked={prefs.mentions} disabled={preferencesDisabled} onChange={(checked) => toggle("mentions", checked)} />
          <ToggleRow label="Urgent only" checked={prefs.urgentOnly} disabled={preferencesDisabled} onChange={(checked) => toggle("urgentOnly", checked)} />
          <ToggleRow label="Sound" checked={prefs.sound} disabled={preferencesDisabled} onChange={(checked) => toggle("sound", checked)} />
          <ToggleRow label="Vibration" checked={prefs.vibration} disabled={preferencesDisabled} onChange={(checked) => toggle("vibration", checked)} />
          <ToggleRow label="Preview text" checked={prefs.previewText} disabled={preferencesDisabled} onChange={(checked) => toggle("previewText", checked)} />
          <ToggleRow label="Show customer names" checked={prefs.showCustomerNames} disabled={preferencesDisabled} onChange={(checked) => toggle("showCustomerNames", checked)} />
        </div>
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
