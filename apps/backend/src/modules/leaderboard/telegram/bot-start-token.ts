import { createHmac, timingSafeEqual } from "node:crypto";

export interface BotStartTokenPayload {
  readonly v: 1;
  readonly w: string;
  readonly o: string;
  readonly exp: number;
}

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Signs an optional /start deep-link payload (workspace + owner).
 * Bare /start without payload also works — bot identity implies owner.
 */
export function signBotStartToken(
  secret: string,
  input: { readonly workspaceId: string; readonly ownerCoadminUserId: string; readonly ttlSeconds?: number }
): string {
  const exp = Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS);
  const payload: BotStartTokenPayload = {
    v: 1,
    w: input.workspaceId,
    o: input.ownerCoadminUserId,
    exp
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/**
 * Verifies a signed /start payload. Returns null when invalid/expired.
 * Also accepts bare "rank" as a non-signed deep-link hint (no ownership claim).
 */
export function verifyBotStartToken(
  secret: string,
  token: string | null | undefined
): BotStartTokenPayload | null {
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
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as BotStartTokenPayload;
    if (payload.v !== 1 || !payload.w || !payload.o || !payload.exp) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
