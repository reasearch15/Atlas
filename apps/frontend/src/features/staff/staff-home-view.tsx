"use client";

import { useEffect } from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { ensureRoleAuthenticated } from "@/lib/auth-bootstrap";
import { getLoginRouteForRole, getPostLoginRoute } from "@/lib/post-login-route";
import { useAuthStore } from "@/stores/auth-store";

/**
 * Staff home redirects to the inbox once auth bootstrap confirms the session.
 * Never clears a just-authenticated memory session while waiting on cookies.
 */
export function StaffHomeView() {
  const router = useRouter();
  const clearSession = useAuthStore((state) => state.clearSession);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await ensureRoleAuthenticated("STAFF");
      if (cancelled) return;
      if (!result.ok) {
        clearSession();
        router.replace(getLoginRouteForRole("STAFF") as Route);
        return;
      }
      router.replace(getPostLoginRoute("STAFF") as Route);
    })();
    return () => {
      cancelled = true;
    };
  }, [clearSession, router]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-sm text-muted-foreground">
      Opening Staff inbox...
    </main>
  );
}
