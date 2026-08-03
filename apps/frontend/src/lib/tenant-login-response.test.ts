import { describe, expect, it } from "vitest";
import { isPasswordChangeRequired } from "./tenant-login-response";

describe("isPasswordChangeRequired", () => {
  it("detects the password-change challenge", () => {
    expect(
      isPasswordChangeRequired({
        requiresPasswordChange: true,
        changeToken: "tok",
        user: { id: "1", email: "a", name: "A", role: "STAFF", workspaceId: "w" }
      })
    ).toBe(true);
  });

  it("rejects a normal session response", () => {
    expect(
      isPasswordChangeRequired({
        accessToken: "jwt",
        user: { id: "1", email: "a", name: "A", role: "STAFF", workspaceId: "w" }
      })
    ).toBe(false);
  });
});
