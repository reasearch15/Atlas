import { describe, expect, it } from "vitest";
import { isPasswordChangeRequired, readPasswordChangeToken } from "./tenant-login-response";

describe("isPasswordChangeRequired", () => {
  it("detects the password-change challenge", () => {
    const response = {
      requiresPasswordChange: true as const,
      passwordChangeToken: "a".repeat(43),
      user: { id: "1", email: "a", name: "A", role: "STAFF" as const, workspaceId: "w" }
    };
    expect(isPasswordChangeRequired(response)).toBe(true);
    expect(readPasswordChangeToken(response)).toBe("a".repeat(43));
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
