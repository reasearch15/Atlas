"use client";

import type { QueryClient } from "@tanstack/react-query";

let queryClientRef: QueryClient | null = null;

/**
 * Binds the app QueryClient so logout / role-switch can wipe role-sensitive caches.
 */
export function bindSensitiveQueryClient(client: QueryClient): void {
  queryClientRef = client;
}

/**
 * Clears React Query caches that may hold Coadmin-only customer identifiers.
 * Call on logout and whenever the authenticated role changes.
 */
export function clearRoleSensitiveClientCaches(): void {
  queryClientRef?.clear();
  if (typeof window !== "undefined") {
    try {
      // Never persist customer contact payloads.
      for (const key of Object.keys(window.sessionStorage)) {
        if (key.startsWith("atlas:contact:") || key.startsWith("atlas:chat:") || key.startsWith("atlas:crm:")) {
          window.sessionStorage.removeItem(key);
        }
      }
      for (const key of Object.keys(window.localStorage)) {
        if (key.startsWith("atlas:contact:") || key.startsWith("atlas:chat:") || key.startsWith("atlas:crm:")) {
          window.localStorage.removeItem(key);
        }
      }
    } catch {
      // Storage may be unavailable in private browsing.
    }
  }
}
