import type { TelegramMessageDto, TelegramSendMediaInput } from "@atlas/shared";
import { api } from "@/lib/api";

export type ComposerContentType = TelegramSendMediaInput["contentType"];

export interface ComposerUploadHandlers {
  readonly onProgress?: (ratio: number) => void;
  readonly onPhase?: (phase: "uploading" | "sending") => void;
  readonly onActivity?: (previewText: string, sentAt: string) => void;
  readonly xhrRef?: { current: XMLHttpRequest | null };
}

/**
 * Presigns, uploads, and sends a media blob through the existing outbound pipeline.
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
  const presign = await api.presignChatMedia(chatId, {
    contentType: input.contentType === "LOCATION" || input.contentType === "CONTACT" ? "DOCUMENT" : input.contentType,
    mimeType,
    fileName,
    fileSizeBytes,
    idempotencyKey
  });

  await putBlobWithProgress(presign.uploadUrl, file, mimeType, handlers.onProgress, handlers.xhrRef);

  handlers.onPhase?.("sending");
  const body: TelegramSendMediaInput = {
    contentType: input.contentType,
    idempotencyKey,
    storageKey: presign.storageKey,
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

  const pending = await api.sendChatMedia(chatId, body);
  handlers.onActivity?.(pending.caption || pending.text || previewText, pending.sentAt);
  return pending;
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
      reject(new Error(`Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => {
      if (xhrRef) xhrRef.current = null;
      reject(new Error("Upload failed"));
    };
    xhr.onabort = () => {
      if (xhrRef) xhrRef.current = null;
      reject(new DOMException("Upload cancelled", "AbortError"));
    };
    xhr.send(file);
  });
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
