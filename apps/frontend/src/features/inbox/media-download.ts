"use client";

/**
 * Triggers a browser file download for an authenticated Atlas media URL.
 * Prefers a blob download so the filename is honored; falls back to attachment navigation.
 */
export async function downloadMediaFile(url: string, fileName: string): Promise<void> {
  const downloadUrl = withDownloadQuery(url);
  const safeName = sanitizeDownloadFileName(fileName);

  try {
    const response = await fetch(downloadUrl, { credentials: "include", mode: "cors" });
    if (!response.ok) {
      throw new Error(`MEDIA_DOWNLOAD_FAILED:${response.status}`);
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = safeName;
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
    return;
  } catch {
    // Cross-origin or network failure: Content-Disposition: attachment still saves via navigation.
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = safeName;
    anchor.rel = "noopener";
    anchor.target = "_blank";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }
}

/**
 * Appends download=1 so the media proxy returns Content-Disposition: attachment.
 */
export function withDownloadQuery(url: string): string {
  try {
    const parsed = new URL(url, typeof window !== "undefined" ? window.location.origin : "http://localhost");
    parsed.searchParams.set("download", "1");
    return parsed.toString();
  } catch {
    const joiner = url.includes("?") ? "&" : "?";
    return `${url}${joiner}download=1`;
  }
}

/**
 * Resolves a friendly download filename for inbox media (especially photos).
 */
export function resolveInboxMediaFileName(input: {
  readonly fileName?: string | null;
  readonly contentType?: string | null;
  readonly mimeType?: string | null;
  readonly mediaType?: string | null;
}): string {
  const existing = typeof input.fileName === "string" ? input.fileName.trim() : "";
  if (existing) return sanitizeDownloadFileName(existing);

  const kind = String(input.mediaType || input.contentType || "").toUpperCase();
  const mime = (input.mimeType ?? "").toLowerCase();
  if (kind === "PHOTO" || mime.startsWith("image/")) {
    if (mime.includes("png")) return "photo.png";
    if (mime.includes("webp")) return "photo.webp";
    if (mime.includes("gif")) return "photo.gif";
    return "photo.jpg";
  }
  if (kind === "VIDEO" || kind === "VIDEO_NOTE") return "video.mp4";
  if (kind === "VOICE" || kind === "AUDIO") return "audio.ogg";
  if (kind === "ANIMATION") return "animation.mp4";
  if (kind === "DOCUMENT") return "document.bin";
  return "file.bin";
}

function sanitizeDownloadFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return cleaned.slice(0, 180) || "file.bin";
}
