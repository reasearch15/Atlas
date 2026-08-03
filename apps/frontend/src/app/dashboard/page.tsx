import { Sidebar } from "@/components/layout/sidebar";
import { DashboardView } from "@/features/dashboard/dashboard-view";

/**
 * Displays the authenticated Atlas dashboard shell.
 */
export default function DashboardPage() {
  return (
    <div className="grid min-h-screen lg:grid-cols-[18rem_1fr]">
      <Sidebar />
      <DashboardView />
    </div>
  );
}
