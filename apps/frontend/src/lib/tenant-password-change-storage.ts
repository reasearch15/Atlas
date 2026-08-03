/**
 * sessionStorage key for the short-lived first-login password-change challenge.
 * While this key is present, cookie refresh must not run (no refresh cookie exists yet).
 */
export function tenantPasswordChangeStorageKey(role: "coadmin" | "staff"): string {
  return `atlas:${role}:password-change`;
}

export type StoredTenantPasswordChange = {
  readonly passwordChangeToken: string;
  readonly username: string;
};

/**
 * In-memory probe pause so a concurrent login-page restore cannot hit /refresh
 * while a password-change challenge is being handled (before sessionStorage is set).
 */
let tenantCookieRefreshPaused = false;

export function pauseTenantCookieRefresh(): void {
  tenantCookieRefreshPaused = true;
}

export function resumeTenantCookieRefresh(): void {
  tenantCookieRefreshPaused = false;
}

export function isTenantCookieRefreshPaused(): boolean {
  return tenantCookieRefreshPaused;
}

/**
 * Persists the short-lived password-change challenge for this tab only.
 */
export function storeTenantPasswordChangeChallenge(
  role: "coadmin" | "staff",
  payload: StoredTenantPasswordChange
): void {
  pauseTenantCookieRefresh();
  if (typeof window === "undefined" || !window.sessionStorage) return;
  window.sessionStorage.setItem(tenantPasswordChangeStorageKey(role), JSON.stringify(payload));
}

/**
 * Reads a pending password-change challenge, supporting the passwordChangeToken field
 * and a brief legacy changeToken alias.
 */
export function readTenantPasswordChangeChallenge(role: "coadmin" | "staff"): StoredTenantPasswordChange | null {
  if (typeof window === "undefined" || !window.sessionStorage) return null;
  const raw = window.sessionStorage.getItem(tenantPasswordChangeStorageKey(role));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      passwordChangeToken?: string;
      changeToken?: string;
      username?: string;
    };
    const passwordChangeToken = parsed.passwordChangeToken ?? parsed.changeToken;
    if (!passwordChangeToken || !parsed.username) return null;
    return { passwordChangeToken, username: parsed.username };
  } catch {
    window.sessionStorage.removeItem(tenantPasswordChangeStorageKey(role));
    return null;
  }
}

/**
 * Clears the pending challenge after success or abandonment.
 */
export function clearTenantPasswordChangeChallenge(role: "coadmin" | "staff"): void {
  if (typeof window !== "undefined" && window.sessionStorage) {
    window.sessionStorage.removeItem(tenantPasswordChangeStorageKey(role));
  }
  resumeTenantCookieRefresh();
}

/**
 * True when a first-login password-change token is waiting in this tab, or refresh is paused.
 */
export function hasPendingTenantPasswordChange(expectedRole?: "COADMIN" | "STAFF"): boolean {
  if (tenantCookieRefreshPaused) return true;
  if (typeof window === "undefined" || !window.sessionStorage) return false;
  const roles =
    expectedRole === "STAFF"
      ? (["staff"] as const)
      : expectedRole === "COADMIN"
        ? (["coadmin"] as const)
        : (["coadmin", "staff"] as const);
  return roles.some((role) => readTenantPasswordChangeChallenge(role) !== null);
}
