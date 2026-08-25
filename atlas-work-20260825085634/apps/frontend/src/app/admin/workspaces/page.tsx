import { AdminShell } from "@/components/layout/admin-shell";
import { AdminEmptyPage } from "@/features/admin-dashboard/admin-empty-page";

/**
 * Displays the Platform Admin workspaces section placeholder.
 */
export default function AdminWorkspacesPage() {
  return (
    <AdminShell>
      <AdminEmptyPage title="Workspaces" description="Workspace administration is not available yet." />
    </AdminShell>
  );
}
