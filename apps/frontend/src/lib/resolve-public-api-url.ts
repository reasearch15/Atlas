/**
 * Resolves the browser-facing Atlas API origin from NEXT_PUBLIC_API_URL.
 *
 * Next.js inlines direct `process.env.NEXT_PUBLIC_*` member access into client chunks.
 * Do not embed a localhost development URL string in this module — development defaults
 * are applied in `next.config.ts` before compilation.
 *
 * This module has no side effects so `next.config.ts` can import `resolvePublicApiUrl`
 * without requiring env at config-load time for unrelated exports.
 */
export function resolvePublicApiUrl(options?: {
  readonly nextPublicApiUrl?: string | undefined;
  readonly nodeEnv?: string | undefined;
  /** When true, treat provided option values as authoritative even if undefined. */
  readonly explicit?: boolean;
}): string {
  const raw = (
    options?.explicit ? options.nextPublicApiUrl : (options?.nextPublicApiUrl ?? process.env.NEXT_PUBLIC_API_URL)
  )?.trim();
  const nodeEnv = options?.explicit ? options.nodeEnv : (options?.nodeEnv ?? process.env.NODE_ENV);

  if (!raw) {
    throw new Error(
      "Missing required environment variable: NEXT_PUBLIC_API_URL. " +
        "Set it in the monorepo root .env before building or starting the frontend."
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Invalid NEXT_PUBLIC_API_URL: must be a valid URL");
  }

  if (nodeEnv === "production") {
    if (parsed.protocol !== "https:") {
      throw new Error("Invalid NEXT_PUBLIC_API_URL: must use https in production");
    }
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      throw new Error("Invalid NEXT_PUBLIC_API_URL: must not point to localhost in production");
    }
  }

  return raw.replace(/\/$/, "");
}
