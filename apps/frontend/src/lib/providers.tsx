"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { bindChatMessagesQueryClient } from "@/features/inbox/message-cache";
import { bindSensitiveQueryClient, clearRoleSensitiveClientCaches } from "@/lib/sensitive-cache";
import { useAuthStore } from "@/stores/auth-store";

/**
 * Registers client-side providers that need stable browser state.
 */
export function AppProviders({ children }: Readonly<{ children: React.ReactNode }>) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          refetchOnWindowFocus: false,
          retry: 1,
          staleTime: 30_000
        }
      }
    });
    bindChatMessagesQueryClient(client);
    bindSensitiveQueryClient(client);
    return client;
  });

  return (
    <QueryClientProvider client={queryClient}>
      <RoleSensitiveCacheGuard />
      {children}
    </QueryClientProvider>
  );
}

/**
 * Clears role-sensitive caches when the authenticated role changes or the session ends.
 */
function RoleSensitiveCacheGuard(): null {
  const role = useAuthStore((state) => state.user?.role ?? null);
  const previousRole = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (previousRole.current === undefined) {
      previousRole.current = role;
      return;
    }
    if (previousRole.current !== role) {
      clearRoleSensitiveClientCaches();
      previousRole.current = role;
    }
  }, [role]);

  return null;
}
