import { AdminShell } from "@/components/layout/admin-shell";
import { AdminDashboardView } from "@/features/admin-dashboard/admin-dashboard-view";

/**
 * Displays the Platform Admin dashboard home.
 */
export default function AdminPage() {
  return (
    <AdminShell>
      <AdminDashboardView />
    </AdminShell>
  );
}
