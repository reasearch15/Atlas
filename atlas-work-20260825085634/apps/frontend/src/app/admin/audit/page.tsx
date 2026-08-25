import { AdminShell } from "@/components/layout/admin-shell";
import { AdminEmptyPage } from "@/features/admin-dashboard/admin-empty-page";

/**
 * Displays the Platform Admin audit section placeholder.
 */
export default function AdminAuditPage() {
  return (
    <AdminShell>
      <AdminEmptyPage title="Audit Logs" description="Detailed audit log browsing is not available yet." />
    </AdminShell>
  );
}
