/**
 * Structured staff/coadmin auth diagnostics — never logs token values.
 */

export type TenantRefreshFailureReason =
  | "cookie_missing"
  | "token_invalid"
  | "session_not_found"
  | "session_user_mismatch"
  | "session_revoked"
  | "session_expired"
  | "role_mismatch"
  | "dashboard_blocked"
  | "hash_mismatch"
  | "grace_unavailable";

export interface TenantAuthDiagnosticEvent {
  readonly event:
    | "staffCookieWritten"
    | "coadminCookieWritten"
    | "staffCookiePresentOnRefresh"
    | "coadminCookiePresentOnRefresh"
    | "staffSessionCreated"
    | "coadminSessionCreated"
    | "staffSessionFound"
    | "coadminSessionFound"
    | "staffSessionRole"
    | "coadminSessionRole"
    | "staffSessionExpired"
    | "coadminSessionExpired"
    | "refreshFailureReason";
  readonly role: "STAFF" | "COADMIN";
  readonly cookieName: string;
  readonly cookiePath: string;
  readonly sessionId?: string;
  readonly userId?: string;
  readonly sessionRole?: string;
  readonly cookiePresent?: boolean;
  readonly refreshFailureReason?: TenantRefreshFailureReason;
  readonly secure?: boolean;
  readonly sameSite?: string;
  readonly httpOnly?: boolean;
}

/**
 * Emits one JSON diagnostic line for staff/coadmin auth persistence debugging.
 */
export function logTenantAuthDiagnostic(payload: TenantAuthDiagnosticEvent): void {
  console.info(JSON.stringify({ ...payload, at: new Date().toISOString() }));
}

export function cookieWrittenEvent(
  role: "STAFF" | "COADMIN",
  cookieName: string,
  cookiePath: string,
  options: { readonly secure: boolean; readonly sameSite: string; readonly httpOnly: boolean }
): TenantAuthDiagnosticEvent {
  return {
    event: role === "STAFF" ? "staffCookieWritten" : "coadminCookieWritten",
    role,
    cookieName,
    cookiePath,
    secure: options.secure,
    sameSite: options.sameSite,
    httpOnly: options.httpOnly
  };
}
