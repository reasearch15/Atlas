/**
 * Standard HTML attributes that keep browser password managers working.
 */
import { getPostLoginRoute, type PostLoginRoute } from "@/lib/post-login-route";

export const loginUsernameInputProps = {
  name: "username",
  autoComplete: "username"
} as const;

export const loginPasswordInputProps = {
  name: "password",
  type: "password",
  autoComplete: "current-password"
} as const;

export const currentPasswordInputProps = {
  name: "current-password",
  type: "password",
  autoComplete: "current-password"
} as const;

export const newPasswordInputProps = {
  name: "new-password",
  type: "password",
  autoComplete: "new-password"
} as const;

export const confirmNewPasswordInputProps = {
  name: "confirm-password",
  type: "password",
  autoComplete: "new-password"
} as const;

/**
 * Returns the post-auth landing path for a restored or logged-in role.
 * Prefer importing getPostLoginRoute directly for new call sites.
 */
export function landingPathForRole(role: string | null | undefined): PostLoginRoute {
  return getPostLoginRoute(role);
}
