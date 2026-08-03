/**
 * Shared Telegram media content types, preview labels, and DTO helpers.
 */

export const TELEGRAM_CONTENT_TYPES = [
  "TEXT",
  "PHOTO",
  "VIDEO",
  "VIDEO_NOTE",
  "VOICE",
  "AUDIO",
  "DOCUMENT",
  "ANIMATION",
  "STICKER",
  "CONTACT",
  "LOCATION",
  "LIVE_LOCATION",
  "POLL",
  "DICE",
  "OTHER"
] as const;

export type TelegramContentType = (typeof TELEGRAM_CONTENT_TYPES)[number];

export const TELEGRAM_MEDIA_DOWNLOAD_STATES = [
  "NONE",
  "PENDING",
  "DOWNLOADING",
  "STORED",
  "FAILED",
  "SKIPPED",
  "UNAVAILABLE"
] as const;

export type TelegramMediaDownloadState = (typeof TELEGRAM_MEDIA_DOWNLOAD_STATES)[number];

/** Persisted when mediaStorageKey points at a missing object (e.g. after MinIO migration). */
export const MEDIA_ERROR_OBJECT_MISSING = "OBJECT_MISSING";

/**
 * Returns true when media bytes are known missing or permanently unavailable for display.
 */
export function isMediaUnavailable(message: {
  readonly mediaDownloadState?: string | null;
  readonly mediaError?: string | null;
}): boolean {
  if (message.mediaDownloadState === "UNAVAILABLE") return true;
  if (message.mediaError === MEDIA_ERROR_OBJECT_MISSING) return true;
  return false;
}

/** Maps content type → chat-list / notification preview label. */
const PREVIEW_LABELS: Record<TelegramContentType, string> = {
  TEXT: "",
  PHOTO: "📷 Photo",
  VIDEO: "🎥 Video",
  VIDEO_NOTE: "🎥 Video",
  VOICE: "🎤 Voice Message",
  AUDIO: "🎵 Audio",
  DOCUMENT: "📄 Document",
  ANIMATION: "🎞 GIF",
  STICKER: "🖼 Sticker",
  CONTACT: "👤 Contact",
  LOCATION: "📍 Location",
  LIVE_LOCATION: "📍 Location",
  POLL: "📊 Poll",
  DICE: "🎲 Dice",
  OTHER: "📎 Attachment"
};

/**
 * Returns whether a content type typically has downloadable binary media.
 */
export function contentTypeNeedsBinaryDownload(contentType: TelegramContentType): boolean {
  return (
    contentType === "PHOTO" ||
    contentType === "VIDEO" ||
    contentType === "VIDEO_NOTE" ||
    contentType === "VOICE" ||
    contentType === "AUDIO" ||
    contentType === "DOCUMENT" ||
    contentType === "ANIMATION" ||
    contentType === "STICKER"
  );
}

/**
 * Maps a DB content type onto the UI mediaType union used by renderers.
 */
export function contentTypeToMediaType(contentType: TelegramContentType): TelegramMessageMediaType {
  switch (contentType) {
    case "PHOTO":
      return "PHOTO";
    case "VIDEO":
    case "VIDEO_NOTE":
      return "VIDEO";
    case "VOICE":
      return "VOICE";
    case "AUDIO":
      return "AUDIO";
    case "DOCUMENT":
      return "DOCUMENT";
    case "ANIMATION":
      return "ANIMATION";
    case "STICKER":
      return "STICKER";
    case "CONTACT":
      return "CONTACT";
    case "LOCATION":
    case "LIVE_LOCATION":
      return "LOCATION";
    case "POLL":
      return "POLL";
    case "DICE":
      return "DICE";
    default:
      return "TEXT";
  }
}

export type TelegramMessageMediaType =
  | "TEXT"
  | "PHOTO"
  | "VIDEO"
  | "DOCUMENT"
  | "VOICE"
  | "LOCATION"
  | "AUDIO"
  | "CONTACT"
  | "STICKER"
  | "ANIMATION"
  | "POLL"
  | "DICE"
  | "VIDEO_NOTE";

/**
 * Builds chat-list / notification preview text for a message.
 * When a caption exists for media, returns e.g. "📷 Caption…".
 */
export function formatTelegramMediaPreview(
  contentType: TelegramContentType,
  options?: { readonly caption?: string | null; readonly text?: string | null; readonly diceEmoji?: string | null }
): string {
  if (contentType === "TEXT") {
    return (options?.text ?? "").trim() || "";
  }
  if (contentType === "DICE" && options?.diceEmoji) {
    return `🎲 ${options.diceEmoji}`;
  }
  const label = PREVIEW_LABELS[contentType] ?? PREVIEW_LABELS.OTHER;
  const caption = (options?.caption ?? options?.text ?? "").trim();
  if (caption && contentTypeNeedsBinaryDownload(contentType)) {
    const emoji = label.split(/\s+/)[0] ?? "";
    return `${emoji} ${caption}`.slice(0, 500);
  }
  if (caption && (contentType === "POLL" || contentType === "CONTACT")) {
    return `${label.split(/\s+/)[0] ?? ""} ${caption}`.trim().slice(0, 500);
  }
  return label;
}

/**
 * Extracts a safe emoji from dice metadata when present.
 */
export function readDiceEmoji(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const emoji = (metadata as { emoji?: unknown }).emoji;
  return typeof emoji === "string" && emoji.trim() ? emoji.trim() : null;
}
