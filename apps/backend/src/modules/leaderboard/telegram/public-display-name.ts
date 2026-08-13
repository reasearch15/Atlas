/**
 * Phase 4 public player naming for channel posts.
 *
 * Product rule: never publish Telegram username, peer id, phone, or "Telegram user <id>".
 * Prefer a first-name-like token from CRM displayName; otherwise "Player".
 * Staff privacy caps are separate — public posts use this stricter allowlist.
 */
export function toPublicLeaderboardDisplayName(displayName: string | null | undefined): string {
  if (!displayName) return "Player";
  const trimmed = displayName.trim();
  if (!trimmed) return "Player";
  if (/^@/.test(trimmed)) return "Player";
  if (/^-?\d{5,}$/.test(trimmed)) return "Player";
  if (/^telegram\s+user\s+-?\d+$/i.test(trimmed)) return "Player";
  if (/^\+?\d[\d\s().-]{6,}$/.test(trimmed)) return "Player";
  if (looksLikeExternalIdentifier(trimmed)) return "Player";

  const firstToken = trimmed.split(/\s+/)[0] ?? "";
  const cleaned = firstToken.replace(/[^\p{L}\p{M}'-]/gu, "").trim();
  if (!cleaned || cleaned.length < 2) return "Player";
  if (/^unknown/i.test(cleaned)) return "Player";
  return cleaned.slice(0, 40);
}

function looksLikeExternalIdentifier(value: string): boolean {
  if (/@/.test(value)) return true;
  if (/^\+?\d+$/.test(value.replace(/[\s()-]/g, ""))) return true;
  return false;
}
