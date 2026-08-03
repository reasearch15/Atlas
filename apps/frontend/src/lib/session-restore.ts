import type { AuthResponse, AuthUser } from "@atlas/shared";
import { isRoleAuthReady, markRoleAuthenticated } from "@/lib/auth-bootstrap";
import { getPostLoginRoute } from "@/lib/post-login-route";
import { useAuthStore } from "@/stores/auth-store";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type TenantRefreshPath = "/api/coadmin-auth/refresh" | "/api/staff-auth/refresh";

/**
 * Waits until the zustand auth persist layer has rehydrated from localStorage.
 * Re-checks after subscribing so hydration cannot complete between the check and the listener.
 */
export function waitForAuthHydration(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (useAuthStore.persist?.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = useAuthStore.persist.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
    if (useAuthStore.persist?.hasHydrated()) {
      unsubscribe();
      resolve();
    }
  });
}

/**
 * Attempts a single cookie-backed refresh against the given endpoint.
 */
export async function attemptRefresh(refreshPath: TenantRefreshPath | "/api/admin-auth/refresh" | "/api/auth/refresh"): Promise<AuthResponse | null> {
  // Cookie-only POST: never send Content-Type without a JSON body (Fastify rejects empty JSON).
  const response = await fetch(`${apiBaseUrl}${refreshPath}`, {
    method: "POST",
    credentials: "include"
  });
  if (!response.ok) return null;
  const body = (await response.json()) as AuthResponse;
  if (!body.accessToken || !body.user) return null;
  useAuthStore.getState().setSession(body.accessToken, body.user);
  markRoleAuthenticated(body.user.role);
  return body;
}

/**
 * Chooses refresh endpoints based on the last known role, then falls back.
 */
export function refreshPathsForRole(role: string | null | undefined): TenantRefreshPath[] {
  if (role === "STAFF") {
    return ["/api/staff-auth/refresh", "/api/coadmin-auth/refresh"];
  }
  return ["/api/coadmin-auth/refresh", "/api/staff-auth/refresh"];
}

/**
 * Restores a Coadmin/Staff session from the HttpOnly refresh cookie.
 * Preserves a freshly authenticated in-memory session (post-login handoff)
 * when role bootstrap was already marked ready.
 */
export async function restoreTenantSession(): Promise<AuthUser | null> {
  await waitForAuthHydration();
  const existing = useAuthStore.getState();
  const preferredRole = existing.user?.role ?? null;

  if (
    existing.accessToken &&
    existing.user &&
    (existing.user.role === "STAFF" || existing.user.role === "COADMIN") &&
    isRoleAuthReady(existing.user.role)
  ) {
    return existing.user;
  }

  for (const path of refreshPathsForRole(preferredRole)) {
    const restored = await attemptRefresh(path);
    if (restored) return restored.user;
  }

  const again = useAuthStore.getState();
  if (
    again.accessToken &&
    again.user &&
    (again.user.role === "STAFF" || again.user.role === "COADMIN") &&
    isRoleAuthReady(again.user.role)
  ) {
    return again.user;
  }

  useAuthStore.getState().clearSession();
  return null;
}

/**
 * Resolves where an authenticated tenant user should land after restore/login.
 */
export function resolveTenantLanding(user: AuthUser): "/workspace/inbox" | "/staff/inbox" {
  const path = getPostLoginRoute(user.role);
  return path === "/staff/inbox" ? "/staff/inbox" : "/workspace/inbox";
}
