/** Telegram photo upload soft limit used before falling back to document mode. */
export const TELEGRAM_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

const PHOTO_MIME_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

/**
 * Returns whether a MIME type is a normal photo candidate (not GIF).
 */
export function isPhotoMimeType(mimeType: string | null | undefined): boolean {
  if (!mimeType) return false;
  return PHOTO_MIME_TYPES.has(mimeType.toLowerCase().trim());
}

/**
 * Returns whether a MIME/file looks like a GIF animation candidate.
 */
export function isGifMimeType(mimeType: string | null | undefined, fileName?: string | null): boolean {
  const mime = (mimeType ?? "").toLowerCase();
  const name = (fileName ?? "").toLowerCase();
  return mime === "image/gif" || name.endsWith(".gif");
}

/**
 * Chooses GramJS sendFile mode for an outgoing attachment.
 */
export function resolveOutgoingMediaSendMode(input: {
  readonly contentType: string;
  readonly mimeType?: string | null;
  readonly fileName?: string | null;
  readonly fileSizeBytes?: number | null;
  readonly forceDocument?: boolean | null;
}): {
  readonly forceDocument: boolean;
  readonly asPhoto: boolean;
  readonly asAnimation: boolean;
  readonly reason: string;
} {
  if (input.forceDocument) {
    return { forceDocument: true, asPhoto: false, asAnimation: false, reason: "user_force_document" };
  }
  if (input.contentType === "DOCUMENT") {
    return { forceDocument: true, asPhoto: false, asAnimation: false, reason: "content_type_document" };
  }

  const size = input.fileSizeBytes ?? 0;
  if (input.contentType === "PHOTO" || isPhotoMimeType(input.mimeType)) {
    if (size > TELEGRAM_PHOTO_MAX_BYTES) {
      return { forceDocument: true, asPhoto: false, asAnimation: false, reason: "photo_too_large" };
    }
    return { forceDocument: false, asPhoto: true, asAnimation: false, reason: "photo" };
  }

  if (input.contentType === "ANIMATION" || isGifMimeType(input.mimeType, input.fileName)) {
    return { forceDocument: false, asPhoto: false, asAnimation: true, reason: "animation_gif" };
  }

  if (input.contentType === "VOICE") {
    return { forceDocument: false, asPhoto: false, asAnimation: false, reason: "voice_note" };
  }

  if (input.contentType === "VIDEO" || input.contentType === "VIDEO_NOTE") {
    return { forceDocument: false, asPhoto: false, asAnimation: false, reason: "video" };
  }

  if (input.contentType === "AUDIO") {
    return { forceDocument: false, asPhoto: false, asAnimation: false, reason: "audio" };
  }

  return {
    forceDocument: input.contentType === "DOCUMENT",
    asPhoto: false,
    asAnimation: false,
    reason: "default"
  };
}

/**
 * Builds a filename GramJS will classify as an image (extension-based isImage check).
 * WebP is given a .jpg name so GramJS uses InputMediaUploadedPhoto; Telegram re-encodes.
 */
export function resolveGramJsUploadFileName(input: {
  readonly fileName?: string | null;
  readonly mimeType?: string | null;
  readonly asPhoto?: boolean;
  readonly asAnimation?: boolean;
  readonly forceDocument?: boolean;
}): string {
  const original = (input.fileName ?? "").trim() || "attachment";
  const mime = (input.mimeType ?? "").toLowerCase();

  if (input.forceDocument) {
    return original.includes(".") ? original : `${original}.bin`;
  }

  if (input.asAnimation || isGifMimeType(mime, original)) {
    return original.toLowerCase().endsWith(".gif") ? original : `${stripExtension(original)}.gif`;
  }

  if (input.asPhoto || isPhotoMimeType(mime)) {
    if (mime.includes("png") || original.toLowerCase().endsWith(".png")) {
      return original.toLowerCase().endsWith(".png") ? original : `${stripExtension(original)}.png`;
    }
    // jpeg / webp / generic photo → .jpg so GramJS isImage() is true
    if (original.toLowerCase().endsWith(".jpg") || original.toLowerCase().endsWith(".jpeg")) {
      return original;
    }
    return `${stripExtension(original)}.jpg`;
  }

  if (mime.includes("ogg") || mime.includes("opus") || original.toLowerCase().endsWith(".ogg") || original.toLowerCase().endsWith(".oga")) {
    return original.toLowerCase().endsWith(".ogg") || original.toLowerCase().endsWith(".oga")
      ? original
      : `${stripExtension(original)}.ogg`;
  }

  if (mime.includes("webm") || original.toLowerCase().endsWith(".webm")) {
    return original.toLowerCase().endsWith(".webm") ? original : `${stripExtension(original)}.webm`;
  }

  if (mime.includes("mp4") || original.toLowerCase().endsWith(".mp4")) {
    return original.toLowerCase().endsWith(".mp4") ? original : `${stripExtension(original)}.mp4`;
  }

  return original.includes(".") ? original : `${original}.bin`;
}

function stripExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return name || "file";
  return name.slice(0, idx) || "file";
}
