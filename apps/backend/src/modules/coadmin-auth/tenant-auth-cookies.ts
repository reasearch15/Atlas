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
 * Legacy parent-domain cookies (Domain=.example.com) are cleared separately on write.
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

/**
 * Options used only to clear cookies previously written with Domain=.parent.tld.
 *
 * Exact-host COOKIE_DOMAIN values (no leading dot) are skipped: browsers treat
 * Domain=exact-host like host-only, and @fastify/cookie emits a separate Max-Age=0
 * Set-Cookie that can cancel the host-only token written in the same response.
 */
export function tenantAuthLegacyDomainClearOptions(
  env: Pick<Env, "COOKIE_SECURE" | "COOKIE_DOMAIN">,
  path: string
): TenantAuthCookieOptions | null {
  const domain = env.COOKIE_DOMAIN.trim();
  if (!domain || domain === "localhost" || !domain.startsWith(".")) {
    return null;
  }
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    path,
    maxAge: 0,
    domain
  };
}
