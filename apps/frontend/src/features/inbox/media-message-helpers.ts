import type { TelegramMessageDto } from "@atlas/shared";

/**
 * Returns whether media bytes are still loading from Telegram/storage.
 */
export function isMediaLoading(message: Pick<TelegramMessageDto, "mediaDownloadState">): boolean {
  return message.mediaDownloadState === "PENDING" || message.mediaDownloadState === "DOWNLOADING";
}

/**
 * Reads lat/long from media metadata for location messages.
 */
export function readLocationCoords(
  metadata: Record<string, unknown> | null | undefined
): { readonly lat: number; readonly long: number } | null {
  if (!metadata) return null;
  const lat = toFiniteNumber(metadata.lat ?? metadata.latitude);
  const long = toFiniteNumber(metadata.long ?? metadata.longitude ?? metadata.lng);
  if (lat == null || long == null) return null;
  return { lat, long };
}

/**
 * Reads contact fields from media metadata.
 */
export function readContactMeta(metadata: Record<string, unknown> | null | undefined): {
  readonly name: string;
  readonly phone: string | null;
} {
  if (!metadata) return { name: "Contact", phone: null };
  const first = typeof metadata.firstName === "string" ? metadata.firstName.trim() : "";
  const last = typeof metadata.lastName === "string" ? metadata.lastName.trim() : "";
  const name =
    [first, last].filter(Boolean).join(" ") ||
    (typeof metadata.name === "string" ? metadata.name.trim() : "") ||
    "Contact";
  const phone =
    typeof metadata.phoneNumber === "string"
      ? metadata.phoneNumber
      : typeof metadata.phone === "string"
        ? metadata.phone
        : null;
  return { name, phone };
}

/**
 * Reads poll question/options from media metadata.
 */
export function readPollMeta(metadata: Record<string, unknown> | null | undefined): {
  readonly question: string;
  readonly options: string[];
} {
  if (!metadata) return { question: "Poll", options: [] };
  const question =
    typeof metadata.question === "string" && metadata.question.trim()
      ? metadata.question.trim()
      : "Poll";
  const rawOptions = metadata.options;
  const options: string[] = [];
  if (Array.isArray(rawOptions)) {
    for (const option of rawOptions) {
      if (typeof option === "string" && option.trim()) {
        options.push(option.trim());
      } else if (option && typeof option === "object" && typeof (option as { text?: unknown }).text === "string") {
        const text = (option as { text: string }).text.trim();
        if (text) options.push(text);
      }
    }
  }
  return { question, options };
}

/**
 * Reads dice emoji from media metadata.
 */
export function readDiceMeta(metadata: Record<string, unknown> | null | undefined): string {
  if (!metadata) return "🎲";
  if (typeof metadata.emoji === "string" && metadata.emoji.trim()) return metadata.emoji.trim();
  if (typeof metadata.diceEmoji === "string" && metadata.diceEmoji.trim()) return metadata.diceEmoji.trim();
  return "🎲";
}

/**
 * Reads audio title/performer from media metadata.
 */
export function readAudioMeta(metadata: Record<string, unknown> | null | undefined): {
  readonly title: string | null;
  readonly performer: string | null;
} {
  if (!metadata) return { title: null, performer: null };
  return {
    title: typeof metadata.title === "string" && metadata.title.trim() ? metadata.title.trim() : null,
    performer:
      typeof metadata.performer === "string" && metadata.performer.trim()
        ? metadata.performer.trim()
        : typeof metadata.artist === "string" && metadata.artist.trim()
          ? metadata.artist.trim()
          : null
  };
}

/**
 * Formats a byte size for document labels.
 */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Formats a duration in seconds as m:ss.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "";
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Builds waveform bar heights (0–1) from Telegram waveform samples.
 */
export function normalizeWaveform(waveform: number[] | null | undefined, barCount = 32): number[] {
  if (!waveform || waveform.length === 0) {
    return Array.from({ length: barCount }, (_, index) => 0.25 + ((index % 5) / 10));
  }
  const bars: number[] = [];
  for (let index = 0; index < barCount; index += 1) {
    const start = Math.floor((index / barCount) * waveform.length);
    const end = Math.max(start + 1, Math.floor(((index + 1) / barCount) * waveform.length));
    let max = 0;
    for (let i = start; i < end; i += 1) {
      max = Math.max(max, waveform[i] ?? 0);
    }
    bars.push(Math.min(1, Math.max(0.08, max / 31)));
  }
  return bars;
}

/**
 * Aspect-ratio CSS value from message dimensions.
 */
export function aspectRatioStyle(width: number | null, height: number | null): string | undefined {
  if (width && height && width > 0 && height > 0) {
    return `${width} / ${height}`;
  }
  return undefined;
}

/**
 * Default empty media fields for TelegramMessageDto test fixtures.
 */
export function emptyMediaFields(): Pick<
  TelegramMessageDto,
  | "caption"
  | "mimeType"
  | "fileName"
  | "fileSizeBytes"
  | "width"
  | "height"
  | "durationSeconds"
  | "waveform"
  | "mediaMetadata"
  | "mediaUrl"
  | "thumbnailUrl"
  | "mediaDownloadState"
  | "mediaUploadState"
  | "mediaError"
  | "replyPreview"
  | "webPreview"
> {
  return {
    caption: null,
    mimeType: null,
    fileName: null,
    fileSizeBytes: null,
    width: null,
    height: null,
    durationSeconds: null,
    waveform: null,
    mediaMetadata: null,
    mediaUrl: null,
    thumbnailUrl: null,
    mediaDownloadState: "NONE",
    mediaUploadState: "NONE",
    mediaError: null,
    replyPreview: null,
    webPreview: null
  };
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
