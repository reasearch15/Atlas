import {
  contentTypeNeedsBinaryDownload,
  formatTelegramMediaPreview,
  type TelegramContentType
} from "@atlas/shared";

export interface NormalizedMediaFields {
  readonly contentType: TelegramContentType;
  readonly text: string;
  readonly caption: string | null;
  readonly mimeType: string | null;
  readonly fileName: string | null;
  readonly fileSizeBytes: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationSeconds: number | null;
  readonly waveform: number[] | null;
  readonly mediaMetadata: Record<string, unknown>;
  readonly needsBinaryDownload: boolean;
  readonly previewText: string;
}

/**
 * Normalizes GramJS message media into JSON-safe metadata (no binary, no circular refs).
 */
export function normalizeGramJsMedia(message: unknown): NormalizedMediaFields {
  const value = message as Record<string, unknown>;
  const bodyText = typeof value.message === "string" ? value.message : "";
  const media = (value.media ?? null) as Record<string, unknown> | null;
  if (!media) {
    const webPreview = extractWebPreview(value);
    return {
      contentType: "TEXT",
      text: bodyText,
      caption: null,
      mimeType: null,
      fileName: null,
      fileSizeBytes: null,
      width: null,
      height: null,
      durationSeconds: null,
      waveform: null,
      mediaMetadata: webPreview ? { webPreview } : {},
      needsBinaryDownload: false,
      previewText: bodyText.slice(0, 500)
    };
  }

  const className = String(media.className ?? media._ ?? "");
  if (className.includes("MessageMediaPhoto")) {
    const photo = (media.photo ?? null) as Record<string, unknown> | null;
    const sizes = Array.isArray(photo?.sizes) ? (photo!.sizes as Record<string, unknown>[]) : [];
    const largest = pickLargestPhotoSize(sizes);
    const fields = baseFields("PHOTO", bodyText, {
      mimeType: "image/jpeg",
      width: asInt(largest?.w),
      height: asInt(largest?.h),
      fileSizeBytes: asInt(largest?.size),
      mediaMetadata: { photoId: photo?.id ? String(photo.id) : null, hasSpoiler: Boolean(media.spoiler) }
    });
    return fields;
  }

  if (className.includes("MessageMediaDocument")) {
    return normalizeDocumentMedia(media, bodyText);
  }

  if (className.includes("MessageMediaContact")) {
    const firstName = asString(media.firstName) ?? "";
    const lastName = asString(media.lastName) ?? "";
    const phone = asString(media.phoneNumber) ?? "";
    const display = [firstName, lastName].filter(Boolean).join(" ").trim() || phone || "Contact";
    return baseFields("CONTACT", display, {
      caption: null,
      mediaMetadata: {
        phoneNumber: phone || null,
        firstName: firstName || null,
        lastName: lastName || null,
        userId: media.userId ? String(media.userId) : null,
        vcard: asString(media.vcard)
      }
    });
  }

  if (className.includes("MessageMediaGeoLive")) {
    const geo = (media.geo ?? null) as Record<string, unknown> | null;
    return baseFields("LIVE_LOCATION", bodyText || "📍 Location", {
      mediaMetadata: {
        lat: asNumber(geo?.lat),
        long: asNumber(geo?.long),
        accuracyRadius: asNumber(media.accuracyRadius),
        period: asInt(media.period),
        live: true
      }
    });
  }

  if (className.includes("MessageMediaGeo") || className.includes("MessageMediaVenue")) {
    const geo = (media.geo ?? null) as Record<string, unknown> | null;
    return baseFields("LOCATION", bodyText || "📍 Location", {
      mediaMetadata: {
        lat: asNumber(geo?.lat),
        long: asNumber(geo?.long),
        title: asString(media.title),
        address: asString(media.address),
        venueId: asString(media.venueId),
        provider: asString(media.provider)
      }
    });
  }

  if (className.includes("MessageMediaPoll")) {
    const poll = (media.poll ?? null) as Record<string, unknown> | null;
    const question = extractPollQuestion(poll);
    const answers = Array.isArray(poll?.answers)
      ? (poll!.answers as Record<string, unknown>[]).map((answer) => ({
          text: extractText(answer.text) ?? "",
          option: typeof answer.option === "string" ? answer.option : null
        }))
      : [];
    return baseFields("POLL", question || "📊 Poll", {
      mediaMetadata: {
        question,
        answers,
        closed: Boolean(poll?.closed),
        quiz: Boolean(poll?.quiz),
        multipleChoice: Boolean(poll?.multipleChoice)
      }
    });
  }

  if (className.includes("MessageMediaDice")) {
    const emoji = asString(media.emoticon) ?? "🎲";
    const valueNum = asInt(media.value);
    return baseFields("DICE", emoji, {
      mediaMetadata: { emoji, value: valueNum }
    });
  }

  if (className.includes("MessageMediaWebPage")) {
    const webpage = (media.webpage ?? null) as Record<string, unknown> | null;
    const url = asString(webpage?.url) ?? asString(webpage?.displayUrl);
    return {
      contentType: "TEXT",
      text: bodyText,
      caption: null,
      mimeType: null,
      fileName: null,
      fileSizeBytes: null,
      width: null,
      height: null,
      durationSeconds: null,
      waveform: null,
      mediaMetadata: {
        webPreview: {
          url: url ?? "",
          title: asString(webpage?.title),
          description: asString(webpage?.description),
          siteName: asString(webpage?.siteName)
        }
      },
      needsBinaryDownload: false,
      previewText: bodyText.slice(0, 500)
    };
  }

  return baseFields("OTHER", bodyText || "📎 Attachment", {
    mediaMetadata: { className }
  });
}

function normalizeDocumentMedia(media: Record<string, unknown>, bodyText: string): NormalizedMediaFields {
  const document = (media.document ?? null) as Record<string, unknown> | null;
  const attrs = Array.isArray(document?.attributes) ? (document!.attributes as Record<string, unknown>[]) : [];
  const mimeType = asString(document?.mimeType);
  const fileName =
    asString(attrs.find((attr) => String(attr.className ?? attr._ ?? "").includes("Filename"))?.fileName) ?? null;
  const fileSizeBytes = asInt(document?.size);
  const videoAttr = attrs.find((attr) => String(attr.className ?? attr._ ?? "").includes("Video"));
  const audioAttr = attrs.find((attr) => String(attr.className ?? attr._ ?? "").includes("Audio"));
  const stickerAttr = attrs.find((attr) => String(attr.className ?? attr._ ?? "").includes("Sticker"));
  const animated = Boolean(attrs.find((attr) => String(attr.className ?? attr._ ?? "").includes("Animated")));
  const roundMessage = Boolean(videoAttr && videoAttr.roundMessage);

  let contentType: TelegramContentType = "DOCUMENT";
  if (stickerAttr) {
    contentType = "STICKER";
  } else if (mimeType === "image/gif" || (mimeType === "video/mp4" && animated && !videoAttr)) {
    contentType = "ANIMATION";
  } else if (videoAttr && roundMessage) {
    contentType = "VIDEO_NOTE";
  } else if (videoAttr || (mimeType?.startsWith("video/") ?? false)) {
    contentType = animated ? "ANIMATION" : "VIDEO";
  } else if (audioAttr && Boolean(audioAttr.voice)) {
    contentType = "VOICE";
  } else if (audioAttr || (mimeType?.startsWith("audio/") ?? false)) {
    contentType = "AUDIO";
  }

  const durationSeconds = asInt(videoAttr?.duration ?? audioAttr?.duration);
  const width = asInt(videoAttr?.w);
  const height = asInt(videoAttr?.h);
  const waveform = normalizeWaveform(audioAttr?.waveform);
  const metadata: Record<string, unknown> = {
    documentId: document?.id ? String(document.id) : null,
    accessHash: document?.accessHash ? String(document.accessHash) : null,
    mimeType,
    fileName,
    animated,
    roundMessage,
    performer: asString(audioAttr?.performer),
    title: asString(audioAttr?.title),
    stickerSet: stickerAttr?.stickerset ? { present: true } : null,
    alt: asString(stickerAttr?.alt)
  };

  return baseFields(contentType, bodyText, {
    mimeType,
    fileName,
    fileSizeBytes,
    width,
    height,
    durationSeconds,
    waveform,
    mediaMetadata: metadata
  });
}

function baseFields(
  contentType: TelegramContentType,
  bodyText: string,
  partial: {
    readonly caption?: string | null;
    readonly mimeType?: string | null;
    readonly fileName?: string | null;
    readonly fileSizeBytes?: number | null;
    readonly width?: number | null;
    readonly height?: number | null;
    readonly durationSeconds?: number | null;
    readonly waveform?: number[] | null;
    readonly mediaMetadata?: Record<string, unknown>;
  }
): NormalizedMediaFields {
  const caption = partial.caption === undefined ? (bodyText.trim() ? bodyText : null) : partial.caption;
  const textForStorage =
    contentType === "TEXT"
      ? bodyText
      : formatTelegramMediaPreview(contentType, {
          caption,
          text: bodyText,
          diceEmoji: typeof partial.mediaMetadata?.emoji === "string" ? partial.mediaMetadata.emoji : null
        });
  return {
    contentType,
    text: textForStorage,
    caption: contentType === "TEXT" ? null : caption,
    mimeType: partial.mimeType ?? null,
    fileName: partial.fileName ?? null,
    fileSizeBytes: partial.fileSizeBytes ?? null,
    width: partial.width ?? null,
    height: partial.height ?? null,
    durationSeconds: partial.durationSeconds ?? null,
    waveform: partial.waveform ?? null,
    mediaMetadata: partial.mediaMetadata ?? {},
    needsBinaryDownload: contentTypeNeedsBinaryDownload(contentType),
    previewText: textForStorage.slice(0, 500)
  };
}

function pickLargestPhotoSize(sizes: readonly Record<string, unknown>[]): Record<string, unknown> | null {
  let best: Record<string, unknown> | null = null;
  let bestArea = -1;
  for (const size of sizes) {
    const w = asInt(size.w) ?? 0;
    const h = asInt(size.h) ?? 0;
    const area = w * h;
    if (area >= bestArea) {
      best = size;
      bestArea = area;
    }
  }
  return best;
}

function extractWebPreview(message: Record<string, unknown>): Record<string, unknown> | null {
  const media = (message.media ?? null) as Record<string, unknown> | null;
  if (media && String(media.className ?? media._ ?? "").includes("WebPage")) {
    const webpage = (media.webpage ?? null) as Record<string, unknown> | null;
    return {
      url: asString(webpage?.url) ?? "",
      title: asString(webpage?.title),
      description: asString(webpage?.description)
    };
  }
  return null;
}

function extractPollQuestion(poll: Record<string, unknown> | null): string {
  if (!poll) return "";
  return extractText(poll.question) ?? asString(poll.question) ?? "";
}

function extractText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const text = (value as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return null;
}

function normalizeWaveform(raw: unknown): number[] | null {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    return raw.map((item) => Number(item)).filter((item) => Number.isFinite(item)).slice(0, 128);
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(raw)) {
    return Array.from(raw.values()).slice(0, 128);
  }
  if (raw instanceof Uint8Array) {
    return Array.from(raw.values()).slice(0, 128);
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asInt(value: unknown): number | null {
  const num = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isFinite(num) ? Math.trunc(num) : null;
}

function asNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}
