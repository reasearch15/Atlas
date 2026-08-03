import type { Role } from "@atlas/shared";

export type PostLoginRoute = "/admin" | "/workspace/inbox" | "/staff/inbox" | "/login";

/**
 * Centralized post-login destination for every Atlas role.
 * Use for login success, session restore, password-change completion, and wrong-role redirects.
 */
export function getPostLoginRoute(role: string | null | undefined): PostLoginRoute {
  switch (role as Role | null | undefined) {
    case "PLATFORM_ADMIN":
      return "/admin";
    case "COADMIN":
      return "/workspace/inbox";
    case "STAFF":
      return "/staff/inbox";
    default:
      return "/login";
  }
}

/**
 * Login page path for a role (used after logout / invalid session).
 */
export function getLoginRouteForRole(role: string | null | undefined): "/admin/login" | "/coadmin/login" | "/staff/login" | "/login" {
  switch (role as Role | null | undefined) {
    case "PLATFORM_ADMIN":
      return "/admin/login";
    case "COADMIN":
      return "/coadmin/login";
    case "STAFF":
      return "/staff/login";
    default:
      return "/login";
  }
}
