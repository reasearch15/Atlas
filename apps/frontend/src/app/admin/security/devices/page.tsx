import { AdminShell } from "@/components/layout/admin-shell";
import { AdminDevicesView } from "@/features/admin-auth/admin-devices-view";

/**
 * Displays the authenticated Platform Admin trusted-device settings page.
 */
export default function AdminSecurityDevicesPage() {
  return (
    <AdminShell>
      <AdminDevicesView />
    </AdminShell>
  );
}
