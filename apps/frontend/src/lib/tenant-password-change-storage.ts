/**
 * sessionStorage key for the short-lived first-login password-change challenge.
 * While this key is present, cookie refresh must not run (no refresh cookie exists yet).
 */
export function tenantPasswordChangeStorageKey(role: "coadmin" | "staff"): string {
  return `atlas:${role}:password-change`;
}

/**
 * True when a first-login password-change token is waiting in this tab.
 */
export function hasPendingTenantPasswordChange(expectedRole?: "COADMIN" | "STAFF"): boolean {
  if (typeof window === "undefined" || !window.sessionStorage) return false;
  const roles =
    expectedRole === "STAFF"
      ? (["staff"] as const)
      : expectedRole === "COADMIN"
        ? (["coadmin"] as const)
        : (["coadmin", "staff"] as const);
  return roles.some((role) => {
    try {
      const raw = window.sessionStorage.getItem(tenantPasswordChangeStorageKey(role));
      if (!raw) return false;
      const parsed = JSON.parse(raw) as { changeToken?: string };
      return typeof parsed.changeToken === "string" && parsed.changeToken.length > 0;
    } catch {
      return false;
    }
  });
}
