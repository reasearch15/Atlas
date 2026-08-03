import { describe, expect, it } from "vitest";
import { getLoginRouteForRole, getPostLoginRoute } from "./post-login-route";
import {
  clearRoleAuthBootstrap,
  isRoleAuthReady,
  markRoleAuthenticated
} from "./auth-bootstrap";

describe("getPostLoginRoute", () => {
  it("maps Staff, Coadmin, and Platform Admin to their workspaces", () => {
    expect(getPostLoginRoute("STAFF")).toBe("/staff/inbox");
    expect(getPostLoginRoute("COADMIN")).toBe("/workspace/inbox");
    expect(getPostLoginRoute("PLATFORM_ADMIN")).toBe("/admin");
  });

  it("maps unknown roles to /login", () => {
    expect(getPostLoginRoute(null)).toBe("/login");
    expect(getPostLoginRoute("NOPE")).toBe("/login");
  });
});

describe("getLoginRouteForRole", () => {
  it("returns role-specific login pages", () => {
    expect(getLoginRouteForRole("STAFF")).toBe("/staff/login");
    expect(getLoginRouteForRole("COADMIN")).toBe("/coadmin/login");
    expect(getLoginRouteForRole("PLATFORM_ADMIN")).toBe("/admin/login");
  });
});

describe("role auth bootstrap handoff", () => {
  it("marks login ready so destination shells skip the stuck loading gate", () => {
    clearRoleAuthBootstrap();
    expect(isRoleAuthReady("STAFF")).toBe(false);
    markRoleAuthenticated("STAFF");
    expect(isRoleAuthReady("STAFF")).toBe(true);
    clearRoleAuthBootstrap("STAFF");
    expect(isRoleAuthReady("STAFF")).toBe(false);
  });

  it("clears all role caches on logout so Staff cannot inherit Coadmin state", () => {
    markRoleAuthenticated("COADMIN");
    markRoleAuthenticated("STAFF");
    clearRoleAuthBootstrap();
    expect(isRoleAuthReady("COADMIN")).toBe(false);
    expect(isRoleAuthReady("STAFF")).toBe(false);
  });
});
