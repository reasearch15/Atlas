import { ApiClientError } from "@/lib/api-client-error";

export { ApiClientError };

/**
 * Returns false when a submit should be ignored because one is already in flight.
 */
export function shouldAcceptLoginSubmit(pending: boolean): boolean {
  return !pending;
}

/**
 * Formats remaining lockout seconds for the Sign-in button / banner.
 */
export function formatLoginRetryCountdown(seconds: number): string {
  const safe = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(safe / 60);
  const rem = safe % 60;
  if (minutes <= 0) return `${rem}s`;
  return `${minutes}m ${rem.toString().padStart(2, "0")}s`;
}

/**
 * Human-readable login error distinguishing rate limit from bad credentials.
 */
export function loginErrorMessage(error: unknown, countdownSeconds?: number): string {
  if (error instanceof ApiClientError && error.isRateLimited) {
    const wait =
      typeof countdownSeconds === "number" && countdownSeconds > 0
        ? formatLoginRetryCountdown(countdownSeconds)
        : typeof error.retryAfterSeconds === "number"
          ? formatLoginRetryCountdown(error.retryAfterSeconds)
          : null;
    return wait
      ? `Too many sign-in attempts. Try again in ${wait}.`
      : "Too many sign-in attempts. Please wait and try again.";
  }
  if (error instanceof ApiClientError && error.isInvalidCredentials) {
    return error.message.replace(/^UNAUTHORIZED:\s*/, "") || "Invalid username or password.";
  }
  if (error instanceof Error) return error.message;
  return "Sign in failed.";
}
