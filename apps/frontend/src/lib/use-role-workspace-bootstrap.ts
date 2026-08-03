"use client";

import { useEffect, useState } from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import {
  clearRoleAuthBootstrap,
  ensureRoleAuthenticated,
  isRoleAuthReady,
  type AuthBootstrapStatus
} from "@/lib/auth-bootstrap";
import { getLoginRouteForRole } from "@/lib/post-login-route";
import { useAuthStore } from "@/stores/auth-store";

type ExpectedRole = "PLATFORM_ADMIN" | "COADMIN" | "STAFF";

/**
 * Shared shell bootstrap: one explicit status, no bootStarted cancel race.
 */
export function useRoleWorkspaceBootstrap(expectedRole: ExpectedRole): {
  readonly status: AuthBootstrapStatus;
  readonly error: string | null;
  readonly retry: () => void;
} {
  const router = useRouter();
  const clearSession = useAuthStore((state) => state.clearSession);
  const accessToken = useAuthStore((state) => state.accessToken);
  const userRole = useAuthStore((state) => state.user?.role ?? null);
  const [status, setStatus] = useState<AuthBootstrapStatus>(() =>
    isRoleAuthReady(expectedRole) && accessToken && userRole === expectedRole ? "AUTHENTICATED" : "LOADING"
  );
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    // Soft-nav after login: store already has the role token and bootstrap was marked ready.
    if (isRoleAuthReady(expectedRole) && accessToken && userRole === expectedRole) {
      setStatus("AUTHENTICATED");
      setError(null);
      return;
    }

    setStatus("LOADING");
    setError(null);

    void (async () => {
      const result = await ensureRoleAuthenticated(expectedRole);
      if (cancelled) return;
      if (!result.ok) {
        clearRoleAuthBootstrap(expectedRole);
        clearSession();
        setStatus("UNAUTHENTICATED");
        setError(result.error);
        router.replace(getLoginRouteForRole(expectedRole) as Route);
        return;
      }
      setStatus("AUTHENTICATED");
      setError(null);
    })();

    return () => {
      cancelled = true;
    };
  }, [accessToken, attempt, clearSession, expectedRole, router, userRole]);

  return {
    status,
    error,
    retry: () => {
      clearRoleAuthBootstrap(expectedRole);
      setAttempt((value) => value + 1);
    }
  };
}
