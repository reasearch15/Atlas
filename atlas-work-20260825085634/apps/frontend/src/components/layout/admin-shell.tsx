"use client";

import type { ReactNode } from "react";
import {
  BarChart3,
  BriefcaseBusiness,
  ChevronDown,
  History,
  LogOut,
  MonitorSmartphone,
  Settings,
  Shield,
  Users
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { adminLogout } from "@/lib/api";
import { clearRoleAuthBootstrap } from "@/lib/auth-bootstrap";
import { useRoleWorkspaceBootstrap } from "@/lib/use-role-workspace-bootstrap";
import { useAuthStore } from "@/stores/auth-store";

const navItems = [
  { label: "Dashboard", href: "/admin", icon: BarChart3 },
  { label: "Coadmins", href: "/admin/coadmins", icon: Users },
  { label: "Workspaces", href: "/admin/workspaces", icon: BriefcaseBusiness },
  { label: "Audit Logs", href: "/admin/audit", icon: History },
  { label: "Devices", href: "/admin/security/devices", icon: MonitorSmartphone },
  { label: "Settings", href: "/admin/settings", icon: Settings }
] as const;

/**
 * Renders the protected Platform Admin shell and navigation.
 */
export function AdminShell({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const user = useAuthStore((state) => state.user);
  const { status, error, retry } = useRoleWorkspaceBootstrap("PLATFORM_ADMIN");

  async function signOut(): Promise<void> {
    clearRoleAuthBootstrap("PLATFORM_ADMIN");
    await adminLogout();
    toast.success("Signed out");
    router.replace("/login" as Route);
  }

  if (status === "LOADING" || status === "IDLE") {
    return <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">Loading admin console...</div>;
  }

  if (status === "ERROR" || (status === "UNAUTHENTICATED" && error)) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background text-sm">
        <p className="text-muted-foreground">{error ?? "Unable to open admin console."}</p>
        <Button type="button" variant="secondary" onClick={retry}>
          Retry
        </Button>
      </div>
    );
  }

  if (status !== "AUTHENTICATED") {
    return <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">Redirecting to sign in...</div>;
  }

  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-[18rem_1fr]">
      <aside className="flex min-h-screen w-full flex-col border-r bg-white p-4 lg:w-72">
        <div className="mb-8 flex items-center gap-3 px-2">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Shield className="size-5" aria-hidden="true" />
          </div>
          <div>
            <p className="font-semibold">Atlas Admin</p>
            <p className="text-xs text-muted-foreground">Platform Administration</p>
          </div>
        </div>

        <nav className="grid gap-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href || (item.href !== "/admin" && pathname.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href as Route}
                className={`flex h-10 items-center gap-3 rounded-md px-3 text-left text-sm font-medium transition ${
                  active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <Icon className="size-4" aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto border-t pt-4">
          <div className="mb-3 rounded-md bg-muted p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{user?.email}</p>
                <p className="text-xs text-muted-foreground">Platform Admin</p>
              </div>
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </div>
          </div>
          <Button className="w-full justify-start" variant="ghost" onClick={signOut}>
            <LogOut className="size-4" aria-hidden="true" />
            Sign out
          </Button>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="border-b bg-white px-6 py-4 lg:px-8">
          <p className="text-sm font-medium text-primary">Atlas Admin</p>
          <div className="mt-1 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <h1 className="text-2xl font-semibold">Platform Administration</h1>
            <p className="text-sm text-muted-foreground">{user?.email}</p>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
