"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { LogOut, MessageSquare, MessagesSquare, MoreHorizontal, UserRound } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { MobileBottomNav } from "@/components/layout/mobile-bottom-nav";
import { MobileDrawer } from "@/components/layout/mobile-drawer";
import { MobileHeader } from "@/components/layout/mobile-header";
import { useAppViewportLock } from "@/components/layout/use-app-viewport-lock";
import { PwaInstallButton } from "@/components/pwa/pwa-install-button";
import { staffLogout } from "@/lib/api";
import { clearRoleAuthBootstrap } from "@/lib/auth-bootstrap";
import { useRoleWorkspaceBootstrap } from "@/lib/use-role-workspace-bootstrap";
import { useAuthStore } from "@/stores/auth-store";

const navItems = [
  { label: "Inbox", href: "/staff/inbox", icon: MessageSquare },
  { label: "Team Messages", href: "/staff/team-messages", icon: MessagesSquare }
] as const;

function pageTitle(pathname: string): string {
  if (pathname.startsWith("/staff/inbox")) return "Inbox";
  if (pathname.startsWith("/staff/team-messages")) return "Team Messages";
  return "Atlas Staff";
}

/**
 * Staff shell: desktop sidebar, tablet rail, mobile drawer + bottom nav.
 * Staff never sees Developer Apps, Telegram credentials, or Staff administration.
 */
export function StaffShell({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const user = useAuthStore((state) => state.user);
  const { status, error, retry } = useRoleWorkspaceBootstrap("STAFF");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  useAppViewportLock();

  async function signOut(): Promise<void> {
    clearRoleAuthBootstrap("STAFF");
    await staffLogout();
    router.replace("/login" as Route);
  }

  const isInbox = pathname === "/staff/inbox" || pathname.startsWith("/staff/inbox/");
  const isChatOpen = Boolean(pathname.match(/^\/staff\/inbox\/[^/]+\/?$/));
  const title = useMemo(() => pageTitle(pathname), [pathname]);

  if (status === "LOADING" || status === "IDLE") {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
        <p>Loading Staff workspace...</p>
      </div>
    );
  }

  if (status === "ERROR" || (status === "UNAUTHENTICATED" && error)) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 text-sm">
        <p className="text-muted-foreground">{error ?? "Unable to open Staff workspace."}</p>
        <Button type="button" variant="secondary" onClick={retry}>
          Retry
        </Button>
      </div>
    );
  }

  if (status !== "AUTHENTICATED") {
    return <div className="flex h-dvh items-center justify-center text-sm text-muted-foreground">Redirecting to sign in...</div>;
  }

  const navLinks = navItems.map((item) => {
    const Icon = item.icon;
    const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
    return (
      <Link
        key={item.href}
        href={item.href as Route}
        onClick={closeDrawer}
        className={`flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium ${
          active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
        }`}
      >
        <Icon className="size-4 shrink-0" aria-hidden="true" />
        {item.label}
      </Link>
    );
  });

  const accountActions = (
    <div className="grid gap-1">
      <PwaInstallButton variant="drawer" />
      <Button className="min-h-11 w-full justify-start" variant="ghost" onClick={() => void signOut()}>
        <LogOut className="size-4" aria-hidden="true" />
        Sign out
      </Button>
    </div>
  );

  return (
    <div className="app-viewport-frame flex w-full bg-background">
      <aside className="hidden h-full w-[16rem] shrink-0 flex-col overflow-hidden border-r bg-white p-4 lg:flex">
        <div className="mb-8 shrink-0 px-2">
          <p className="font-semibold">Atlas Staff</p>
          <p className="text-xs text-muted-foreground">{user?.email ?? user?.name}</p>
        </div>
        <nav className="grid min-h-0 flex-1 content-start gap-1 overflow-y-auto">{navLinks}</nav>
        <div className="mt-auto shrink-0 pt-4">{accountActions}</div>
      </aside>

      <aside className="hidden h-full w-16 shrink-0 flex-col items-center gap-1 overflow-hidden border-r bg-white py-3 md:flex lg:hidden">
        {navItems.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href as Route}
              title={item.label}
              aria-label={item.label}
              className={`flex size-11 items-center justify-center rounded-md ${
                active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
              }`}
            >
              <Icon className="size-5" aria-hidden="true" />
            </Link>
          );
        })}
      </aside>

      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* Inbox list owns its compact header — avoid a duplicate shell title. */}
        {!isChatOpen && !isInbox ? (
          <MobileHeader title={title} subtitle={user?.email ?? user?.name ?? null} onMenuClick={() => setDrawerOpen(true)} />
        ) : null}
        <div
          className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${
            isInbox ? "" : "overflow-y-auto overscroll-contain"
          } ${!isChatOpen ? "pb-[calc(3rem+env(safe-area-inset-bottom))] md:pb-0" : ""}`}
        >
          {children}
        </div>
      </div>

      {!isChatOpen ? (
        <MobileBottomNav
          items={[
            { href: "/staff/inbox", label: "Inbox", icon: MessageSquare },
            { href: "/staff/team-messages", label: "Team", icon: MessagesSquare },
            { href: "/staff/inbox", label: "More", icon: MoreHorizontal, onClick: () => setDrawerOpen(true) }
          ]}
        />
      ) : null}

      <MobileDrawer open={drawerOpen} title="Atlas Staff" onClose={closeDrawer} footer={accountActions}>
        <div className="mb-3 px-3">
          <div className="mb-2 flex size-11 items-center justify-center rounded-full bg-muted">
            <UserRound className="size-5 text-muted-foreground" aria-hidden="true" />
          </div>
          <p className="text-sm font-medium">{user?.name ?? "Staff"}</p>
          <p className="text-xs text-muted-foreground">{user?.email}</p>
        </div>
        <div className="grid gap-1">{navLinks}</div>
      </MobileDrawer>
    </div>
  );
}
