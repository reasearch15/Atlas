const REMEMBERED_USERNAME_KEY = "atlas:remembered-username";

/**
 * Normalizes a tenant username for storage and login submission.
 */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * Reads the locally remembered username, if any.
 * Never stores or returns a password.
 */
export function getRememberedUsername(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(REMEMBERED_USERNAME_KEY);
    if (!raw) return null;
    const normalized = normalizeUsername(raw);
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  }
}

/**
 * Persists only the normalized username for future login prefills.
 */
export function rememberUsername(username: string): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeUsername(username);
  if (!normalized) {
    clearRememberedUsername();
    return;
  }
  window.localStorage.setItem(REMEMBERED_USERNAME_KEY, normalized);
}

/**
 * Removes the remembered username preference.
 */
export function clearRememberedUsername(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(REMEMBERED_USERNAME_KEY);
}

/**
 * Applies the remember-username preference after a login attempt.
 */
export function applyRememberUsernamePreference(username: string, remember: boolean): void {
  if (remember) {
    rememberUsername(username);
    return;
  }
  clearRememberedUsername();
}

export const REMEMBERED_USERNAME_STORAGE_KEY = REMEMBERED_USERNAME_KEY;
