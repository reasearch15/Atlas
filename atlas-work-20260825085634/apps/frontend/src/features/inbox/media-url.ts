"use client";

import { useEffect, useState } from "react";
import { isAtlasMediaProxyPath, isPrivateStorageMediaUrl } from "@atlas/shared";
import { api, apiBaseUrl } from "@/lib/api";

const ticketCache = new Map<string, { url: string; expiresAt: number }>();

/**
 * Resolves a playable browser media URL.
 * - Rejects private MinIO / localhost signed URLs
 * - Mints short-lived access tickets for Atlas proxy paths (needed by <img>/<video>/<audio>)
 * - Prefixes relative /api paths with the public API origin when needed
 */
export async function resolvePlayableMediaUrl(
  source: string | null | undefined,
  variant: "media" | "thumbnail" = "media"
): Promise<string | null> {
  if (!source) return null;
  if (isPrivateStorageMediaUrl(source)) return null;

  let path = source;
  if (path.startsWith("http://") || path.startsWith("https://")) {
    try {
      const parsed = new URL(path);
      path = `${parsed.pathname}${parsed.search}`;
    } catch {
      return null;
    }
  }

  if (!isAtlasMediaProxyPath(path.split("?")[0] ?? path)) {
    // Non-proxy absolute URLs that aren't private storage (legacy) — block if private markers slipped through.
    if (source.startsWith("http")) return isPrivateStorageMediaUrl(source) ? null : source;
    return null;
  }

  if (path.includes("access=")) {
    return path.startsWith("/") ? `${apiBaseUrl}${path}` : path;
  }

  const messageId = extractMessageId(path);
  if (!messageId) return null;

  const cacheKey = `${messageId}:${variant}`;
  const cached = ticketCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) {
    return cached.url.startsWith("/") ? `${apiBaseUrl}${cached.url}` : cached.url;
  }

  const minted = await api.telegramMediaAccess(messageId, variant);
  ticketCache.set(cacheKey, { url: minted.url, expiresAt: Date.now() + 50 * 60_000 });
  return minted.url.startsWith("/") ? `${apiBaseUrl}${minted.url}` : minted.url;
}

/**
 * React hook that resolves an authenticated playable media URL.
 */
export function usePlayableMediaUrl(
  source: string | null | undefined,
  variant: "media" | "thumbnail" = "media"
): { readonly url: string | null; readonly loading: boolean; readonly error: boolean } {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(source));
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!source) {
      setUrl(null);
      setLoading(false);
      setError(false);
      return;
    }
    setLoading(true);
    setError(false);
    void resolvePlayableMediaUrl(source, variant)
      .then((resolved) => {
        if (cancelled) return;
        setUrl(resolved);
        setError(!resolved);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setUrl(null);
        setError(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, variant]);

  return { url, loading, error };
}

function extractMessageId(path: string): string | null {
  const match = path.match(/^\/api\/telegram\/messages\/([^/]+)\/(media|thumbnail)/);
  return match?.[1] ?? null;
}
