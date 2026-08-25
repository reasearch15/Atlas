/**
 * Phase 4 public player naming for channel posts.
 *
 * Product rule: never publish Telegram username, peer id, phone, or "Telegram user <id>".
 * Prefer a safe human-readable CRM/Telegram display label (including initials).
 * Staff privacy caps are separate — public posts use this stricter allowlist.
 */

const MAX_PUBLIC_NAME_LENGTH = 40;

/** Public channel posts intentionally do not publish Telegram @usernames. */
export const PUBLIC_LEADERBOARD_USERNAME_FALLBACK_ALLOWED = false;

export interface PublicLeaderboardNameSources {
  readonly displayName?: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  /**
   * Present for callers that have CRM/Telegram username available.
   * Ignored while {@link PUBLIC_LEADERBOARD_USERNAME_FALLBACK_ALLOWED} is false.
   */
  readonly username?: string | null;
}

/**
 * Sanitizes a single candidate label for public leaderboard posts.
 * Preserves multi-word names and initials (e.g. "L. J.", "S F").
 */
export function toPublicLeaderboardDisplayName(displayName: string | null | undefined): string {
  return sanitizePublicDisplayLabel(displayName) ?? "Player";
}

/**
 * Resolves a public leaderboard display label from available Atlas sources.
 * Username fallback stays disabled under current public privacy policy.
 */
export function resolvePublicLeaderboardDisplayName(sources: PublicLeaderboardNameSources): string {
  const fromDisplay = sanitizePublicDisplayLabel(sources.displayName);
  if (fromDisplay) return fromDisplay;

  const fromParts = sanitizePublicDisplayLabel(
    [sources.firstName, sources.lastName].filter((part) => part && part.trim()).join(" ")
  );
  if (fromParts) return fromParts;

  if (PUBLIC_LEADERBOARD_USERNAME_FALLBACK_ALLOWED) {
    const fromUsername = sanitizePublicUsername(sources.username);
    if (fromUsername) return fromUsername;
  }

  return "Player";
}

function sanitizePublicDisplayLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const collapsed = value.trim().replace(/\s+/g, " ");
  if (!collapsed) return null;

  if (/^@/.test(collapsed)) return null;
  if (/^-?\d{5,}$/.test(collapsed)) return null;
  if (/^telegram\s+user\s+-?\d+$/i.test(collapsed)) return null;
  if (/^\+?\d[\d\s().-]{6,}$/.test(collapsed)) return null;
  if (looksLikeExternalIdentifier(collapsed)) return null;
  if (/https?:\/\//i.test(collapsed) || /www\./i.test(collapsed)) return null;
  if (/[\u0000-\u001F\u007F]/.test(collapsed)) return null;
  if (/^unknown(\s|$)/i.test(collapsed)) return null;
  // Reject digit-bearing labels (peer-ish / coded handles masquerading as names).
  if (/\d/.test(collapsed)) return null;

  // Letters, marks, spaces, apostrophe, hyphen, periods (initials).
  const cleaned = collapsed.replace(/[^\p{L}\p{M}\s'.-]/gu, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;

  const letterCount = (cleaned.match(/\p{L}/gu) ?? []).length;
  if (letterCount < 1) return null;
  // Single bare letter with no initial punctuation/space is too thin to publish.
  if (letterCount === 1 && !/[.\s]/.test(cleaned)) return null;

  if (/^unknown/i.test(cleaned)) return null;

  return cleaned.slice(0, MAX_PUBLIC_NAME_LENGTH);
}

function sanitizePublicUsername(username: string | null | undefined): string | null {
  if (!username) return null;
  const trimmed = username.trim().replace(/^@/, "");
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(trimmed)) return null;
  return `@${trimmed}`.slice(0, MAX_PUBLIC_NAME_LENGTH);
}

function looksLikeExternalIdentifier(value: string): boolean {
  if (/@/.test(value)) return true;
  if (/^\+?\d+$/.test(value.replace(/[\s()-]/g, ""))) return true;
  return false;
}
