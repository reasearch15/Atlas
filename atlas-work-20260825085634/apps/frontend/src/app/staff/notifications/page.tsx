"use client";

import { StaffShell } from "@/components/layout/staff-shell";
import { NotificationSettingsView } from "@/features/notifications/notification-settings-view";

export default function StaffNotificationsPage() {
  return (
    <StaffShell>
      <NotificationSettingsView />
    </StaffShell>
  );
}
