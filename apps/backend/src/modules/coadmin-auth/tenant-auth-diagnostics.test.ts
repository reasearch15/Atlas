import { describe, expect, it, vi } from "vitest";
import { cookieWrittenEvent, logTenantAuthDiagnostic } from "./tenant-auth-diagnostics";

describe("tenant auth diagnostics", () => {
  it("emits structured events without token fields", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    logTenantAuthDiagnostic(
      cookieWrittenEvent("STAFF", "atlas_staff_refresh", "/api/staff-auth", {
        secure: true,
        sameSite: "lax",
        httpOnly: true
      })
    );
    expect(spy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(spy.mock.calls[0]?.[0]));
    expect(payload.event).toBe("staffCookieWritten");
    expect(payload.cookieName).toBe("atlas_staff_refresh");
    expect(payload.cookiePath).toBe("/api/staff-auth");
    expect(JSON.stringify(payload)).not.toMatch(/eyJ/);
    expect(payload).not.toHaveProperty("token");
    expect(payload).not.toHaveProperty("refreshToken");
    spy.mockRestore();
  });
});
