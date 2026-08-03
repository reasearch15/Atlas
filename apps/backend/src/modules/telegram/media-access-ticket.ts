import { createHmac, timingSafeEqual } from "node:crypto";

export type MediaAccessVariant = "media" | "thumbnail";

export interface MediaAccessTicketPayload {
  readonly messageId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly variant: MediaAccessVariant;
  readonly exp: number;
}

const DEFAULT_TTL_SECONDS = 3_600;

/**
 * Creates a short-lived HMAC media access ticket for browser media element requests.
 */
export function signMediaAccessTicket(
  secret: string,
  input: Omit<MediaAccessTicketPayload, "exp"> & { readonly ttlSeconds?: number }
): string {
  const exp = Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const payload: MediaAccessTicketPayload = {
    messageId: input.messageId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    variant: input.variant,
    exp
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/**
 * Verifies a media access ticket. Returns null when invalid or expired.
 */
export function verifyMediaAccessTicket(secret: string, token: string | null | undefined): MediaAccessTicketPayload | null {
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
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as MediaAccessTicketPayload;
    if (!payload.messageId || !payload.workspaceId || !payload.userId || !payload.variant || !payload.exp) {
      return null;
    }
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    if (payload.variant !== "media" && payload.variant !== "thumbnail") {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Appends an access ticket query param to an Atlas media path.
 */
export function withMediaAccessTicket(path: string, ticket: string): string {
  const join = path.includes("?") ? "&" : "?";
  return `${path}${join}access=${encodeURIComponent(ticket)}`;
}
