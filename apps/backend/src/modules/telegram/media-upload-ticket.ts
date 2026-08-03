import { createHmac, timingSafeEqual } from "node:crypto";

export interface MediaUploadTicketPayload {
  readonly chatId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly fileSizeBytes: number;
  readonly exp: number;
}

const DEFAULT_TTL_SECONDS = 900;

/**
 * Creates a short-lived HMAC ticket binding an outbound media upload to a server-generated key.
 */
export function signMediaUploadTicket(
  secret: string,
  input: Omit<MediaUploadTicketPayload, "exp"> & { readonly ttlSeconds?: number }
): string {
  const exp = Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const payload: MediaUploadTicketPayload = {
    chatId: input.chatId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    storageKey: input.storageKey,
    mimeType: input.mimeType,
    fileName: input.fileName,
    contentType: input.contentType,
    fileSizeBytes: input.fileSizeBytes,
    exp
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/**
 * Verifies an outbound media upload ticket. Returns null when invalid or expired.
 */
export function verifyMediaUploadTicket(secret: string, token: string | null | undefined): MediaUploadTicketPayload | null {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as MediaUploadTicketPayload;
    if (
      !payload.chatId ||
      !payload.workspaceId ||
      !payload.userId ||
      !payload.storageKey ||
      !payload.mimeType ||
      !payload.fileName ||
      !payload.contentType ||
      !payload.fileSizeBytes ||
      !payload.exp
    ) {
      return null;
    }
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    if (payload.storageKey.includes("..") || !payload.storageKey.startsWith(`workspaces/${payload.workspaceId}/`)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * True when a URL would expose the private MinIO endpoint to browsers.
 */
export function isPrivateMinioBrowserUrl(url: string): boolean {
  return /127\.0\.0\.1|localhost|:9000|minio:|\/\/minio\b/i.test(url);
}
