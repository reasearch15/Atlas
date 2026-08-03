"use client";

import type { AuthResponse } from "@atlas/shared";
import { toast } from "sonner";
import { clearRoleAuthBootstrap } from "@/lib/auth-bootstrap";
import { attemptRefresh } from "@/lib/session-restore";
import { clearRoleSensitiveClientCaches } from "@/lib/sensitive-cache";
import { useAuthStore } from "@/stores/auth-store";

export type RefreshPath =
  | "/api/admin-auth/refresh"
  | "/api/staff-auth/refresh"
  | "/api/coadmin-auth/refresh"
  | "/api/auth/refresh";

const refreshLocks = new Map<RefreshPath, Promise<boolean>>();

/**
 * Test helper: clears in-flight refresh promises between cases.
 */
export function resetAuthRefreshLocksForTests(): void {
  refreshLocks.clear();
}

/**
 * Resolves the refresh endpoint for the protected route family.
 * Staff-capable route families refresh against Staff when the signed-in user is Staff.
 */
export function refreshPathFor(path: string): RefreshPath | null {
  if (path.startsWith("/api/admin")) return "/api/admin-auth/refresh";
  if (path.startsWith("/api/staff-auth")) return "/api/staff-auth/refresh";
  if (path.startsWith("/api/coadmin-auth")) return "/api/coadmin-auth/refresh";
  if (
    path.startsWith("/api/staff") ||
    path.startsWith("/api/developer-apps") ||
    path.startsWith("/api/telegram") ||
    path.startsWith("/api/crm") ||
    path.startsWith("/api/internal-messages") ||
    path.startsWith("/api/dashboard") ||
    path.startsWith("/api/audit-logs") ||
    path.startsWith("/api/users") ||
    path.startsWith("/api/workspaces")
  ) {
    const role = useAuthStore.getState().user?.role;
    return role === "STAFF" ? "/api/staff-auth/refresh" : "/api/coadmin-auth/refresh";
  }
  if (path.startsWith("/api/auth")) return "/api/auth/refresh";
  return null;
}

/**
 * Single-flight cookie refresh for a protected API path.
 * Concurrent callers share one in-flight refresh for the same endpoint.
 */
export async function refreshSessionForPath(path: string): Promise<boolean> {
  const refreshPath = refreshPathFor(path);
  if (!refreshPath || path === refreshPath || path.endsWith("/login") || path.endsWith("/change-password")) {
    return false;
  }

  const existing = refreshLocks.get(refreshPath);
  if (existing) return existing;

  const pending = attemptRefresh(refreshPath)
    .then((restored: AuthResponse | null) => Boolean(restored))
    .finally(() => {
      refreshLocks.delete(refreshPath);
    });
  refreshLocks.set(refreshPath, pending);
  return pending;
}

/**
 * Clears local auth state and sends the browser to sign-in after refresh failure.
 */
export function handleFailedSessionRefresh(): void {
  clearRoleAuthBootstrap();
  clearRoleSensitiveClientCaches();
  useAuthStore.getState().clearSession();
  toast.error("Your session expired. Please sign in again.");
  if (typeof window !== "undefined") {
    window.location.assign("/login");
  }
}
