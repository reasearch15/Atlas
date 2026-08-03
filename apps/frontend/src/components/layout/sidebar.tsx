"use client";

import { BarChart3, History, LogOut, MonitorSmartphone, Settings, Shield, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { logout } from "@/lib/api";
import { Button } from "@/components/ui/button";

const navItems = [
  { label: "Overview", icon: BarChart3 },
  { label: "Staff", icon: Users },
  { label: "Sessions", icon: MonitorSmartphone },
  { label: "Audit", icon: History },
  { label: "Security", icon: Shield },
  { label: "Settings", icon: Settings }
];

/**
 * Renders the primary dashboard navigation.
 */
export function Sidebar() {
  const router = useRouter();

  async function handleLogout(): Promise<void> {
    await logout();
    toast.success("Signed out");
    router.push("/login");
  }

  return (
    <aside className="flex min-h-screen w-full flex-col border-r bg-white p-4 lg:w-72">
      <div className="mb-8 flex items-center gap-3 px-2">
        <div className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Shield className="size-5" aria-hidden="true" />
        </div>
        <div>
          <p className="font-semibold">Atlas</p>
          <p className="text-xs text-muted-foreground">Team Workspace</p>
        </div>
      </div>

      <nav className="grid gap-1">
        {navItems.map((item, index) => {
          const Icon = item.icon;
          return (
            <button
              key={item.label}
              className={`flex h-10 items-center gap-3 rounded-md px-3 text-left text-sm font-medium transition ${
                index === 0 ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <Icon className="size-4" aria-hidden="true" />
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto pt-6">
        <Button className="w-full justify-start" variant="ghost" onClick={handleLogout}>
          <LogOut className="size-4" aria-hidden="true" />
          Sign out
        </Button>
      </div>
    </aside>
  );
}
