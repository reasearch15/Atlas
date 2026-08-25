import { AdminShell } from "@/components/layout/admin-shell";
import { AdminCoadminsView } from "@/features/admin-coadmins/admin-coadmins-view";

/**
 * Displays the Platform Admin Coadmin management area.
 */
export default function AdminCoadminsPage() {
  return (
    <AdminShell>
      <AdminCoadminsView />
    </AdminShell>
  );
}
