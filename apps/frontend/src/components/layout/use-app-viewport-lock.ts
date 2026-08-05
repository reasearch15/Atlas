"use client";

import { useEffect } from "react";

const LOCK_CLASS = "app-viewport-lock";

/**
 * Locks html/body as a fixed viewport while a messaging app shell is mounted.
 * Prevents the document from becoming a competing scroll root on mobile
 * (header/composer must stay pinned; only inner lists scroll).
 */
export function useAppViewportLock(): void {
  useEffect(() => {
    const html = document.documentElement;
    const { body } = document;
    html.classList.add(LOCK_CLASS);
    return () => {
      html.classList.remove(LOCK_CLASS);
    };
  }, []);
}
