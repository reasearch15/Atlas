import type { TelegramMessageDto, TelegramSendMediaInput } from "@atlas/shared";
import { api, apiBaseUrl } from "@/lib/api";
import { useAuthStore } from "@/stores/auth-store";

export type ComposerContentType = TelegramSendMediaInput["contentType"];

export interface ComposerUploadHandlers {
  readonly onProgress?: (ratio: number) => void;
  readonly onPhase?: (phase: "uploading" | "sending") => void;
  readonly onActivity?: (previewText: string, sentAt: string) => void;
  readonly xhrRef?: { current: XMLHttpRequest | null };
}

/**
 * True when a browser upload target would hit private MinIO (unreachable / insecure).
 */
export function isBlockedPrivateUploadUrl(url: string): boolean {
  return /127\.0\.0\.1|localhost|:9000|minio:|\/\/minio\b/i.test(url);
}

/**
 * Resolves the absolute same-origin (or public API) upload URL from a presign response.
 */
export function resolveComposerUploadUrl(uploadUrl: string): string {
  if (isBlockedPrivateUploadUrl(uploadUrl)) {
    throw new Error(
      "FAILED_UPLOAD: Upload target points at private storage. Refresh Atlas and retry."
    );
  }
  if (uploadUrl.startsWith("http://") || uploadUrl.startsWith("https://")) {
    if (isBlockedPrivateUploadUrl(uploadUrl)) {
      throw new Error("FAILED_UPLOAD: Upload target is not reachable from the browser.");
    }
    return uploadUrl;
  }
  const path = uploadUrl.startsWith("/") ? uploadUrl : `/${uploadUrl}`;
  return `${apiBaseUrl}${path}`;
}

/**
 * Presigns, uploads via the Atlas same-origin proxy, and sends a media blob.
 */
export async function uploadAndSendComposerMedia(
  chatId: string,
  file: Blob,
  input: {
    readonly contentType: ComposerContentType;
    readonly mimeType: string;
    readonly fileName: string;
    readonly forceDocument?: boolean;
    readonly voiceNote?: boolean;
    readonly videoNote?: boolean;
    readonly caption?: string;
    readonly width?: number;
    readonly height?: number;
    readonly durationSeconds?: number;
    readonly waveform?: number[];
    readonly previewLabel?: string;
  },
  handlers: ComposerUploadHandlers = {}
): Promise<TelegramMessageDto> {
  const idempotencyKey = `media:${chatId}:${crypto.randomUUID()}`;
  const mimeType = input.mimeType || "application/octet-stream";
  const fileName = input.fileName || "attachment";
  const fileSizeBytes = file.size;

  handlers.onPhase?.("uploading");
  let storageKey: string;
  try {
    const presign = await api.presignChatMedia(chatId, {
      contentType: input.contentType === "LOCATION" || input.contentType === "CONTACT" ? "DOCUMENT" : input.contentType,
      mimeType,
      fileName,
      fileSizeBytes,
      idempotencyKey
    });
    storageKey = presign.storageKey;
    const absoluteUploadUrl = resolveComposerUploadUrl(presign.uploadUrl);
    await putBlobWithProgress(absoluteUploadUrl, file, mimeType, handlers.onProgress, handlers.xhrRef);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    const message = error instanceof Error ? error.message : "Upload failed";
    if (message.startsWith("FAILED_UPLOAD:")) throw error;
    throw new Error(`FAILED_UPLOAD: ${message}`);
  }

  handlers.onPhase?.("sending");
  const body: TelegramSendMediaInput = {
    contentType: input.contentType,
    idempotencyKey,
    storageKey,
    mimeType,
    fileName,
    fileSizeBytes,
    forceDocument: Boolean(input.forceDocument),
    ...(input.voiceNote !== undefined ? { voiceNote: input.voiceNote } : {}),
    ...(input.videoNote !== undefined ? { videoNote: input.videoNote } : {}),
    ...(input.width ? { width: input.width } : {}),
    ...(input.height ? { height: input.height } : {}),
    ...(input.durationSeconds != null ? { durationSeconds: input.durationSeconds } : {}),
    ...(input.waveform?.length ? { waveform: input.waveform } : {}),
    ...(input.caption?.trim() ? { caption: input.caption.trim() } : {})
  };

  const previewText = input.caption?.trim() || input.previewLabel || fileName;
  const optimisticAt = new Date().toISOString();
  handlers.onActivity?.(previewText, optimisticAt);

  try {
    const pending = await api.sendChatMedia(chatId, body);
    handlers.onActivity?.(pending.caption || pending.text || previewText, pending.sentAt);
    return pending;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Send failed";
    throw new Error(`FAILED_SEND: ${message}`);
  }
}

function putBlobWithProgress(
  uploadUrl: string,
  file: Blob,
  mimeType: string,
  onProgress?: (ratio: number) => void,
  xhrRef?: { current: XMLHttpRequest | null }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (xhrRef) xhrRef.current = xhr;
    xhr.open("PUT", uploadUrl);
    xhr.setRequestHeader("Content-Type", mimeType);
    const token = useAuthStore.getState().accessToken;
    if (token) {
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    }
    xhr.withCredentials = true;
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhrRef) xhrRef.current = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        resolve();
        return;
      }
      let detail = `HTTP ${xhr.status}`;
      try {
        const parsed = JSON.parse(xhr.responseText) as { error?: { code?: string; message?: string } };
        if (parsed.error?.code) {
          detail = `${parsed.error.code}: ${parsed.error.message ?? detail}`;
        }
      } catch {
        // keep status detail
      }
      reject(new Error(detail));
    };
    xhr.onerror = () => {
      if (xhrRef) xhrRef.current = null;
      reject(new Error("Network error while uploading media"));
    };
    xhr.onabort = () => {
      if (xhrRef) xhrRef.current = null;
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    xhr.send(file);
  });
}

/**
 * User-facing composer error that distinguishes upload vs send failures.
 */
export function formatComposerMediaError(error: unknown, kind: "attachment" | "voice" | "camera" = "attachment"): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.startsWith("FAILED_UPLOAD:")) {
    return `Upload failed — ${raw.slice("FAILED_UPLOAD:".length).trim() || "could not store the file."}`;
  }
  if (raw.startsWith("FAILED_SEND:")) {
    return `Send failed — ${raw.slice("FAILED_SEND:".length).trim() || "Telegram could not accept the media."}`;
  }
  if (kind === "voice") return raw || "Failed to send voice message.";
  if (kind === "camera") return raw || "Failed to send camera capture.";
  return raw || "Failed to send attachment.";
}

/**
 * Infers send content type from a File/Blob for the attachment picker path.
 */
export function inferAttachmentContentType(
  file: File
): Exclude<ComposerContentType, "LOCATION" | "CONTACT"> {
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  if (type === "image/gif" || name.endsWith(".gif")) return "ANIMATION";
  if (type === "image/jpeg" || type === "image/jpg" || type === "image/png" || type === "image/webp") return "PHOTO";
  if (type.startsWith("image/")) return "PHOTO";
  if (type.startsWith("video/")) return "VIDEO";
  if (type.startsWith("audio/")) return "AUDIO";
  if (name.endsWith(".webp") || name.endsWith(".tgs")) return "STICKER";
  return "DOCUMENT";
}

export function mediaPreviewLabel(
  contentType: ComposerContentType,
  fileName: string
): string {
  switch (contentType) {
    case "PHOTO":
      return "📷 Photo";
    case "VIDEO":
      return "🎥 Video";
    case "AUDIO":
      return "🎵 Audio";
    case "VOICE":
      return "🎤 Voice Message";
    case "ANIMATION":
      return "🎞 GIF";
    case "STICKER":
      return "🖼 Sticker";
    default:
      return fileName ? `📄 ${fileName}` : "📄 Document";
  }
}

export function readImageDimensions(file: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Unable to read image dimensions"));
    };
    image.src = url;
  });
}

export function readVideoMetadata(file: Blob): Promise<{ width: number; height: number; durationSeconds: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const width = video.videoWidth || 0;
      const height = video.videoHeight || 0;
      const durationSeconds = Number.isFinite(video.duration) ? Math.max(1, Math.round(video.duration)) : 1;
      URL.revokeObjectURL(url);
      resolve({ width, height, durationSeconds });
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Unable to read video metadata"));
    };
    video.src = url;
  });
}
