const STORAGE_KEY = "atlas.inbox.recent-emojis";
const MAX_RECENT = 24;

/**
 * Reads recently used emojis from localStorage (emoji characters only — never media blobs).
 */
export function loadRecentEmojis(storage: Pick<Storage, "getItem"> = localStorage): string[] {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/**
 * Persists a recently used emoji to the front of the list.
 */
export function rememberRecentEmoji(
  emoji: string,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage
): string[] {
  const trimmed = emoji.trim();
  if (!trimmed) return loadRecentEmojis(storage);
  const next = [trimmed, ...loadRecentEmojis(storage).filter((item) => item !== trimmed)].slice(0, MAX_RECENT);
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota / private mode — keep in-memory result only.
  }
  return next;
}
