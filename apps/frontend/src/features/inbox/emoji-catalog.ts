/** Compact emoji catalog for the composer picker (no third-party picker dependency). */

export interface EmojiEntry {
  readonly emoji: string;
  readonly name: string;
  readonly keywords: readonly string[];
}

export interface EmojiCategory {
  readonly id: string;
  readonly label: string;
  readonly emojis: readonly EmojiEntry[];
}

const smileys: EmojiEntry[] = [
  { emoji: "😀", name: "grinning", keywords: ["happy", "smile"] },
  { emoji: "😁", name: "beaming", keywords: ["happy", "teeth"] },
  { emoji: "😂", name: "joy", keywords: ["laugh", "lol"] },
  { emoji: "🤣", name: "rofl", keywords: ["laugh"] },
  { emoji: "😊", name: "blush", keywords: ["smile", "happy"] },
  { emoji: "😍", name: "heart eyes", keywords: ["love"] },
  { emoji: "😘", name: "kiss", keywords: ["love"] },
  { emoji: "😎", name: "cool", keywords: ["sunglasses"] },
  { emoji: "🤔", name: "thinking", keywords: ["hmm"] },
  { emoji: "😢", name: "cry", keywords: ["sad", "tear"] },
  { emoji: "😭", name: "sob", keywords: ["sad", "cry"] },
  { emoji: "😡", name: "angry", keywords: ["mad"] },
  { emoji: "👍", name: "thumbs up", keywords: ["ok", "yes", "like"] },
  { emoji: "👎", name: "thumbs down", keywords: ["no", "dislike"] },
  { emoji: "👏", name: "clap", keywords: ["applause"] },
  { emoji: "🙏", name: "pray", keywords: ["please", "thanks"] },
  { emoji: "🔥", name: "fire", keywords: ["hot", "lit"] },
  { emoji: "❤️", name: "red heart", keywords: ["love", "heart"] },
  { emoji: "✨", name: "sparkles", keywords: ["shine"] },
  { emoji: "🎉", name: "party", keywords: ["celebrate", "tada"] },
  { emoji: "💯", name: "hundred", keywords: ["100", "perfect"] },
  { emoji: "🤝", name: "handshake", keywords: ["deal"] },
  { emoji: "👀", name: "eyes", keywords: ["look"] },
  { emoji: "🙌", name: "raised hands", keywords: ["hooray"] }
];

const gestures: EmojiEntry[] = [
  { emoji: "👋", name: "wave", keywords: ["hello", "hi", "bye"] },
  { emoji: "✌️", name: "victory", keywords: ["peace"] },
  { emoji: "🤞", name: "crossed fingers", keywords: ["luck"] },
  { emoji: "👌", name: "ok hand", keywords: ["ok"] },
  { emoji: "💪", name: "muscle", keywords: ["strong"] },
  { emoji: "🫡", name: "salute", keywords: ["respect"] },
  { emoji: "✅", name: "check", keywords: ["done", "yes"] },
  { emoji: "❌", name: "cross", keywords: ["no", "wrong"] },
  { emoji: "⭐", name: "star", keywords: ["favorite"] },
  { emoji: "💡", name: "bulb", keywords: ["idea"] },
  { emoji: "📌", name: "pin", keywords: ["pushpin"] },
  { emoji: "📎", name: "paperclip", keywords: ["attach"] }
];

const objects: EmojiEntry[] = [
  { emoji: "📷", name: "camera", keywords: ["photo"] },
  { emoji: "🎥", name: "video camera", keywords: ["video"] },
  { emoji: "🎤", name: "microphone", keywords: ["voice", "mic"] },
  { emoji: "🎧", name: "headphones", keywords: ["music"] },
  { emoji: "📱", name: "phone", keywords: ["mobile"] },
  { emoji: "💻", name: "laptop", keywords: ["computer"] },
  { emoji: "🕐", name: "clock", keywords: ["time"] },
  { emoji: "📍", name: "pin", keywords: ["location", "map"] },
  { emoji: "✉️", name: "envelope", keywords: ["email", "mail"] },
  { emoji: "📄", name: "document", keywords: ["file", "page"] },
  { emoji: "🔒", name: "lock", keywords: ["secure"] },
  { emoji: "🔔", name: "bell", keywords: ["notify"] }
];

const nature: EmojiEntry[] = [
  { emoji: "🌞", name: "sun", keywords: ["weather", "day"] },
  { emoji: "🌙", name: "moon", keywords: ["night"] },
  { emoji: "☔", name: "umbrella", keywords: ["rain"] },
  { emoji: "🌸", name: "blossom", keywords: ["flower"] },
  { emoji: "🍀", name: "clover", keywords: ["luck"] },
  { emoji: "🐶", name: "dog", keywords: ["puppy", "pet"] },
  { emoji: "🐱", name: "cat", keywords: ["kitten", "pet"] },
  { emoji: "🍕", name: "pizza", keywords: ["food"] },
  { emoji: "☕", name: "coffee", keywords: ["drink", "tea"] },
  { emoji: "🎂", name: "cake", keywords: ["birthday"] },
  { emoji: "⚽", name: "soccer", keywords: ["ball", "sport"] },
  { emoji: "🚀", name: "rocket", keywords: ["launch"] }
];

/**
 * Categories shown in the compact emoji picker.
 */
export const EMOJI_CATEGORIES: readonly EmojiCategory[] = [
  { id: "smileys", label: "Smileys", emojis: smileys },
  { id: "gestures", label: "Gestures", emojis: gestures },
  { id: "objects", label: "Objects", emojis: objects },
  { id: "nature", label: "Nature", emojis: nature }
];

/**
 * Flat list used for search.
 */
export const ALL_EMOJIS: readonly EmojiEntry[] = EMOJI_CATEGORIES.flatMap((category) => category.emojis);

/**
 * Filters emojis by name/keywords (case-insensitive).
 */
export function searchEmojis(query: string, catalog: readonly EmojiEntry[] = ALL_EMOJIS): EmojiEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return catalog.slice();
  return catalog.filter((entry) => {
    if (entry.emoji.includes(normalized)) return true;
    if (entry.name.includes(normalized)) return true;
    return entry.keywords.some((keyword) => keyword.includes(normalized));
  });
}

/**
 * Inserts text at a caret range without replacing the whole string unintentionally.
 */
export function insertTextAtCursor(
  value: string,
  insertion: string,
  selectionStart: number,
  selectionEnd: number
): { readonly next: string; readonly caret: number } {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const next = `${value.slice(0, start)}${insertion}${value.slice(end)}`;
  return { next, caret: start + insertion.length };
}
