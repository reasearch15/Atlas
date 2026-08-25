/**
 * Same-origin Atlas media proxy paths for Telegram message binaries.
 * Never points at private MinIO / S3 endpoints.
 */

export type TelegramMediaVariant = "media" | "thumbnail";

/**
 * Builds a relative API path for authenticated media streaming.
 */
export function buildTelegramMessageMediaPath(
  messageId: string,
  variant: TelegramMediaVariant = "media"
): string {
  const id = messageId.trim();
  if (!id) return "";
  if (variant === "thumbnail") {
    return `/api/telegram/messages/${id}/thumbnail`;
  }
  return `/api/telegram/messages/${id}/media`;
}

/**
 * Returns true when a URL is a private MinIO / localhost storage endpoint (must never reach browsers).
 */
export function isPrivateStorageMediaUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const value = url.trim().toLowerCase();
  if (!value) return false;
  if (value.includes("127.0.0.1")) return true;
  if (value.includes("localhost")) return true;
  if (/:\s*9000\b/.test(value) || value.includes(":9000")) return true;
  if (value.includes("x-amz-signature") || value.includes("x-amz-credential")) return true;
  return false;
}

/**
 * Returns true when the URL is an Atlas media proxy path (relative or absolute).
 */
export function isAtlasMediaProxyPath(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const path = url.startsWith("http://") || url.startsWith("https://") ? new URL(url).pathname : url.split("?")[0] ?? "";
    return /^\/api\/telegram\/messages\/[^/]+\/(media|thumbnail)$/.test(path);
  } catch {
    return false;
  }
}
