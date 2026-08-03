import type { AuthUser, Role } from "@atlas/shared";
import { api } from "@/lib/api";
import { attemptRefresh, refreshPathsForRole, waitForAuthHydration } from "@/lib/session-restore";
import { useAuthStore } from "@/stores/auth-store";

export type AuthBootstrapStatus = "IDLE" | "LOADING" | "AUTHENTICATED" | "UNAUTHENTICATED" | "ERROR";

type RoleGate = "PLATFORM_ADMIN" | "COADMIN" | "STAFF";

interface RoleAuthCache {
  ready: boolean;
  promise: Promise<boolean> | null;
}

const roleAuthCache: Record<RoleGate, RoleAuthCache> = {
  PLATFORM_ADMIN: { ready: false, promise: null },
  COADMIN: { ready: false, promise: null },
  STAFF: { ready: false, promise: null }
};

/**
 * Marks a role session as authenticated after a successful login response.
 * Destination shells read this synchronously and skip the stuck loading gate.
 */
export function markRoleAuthenticated(role: string | null | undefined): void {
  const gate = toGate(role);
  if (!gate) return;
  roleAuthCache[gate].ready = true;
  roleAuthCache[gate].promise = Promise.resolve(true);
}

/**
 * Clears role auth bootstrap caches on logout / role switch.
 */
export function clearRoleAuthBootstrap(role?: string | null): void {
  const gates = role ? [toGate(role)].filter(Boolean) : (Object.keys(roleAuthCache) as RoleGate[]);
  for (const gate of gates) {
    if (!gate) continue;
    roleAuthCache[gate].ready = false;
    roleAuthCache[gate].promise = null;
  }
}

/**
 * Returns whether the role bootstrap already completed successfully in this tab.
 */
export function isRoleAuthReady(role: string | null | undefined): boolean {
  const gate = toGate(role);
  return gate ? roleAuthCache[gate].ready : false;
}

/**
 * Single authenticated-session bootstrap for Platform Admin / Coadmin / Staff shells.
 * Dedupes concurrent calls; never leaves callers waiting on a cancelled UI effect.
 */
export async function ensureRoleAuthenticated(expectedRole: RoleGate): Promise<{
  readonly ok: boolean;
  readonly user: AuthUser | null;
  readonly error: string | null;
}> {
  const cache = roleAuthCache[expectedRole];
  if (cache.ready) {
    const user = useAuthStore.getState().user;
    if (user?.role === expectedRole && useAuthStore.getState().accessToken) {
      return { ok: true, user, error: null };
    }
    cache.ready = false;
  }

  if (!cache.promise) {
    cache.promise = runBootstrap(expectedRole)
      .then((ok) => {
        cache.ready = ok;
        if (!ok) cache.promise = null;
        return ok;
      })
      .catch(() => {
        cache.promise = null;
        cache.ready = false;
        return false;
      });
  }

  const ok = await cache.promise;
  const user = useAuthStore.getState().user;
  if (!ok) {
    return { ok: false, user: null, error: "Session expired. Please sign in again." };
  }
  return { ok: true, user: user?.role === expectedRole ? user : null, error: null };
}

async function runBootstrap(expectedRole: RoleGate): Promise<boolean> {
  await waitForAuthHydration();
  const existing = useAuthStore.getState();

  if (existing.accessToken && existing.user?.role === expectedRole) {
    try {
      await validateMe(expectedRole);
      return true;
    } catch {
      // Fall through to cookie refresh before giving up.
    }
  }

  if (expectedRole === "PLATFORM_ADMIN") {
    const restored = await attemptRefresh("/api/admin-auth/refresh");
    if (!restored || restored.user.role !== "PLATFORM_ADMIN") {
      return false;
    }
    try {
      await api.adminMe();
      return true;
    } catch {
      return false;
    }
  }

  for (const path of refreshPathsForRole(expectedRole)) {
    const restored = await attemptRefresh(path);
    if (restored?.user.role === expectedRole) {
      try {
        await validateMe(expectedRole);
        return true;
      } catch {
        // Try next refresh path.
      }
    }
  }

  // Preserve a still-valid in-memory login if cookie refresh raced.
  const again = useAuthStore.getState();
  if (again.accessToken && again.user?.role === expectedRole) {
    try {
      await validateMe(expectedRole);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

async function validateMe(expectedRole: RoleGate): Promise<void> {
  if (expectedRole === "STAFF") {
    await api.staffMe();
    return;
  }
  if (expectedRole === "COADMIN") {
    await api.coadminMe();
    return;
  }
  await api.adminMe();
}

function toGate(role: string | null | undefined): RoleGate | null {
  if (role === "PLATFORM_ADMIN" || role === "COADMIN" || role === "STAFF") return role;
  return null;
}

export type { Role };
