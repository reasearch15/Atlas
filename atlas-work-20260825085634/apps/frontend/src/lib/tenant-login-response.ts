import type { AuthResponse, PasswordChangeRequiredResponse, TenantLoginResponse } from "@atlas/shared";

/**
 * Reads the short-lived password-change token from a login challenge response.
 */
export function readPasswordChangeToken(response: PasswordChangeRequiredResponse): string | null {
  const token = response.passwordChangeToken ?? response.changeToken;
  return typeof token === "string" && token.length >= 32 ? token : null;
}

/**
 * Discriminates the mandatory first-login password-change response.
 * Prefer this over `"requiresPasswordChange" in response` so AuthResponse shapes
 * never accidentally look like a password-change challenge.
 */
export function isPasswordChangeRequired(
  response: TenantLoginResponse
): response is PasswordChangeRequiredResponse {
  if (typeof response !== "object" || response === null) return false;
  if (!("requiresPasswordChange" in response)) return false;
  if ((response as PasswordChangeRequiredResponse).requiresPasswordChange !== true) return false;
  if ("accessToken" in response && typeof (response as AuthResponse).accessToken === "string") {
    return false;
  }
  return readPasswordChangeToken(response as PasswordChangeRequiredResponse) !== null;
}
