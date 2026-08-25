import { describe, expect, it, vi } from "vitest";
import { cookieWrittenEvent, logTenantAuthDiagnostic, passwordChangeRequiredEvent } from "./tenant-auth-diagnostics";

describe("tenant auth diagnostics", () => {
  it("emits staffCookieWritten without a token value", () => {
    const payload = cookieWrittenEvent("STAFF", "atlas_staff_refresh", "/api/staff-auth", {
      secure: true,
      sameSite: "lax",
      httpOnly: true,
      domainPresent: false,
      maxAgePresent: true
    });
    expect(payload.event).toBe("staffCookieWritten");
    expect(payload.cookieName).toBe("atlas_staff_refresh");
    expect(payload.cookiePath).toBe("/api/staff-auth");
    expect(payload.cookieWritten).toBe(true);
    expect(payload.domainPresent).toBe(false);
    expect(payload.maxAgePresent).toBe(true);
    expect(JSON.stringify(payload)).not.toMatch(/eyJ|token/i);
  });

  it("emits staffLoginRequiresPasswordChange with cookieWritten false", () => {
    const payload = passwordChangeRequiredEvent("STAFF", "atlas_staff_refresh", "/api/staff-auth", "user-1");
    expect(payload.event).toBe("staffLoginRequiresPasswordChange");
    expect(payload.cookieWritten).toBe(false);
    expect(payload.userId).toBe("user-1");
  });

  it("logs JSON via console.info", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    logTenantAuthDiagnostic({
      event: "refreshFailureReason",
      role: "STAFF",
      cookieName: "atlas_staff_refresh",
      cookiePath: "/api/staff-auth",
      refreshFailureReason: "cookie_missing"
    });
    expect(spy).toHaveBeenCalledOnce();
    const line = String(spy.mock.calls[0]?.[0]);
    expect(line).toContain("cookie_missing");
    expect(line).not.toMatch(/eyJ/);
    spy.mockRestore();
  });
});
