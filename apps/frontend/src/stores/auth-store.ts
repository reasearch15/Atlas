"use client";

import type { AuthUser } from "@atlas/shared";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { clearRoleSensitiveClientCaches } from "@/lib/sensitive-cache";

interface AuthState {
  readonly accessToken: string | null;
  readonly user: AuthUser | null;
  readonly setSession: (accessToken: string, user: AuthUser) => void;
  readonly clearSession: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      user: null,
      setSession: (accessToken, user) => {
        const previousRole = get().user?.role;
        if (previousRole && previousRole !== user.role) {
          clearRoleSensitiveClientCaches();
        }
        set({ accessToken, user });
      },
      clearSession: () => {
        clearRoleSensitiveClientCaches();
        set({ accessToken: null, user: null });
      }
    }),
    { name: "atlas-auth" }
  )
);
