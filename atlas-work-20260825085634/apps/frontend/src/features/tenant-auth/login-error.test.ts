import { describe, expect, it } from "vitest";
import { ApiClientError } from "@/lib/api-client-error";
import {
  formatLoginRetryCountdown,
  loginErrorMessage,
  shouldAcceptLoginSubmit
} from "./login-error";

describe("tenant login rate-limit UX", () => {
  it("suppresses duplicate concurrent submits while pending", () => {
    expect(shouldAcceptLoginSubmit(false)).toBe(true);
    expect(shouldAcceptLoginSubmit(true)).toBe(false);
  });

  it("formats Retry-After countdown for display", () => {
    expect(formatLoginRetryCountdown(45)).toBe("45s");
    expect(formatLoginRetryCountdown(125)).toBe("2m 05s");
  });

  it("distinguishes rate limiting from invalid credentials", () => {
    const limited = new ApiClientError("RATE_LIMITED", "Too many attempts. Please wait and try again.", 429, 90);
    expect(loginErrorMessage(limited, 90)).toContain("Try again in");
    expect(loginErrorMessage(limited, 90)).toContain("1m 30s");

    const invalid = new ApiClientError("UNAUTHORIZED", "Invalid username or password.", 401);
    expect(loginErrorMessage(invalid)).toBe("Invalid username or password.");
  });
});
