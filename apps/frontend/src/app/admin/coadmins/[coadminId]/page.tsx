import { AdminShell } from "@/components/layout/admin-shell";
import { AdminCoadminDetailView } from "@/features/admin-coadmins/admin-coadmin-detail-view";

/**
 * Displays Platform Admin detail management for a Coadmin.
 */
export default async function AdminCoadminDetailPage({ params }: { readonly params: Promise<{ coadminId: string }> }) {
  const { coadminId } = await params;
  return (
    <AdminShell>
      <AdminCoadminDetailView coadminId={coadminId} />
    </AdminShell>
  );
}
