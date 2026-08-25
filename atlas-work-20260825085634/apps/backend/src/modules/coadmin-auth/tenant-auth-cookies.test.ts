import { describe, expect, it } from "vitest";
import {
  tenantAuthCookieOptions,
  tenantAuthCookiePath,
  tenantAuthLegacyDomainClearOptions,
  tenantRefreshCookieName
} from "./tenant-auth-cookies";

describe("tenant auth cookies", () => {
  it("scopes staff refresh cookies to /api/staff-auth without a Domain attribute", () => {
    expect(tenantRefreshCookieName("STAFF")).toBe("atlas_staff_refresh");
    expect(tenantAuthCookiePath("STAFF")).toBe("/api/staff-auth");
    expect(
      tenantAuthCookieOptions({ COOKIE_SECURE: true, COOKIE_DOMAIN: "platform.atlast.work" }, "/api/staff-auth", 100)
    ).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/api/staff-auth",
      maxAge: 100
    });
  });

  it("keeps coadmin cookie name and path distinct from staff", () => {
    expect(tenantRefreshCookieName("COADMIN")).toBe("atlas_coadmin_refresh");
    expect(tenantAuthCookiePath("COADMIN")).toBe("/api/coadmin-auth");
    expect(tenantRefreshCookieName("COADMIN")).not.toBe(tenantRefreshCookieName("STAFF"));
  });

  it("clears only parent-domain legacy cookies (leading dot), never exact-host Domain", () => {
    expect(
      tenantAuthLegacyDomainClearOptions({ COOKIE_SECURE: true, COOKIE_DOMAIN: ".atlast.work" }, "/api/staff-auth")
    ).toMatchObject({ domain: ".atlast.work", path: "/api/staff-auth", maxAge: 0 });
    // Exact-host Domain shares host-only identity — clearing it in the same response cancels the new cookie.
    expect(
      tenantAuthLegacyDomainClearOptions({ COOKIE_SECURE: true, COOKIE_DOMAIN: "platform.atlast.work" }, "/api/staff-auth")
    ).toBeNull();
    expect(tenantAuthLegacyDomainClearOptions({ COOKIE_SECURE: false, COOKIE_DOMAIN: "localhost" }, "/api/staff-auth")).toBeNull();
  });
});
