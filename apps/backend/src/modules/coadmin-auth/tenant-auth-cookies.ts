import type { Env } from "../../config/env";

export interface TenantAuthCookieOptions {
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: "lax";
  readonly path: string;
  readonly maxAge: number;
  readonly domain?: string;
}

/**
 * Cookie Path for staff/coadmin refresh + logout (never scoped to /login only).
 */
export function tenantAuthCookiePath(role: "COADMIN" | "STAFF"): "/api/coadmin-auth" | "/api/staff-auth" {
  return role === "COADMIN" ? "/api/coadmin-auth" : "/api/staff-auth";
}

export function tenantRefreshCookieName(role: "COADMIN" | "STAFF"): "atlas_coadmin_refresh" | "atlas_staff_refresh" {
  return role === "COADMIN" ? "atlas_coadmin_refresh" : "atlas_staff_refresh";
}

export function tenantTrustedDeviceCookieName(role: "COADMIN" | "STAFF"): "atlas_coadmin_device" | "atlas_staff_device" {
  return role === "COADMIN" ? "atlas_coadmin_device" : "atlas_staff_device";
}

/**
 * Host-only Secure cookies for same-origin platform.atlast.work.
 * Omitting Domain avoids cross-subdomain surprises and matches the API host exactly.
 * Legacy Domain-scoped cookies are cleared separately on write.
 */
export function tenantAuthCookieOptions(
  env: Pick<Env, "COOKIE_SECURE" | "COOKIE_DOMAIN">,
  path: string,
  maxAge: number
): TenantAuthCookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    path,
    maxAge
  };
}

/** Options used only to clear cookies previously written with Domain=COOKIE_DOMAIN. */
export function tenantAuthLegacyDomainClearOptions(
  env: Pick<Env, "COOKIE_SECURE" | "COOKIE_DOMAIN">,
  path: string
): TenantAuthCookieOptions | null {
  if (env.COOKIE_DOMAIN === "localhost") return null;
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    path,
    maxAge: 0,
    domain: env.COOKIE_DOMAIN
  };
}
