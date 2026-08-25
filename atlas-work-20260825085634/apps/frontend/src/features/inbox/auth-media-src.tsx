"use client";

import type { ReactNode } from "react";
import { usePlayableMediaUrl } from "./media-url";

/**
 * Resolves an Atlas media proxy URL (with access ticket) before rendering children.
 */
export function AuthMediaSrc({
  source,
  variant = "media",
  loadingFallback,
  errorFallback,
  children
}: {
  readonly source: string | null | undefined;
  readonly variant?: "media" | "thumbnail";
  readonly loadingFallback?: ReactNode;
  readonly errorFallback?: ReactNode;
  readonly children: (url: string) => ReactNode;
}) {
  const { url, loading, error } = usePlayableMediaUrl(source, variant);
  if (loading) return <>{loadingFallback ?? <span className="text-xs text-muted-foreground">Loading media…</span>}</>;
  if (error || !url) return <>{errorFallback ?? <span className="text-xs text-muted-foreground">Media unavailable</span>}</>;
  return <>{children(url)}</>;
}
