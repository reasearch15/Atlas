/**
 * Phase 4 public player naming for channel posts.
 *
 * Product rule: never publish Telegram username, peer id, phone, or "Telegram user <id>".
 * Prefer a safe human-readable CRM/Telegram display label (including initials and
 * gamer-style names that contain digits, e.g. Kapnocap85).
 * Staff privacy caps are separate — public posts use this stricter allowlist.
 *
 * The generic token "Player" is only a last-resort fallback. It is never treated
 * as a real CRM/Telegram identity, so recovery can still use first/last/title.
 */

const MAX_PUBLIC_NAME_LENGTH = 40;

/** Last-resort public label when no safe human-readable identity exists. */
export const PUBLIC_LEADERBOARD_FALLBACK_NAME = "Player";

/** Public channel posts intentionally do not publish Telegram @usernames. */
export const PUBLIC_LEADERBOARD_USERNAME_FALLBACK_ALLOWED = false;

export interface PublicLeaderboardNameSources {
  readonly displayName?: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  /** Private telegram_chats.title (never a group/channel title). */
  readonly title?: string | null;
  /**
   * Present for callers that have CRM/Telegram username available.
   * Ignored while {@link PUBLIC_LEADERBOARD_USERNAME_FALLBACK_ALLOWED} is false.
   */
  readonly username?: string | null;
}

/**
 * Sanitizes a single candidate label for public leaderboard posts.
 * Preserves multi-word names, initials (e.g. "L. J.", "A.J.", "J R"), and
 * letter-led names that contain digits (e.g. "Kapnocap85").
 */
export function toPublicLeaderboardDisplayName(displayName: string | null | undefined): string {
  return tryPublicLeaderboardDisplayName(displayName) ?? PUBLIC_LEADERBOARD_FALLBACK_NAME;
}

/** Returns the sanitized label, or null when the value must not be published. */
export function tryPublicLeaderboardDisplayName(displayName: string | null | undefined): string | null {
  return sanitizePublicDisplayLabel(displayName);
}

/**
 * True when a stored CRM label would publish as {@link PUBLIC_LEADERBOARD_FALLBACK_NAME}.
 * Used to decide whether Telegram identity may replace the CRM value.
 */
export function isWeakPublicLeaderboardCrmName(displayName: string | null | undefined): boolean {
  return tryPublicLeaderboardDisplayName(displayName) == null;
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

  const fromFirst = sanitizePublicDisplayLabel(sources.firstName);
  if (fromFirst) return fromFirst;

  const fromLast = sanitizePublicDisplayLabel(sources.lastName);
  if (fromLast) return fromLast;

  const fromTitle = sanitizePublicDisplayLabel(sources.title);
  if (fromTitle) return fromTitle;

  if (PUBLIC_LEADERBOARD_USERNAME_FALLBACK_ALLOWED) {
    const fromUsername = sanitizePublicUsername(sources.username);
    if (fromUsername) return fromUsername;
  }

  return PUBLIC_LEADERBOARD_FALLBACK_NAME;
}

function sanitizePublicDisplayLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const collapsed = value.trim().replace(/\s+/g, " ");
  if (!collapsed) return null;

  if (/^player$/i.test(collapsed)) return null;
  if (/^@/.test(collapsed)) return null;
  if (/^-?\d{5,}$/.test(collapsed)) return null;
  if (/^telegram\s+user\s+-?\d+$/i.test(collapsed)) return null;
  if (/^\+?\d[\d\s().-]{6,}$/.test(collapsed)) return null;
  if (looksLikeExternalIdentifier(collapsed)) return null;
  if (/https?:\/\//i.test(collapsed) || /www\./i.test(collapsed)) return null;
  if (/[\u0000-\u001F\u007F]/.test(collapsed)) return null;
  if (/^unknown(\s|$)/i.test(collapsed)) return null;

  // Letters, marks, digits (Kapnocap85 / Player2), spaces, apostrophe, hyphen, periods
  // (initials such as "L. J.", "A.J.", "J R").
  const cleaned = collapsed.replace(/[^\p{L}\p{M}\p{Nd}\s'.-]/gu, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  if (/^player$/i.test(cleaned)) return null;
  if (looksLikeCodedPublicIdentifier(cleaned)) return null;

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
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return true;
  return false;
}

/**
 * Rejects digit-dominant / coded tokens (peer-ish handles like "580.1a") while
 * allowing human-readable CRM names that merely contain digits (Kapnocap85).
 */
function looksLikeCodedPublicIdentifier(value: string): boolean {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return true;
  }
  const letterCount = (value.match(/\p{L}/gu) ?? []).length;
  const digitCount = (value.match(/\p{Nd}/gu) ?? []).length;
  return digitCount > 0 && digitCount >= letterCount;
}
