import type { AuthResponse, AuthUser } from "@atlas/shared";
import { isRoleAuthReady, markRoleAuthenticated } from "@/lib/auth-bootstrap";
import { getPostLoginRoute } from "@/lib/post-login-route";
import { publicApiUrl } from "@/lib/public-api-url";
import { hasPendingTenantPasswordChange } from "@/lib/tenant-password-change-storage";
import { useAuthStore } from "@/stores/auth-store";

const apiBaseUrl = publicApiUrl;
const AUTH_HYDRATION_TIMEOUT_MS = 2_000;
const REFRESH_TIMEOUT_MS = 10_000;

export type TenantRefreshPath = "/api/coadmin-auth/refresh" | "/api/staff-auth/refresh";

const refreshInflight = new Map<string, Promise<AuthResponse | null>>();

/**
 * Test helper: clears in-flight cookie refresh promises between cases.
 */
export function resetTenantRefreshInflightForTests(): void {
  refreshInflight.clear();
}

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
 * Concurrent callers share one in-flight request per path (avoids refresh rotation races).
 * Network/CORS failures return null so callers can fall through to the login form.
 * Never probes while a forced password-change challenge is pending.
 */
export async function attemptRefresh(
  refreshPath: TenantRefreshPath | "/api/admin-auth/refresh" | "/api/auth/refresh"
): Promise<AuthResponse | null> {
  if (
    (refreshPath === "/api/staff-auth/refresh" || refreshPath === "/api/coadmin-auth/refresh") &&
    hasPendingTenantPasswordChange(
      refreshPath === "/api/staff-auth/refresh" ? "STAFF" : refreshPath === "/api/coadmin-auth/refresh" ? "COADMIN" : undefined
    )
  ) {
    return null;
  }

  const existing = refreshInflight.get(refreshPath);
  if (existing) return existing;

  const pending = performRefresh(refreshPath).finally(() => {
    refreshInflight.delete(refreshPath);
  });
  refreshInflight.set(refreshPath, pending);
  return pending;
}

async function performRefresh(
  refreshPath: TenantRefreshPath | "/api/admin-auth/refresh" | "/api/auth/refresh"
): Promise<AuthResponse | null> {
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
 * Chooses refresh endpoints for the known role.
 * Known Staff/Coadmin roles never probe the other role's cookie (avoids cross-role races).
 */
export function refreshPathsForRole(role: string | null | undefined): TenantRefreshPath[] {
  if (role === "STAFF") return ["/api/staff-auth/refresh"];
  if (role === "COADMIN") return ["/api/coadmin-auth/refresh"];
  return ["/api/coadmin-auth/refresh", "/api/staff-auth/refresh"];
}

function readReadyTenantUser(expectedRole?: "COADMIN" | "STAFF"): AuthUser | null {
  const existing = useAuthStore.getState();
  if (!existing.accessToken || !existing.user) return null;
  if (existing.user.role !== "STAFF" && existing.user.role !== "COADMIN") return null;
  if (expectedRole && existing.user.role !== expectedRole) return null;
  if (!isRoleAuthReady(existing.user.role)) return null;
  return existing.user;
}

/**
 * Restores a Coadmin/Staff session from the HttpOnly refresh cookie.
 * Preserves a freshly authenticated in-memory session (post-login handoff).
 * A Coadmin refresh 401 never clears an authenticated Staff session.
 */
export async function restoreTenantSession(options?: {
  readonly expectedRole?: "COADMIN" | "STAFF";
}): Promise<AuthUser | null> {
  await waitForAuthHydration();

  // First-login password change has no refresh cookie yet — never probe Coadmin/Staff refresh.
  if (hasPendingTenantPasswordChange(options?.expectedRole)) {
    return null;
  }

  const ready = readReadyTenantUser(options?.expectedRole);
  if (ready) return ready;

  const preferredRole = options?.expectedRole ?? useAuthStore.getState().user?.role ?? null;
  const paths = options?.expectedRole
    ? refreshPathsForRole(options.expectedRole)
    : refreshPathsForRole(preferredRole);

  for (const path of paths) {
    const midFlight = readReadyTenantUser(options?.expectedRole);
    if (midFlight) return midFlight;

    const restored = await attemptRefresh(path);
    if (restored) {
      if (options?.expectedRole && restored.user.role !== options.expectedRole) {
        continue;
      }
      return restored.user;
    }
  }

  const again = readReadyTenantUser(options?.expectedRole);
  if (again) return again;

  // Do not wipe a live Staff session because an anonymous Coadmin probe failed.
  const leftover = useAuthStore.getState();
  if (
    leftover.accessToken &&
    leftover.user &&
    (leftover.user.role === "STAFF" || leftover.user.role === "COADMIN") &&
    isRoleAuthReady(leftover.user.role)
  ) {
    if (!options?.expectedRole || leftover.user.role === options.expectedRole) {
      return leftover.user;
    }
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
