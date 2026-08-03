import type { AuthResponse, AuthUser } from "@atlas/shared";
import { isRoleAuthReady, markRoleAuthenticated } from "@/lib/auth-bootstrap";
import { getPostLoginRoute } from "@/lib/post-login-route";
import { publicApiUrl } from "@/lib/public-api-url";
import { useAuthStore } from "@/stores/auth-store";

const apiBaseUrl = publicApiUrl;
const AUTH_HYDRATION_TIMEOUT_MS = 2_000;
const REFRESH_TIMEOUT_MS = 10_000;

export type TenantRefreshPath = "/api/coadmin-auth/refresh" | "/api/staff-auth/refresh";

/**
 * Waits until the zustand auth persist layer has rehydrated from localStorage.
 * Always resolves: missing persist, hydration errors, or a timeout must not block login.
 */
export function waitForAuthHydration(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  const persistApi = useAuthStore.persist;
  if (!persistApi?.hasHydrated || !persistApi.onFinishHydration) {
    return Promise.resolve();
  }
  if (persistApi.hasHydrated()) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      unsubscribe?.();
      resolve();
    };

    const unsubscribe = persistApi.onFinishHydration(() => {
      finish();
    });

    if (persistApi.hasHydrated()) {
      finish();
      return;
    }

    const timeoutId = window.setTimeout(finish, AUTH_HYDRATION_TIMEOUT_MS);
  });
}

/**
 * Attempts a single cookie-backed refresh against the given endpoint.
 * Network/CORS failures return null so callers can fall through to the login form.
 */
export async function attemptRefresh(refreshPath: TenantRefreshPath | "/api/admin-auth/refresh" | "/api/auth/refresh"): Promise<AuthResponse | null> {
  try {
    // Cookie-only POST: never send Content-Type without a JSON body (Fastify rejects empty JSON).
    const response = await fetch(`${apiBaseUrl}${refreshPath}`, {
      method: "POST",
      credentials: "include",
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const body = (await response.json()) as AuthResponse;
    if (!body.accessToken || !body.user) return null;
    useAuthStore.getState().setSession(body.accessToken, body.user);
    markRoleAuthenticated(body.user.role);
    return body;
  } catch {
    return null;
  }
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
