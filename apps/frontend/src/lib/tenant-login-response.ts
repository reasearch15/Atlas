import type { AuthResponse, PasswordChangeRequiredResponse, TenantLoginResponse } from "@atlas/shared";

/**
 * Discriminates the mandatory first-login password-change response.
 * Prefer this over `"requiresPasswordChange" in response` so AuthResponse shapes
 * never accidentally look like a password-change challenge.
 */
export function isPasswordChangeRequired(
  response: TenantLoginResponse
): response is PasswordChangeRequiredResponse {
  return (
    typeof response === "object" &&
    response !== null &&
    "requiresPasswordChange" in response &&
    (response as PasswordChangeRequiredResponse).requiresPasswordChange === true &&
    typeof (response as PasswordChangeRequiredResponse).changeToken === "string" &&
    !("accessToken" in response && typeof (response as AuthResponse).accessToken === "string")
  );
}
