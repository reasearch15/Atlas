import { AdminShell } from "@/components/layout/admin-shell";
import { AdminEmptyPage } from "@/features/admin-dashboard/admin-empty-page";

/**
 * Displays the Platform Admin settings section placeholder.
 */
export default function AdminSettingsPage() {
  return (
    <AdminShell>
      <AdminEmptyPage title="Settings" description="Platform settings are not available yet." />
    </AdminShell>
  );
}
