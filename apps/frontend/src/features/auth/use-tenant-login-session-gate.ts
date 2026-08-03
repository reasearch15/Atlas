"use client";

import type { AuthUser } from "@atlas/shared";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { resolveTenantLanding, restoreTenantSession } from "@/lib/session-restore";
import { hasPendingTenantPasswordChange } from "@/lib/tenant-password-change-storage";

type SessionGateState =
  | { readonly status: "checking" }
  | { readonly status: "anonymous" }
  | { readonly status: "authenticated"; readonly user: AuthUser };

/**
 * Restores a tenant session before showing a login form, then redirects when valid.
 * Always leaves "checking" — failures and cancellations must surface the login form.
 * Skips cookie refresh while a first-login password-change token is pending (no refresh cookie yet).
 */
export function useTenantLoginSessionGate(options?: { readonly expectedRole?: "COADMIN" | "STAFF" }) {
  const router = useRouter();
  const [state, setState] = useState<SessionGateState>({ status: "checking" });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        if (hasPendingTenantPasswordChange(options?.expectedRole)) {
          if (!cancelled) setState({ status: "anonymous" });
          return;
        }
        const user = await restoreTenantSession(
          options?.expectedRole ? { expectedRole: options.expectedRole } : undefined
        );
        if (cancelled) return;
        if (!user) {
          setState({ status: "anonymous" });
          return;
        }
        if (options?.expectedRole && user.role !== options.expectedRole) {
          setState({ status: "anonymous" });
          return;
        }
        setState({ status: "authenticated", user });
        router.replace(resolveTenantLanding(user) as Route);
      } catch {
        if (cancelled) return;
        setState({ status: "anonymous" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [options?.expectedRole, router]);

  return state;
}
