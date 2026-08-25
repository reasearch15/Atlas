import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setSession = vi.fn();
const clearSession = vi.fn();
let authState: {
  accessToken: string | null;
  user: { id: string; email: string; name: string; role: "COADMIN" | "STAFF" | "PLATFORM_ADMIN"; workspaceId: string | null } | null;
} = {
  accessToken: null,
  user: null
};

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: {
    getState: () => ({
      accessToken: authState.accessToken,
      user: authState.user,
      setSession: (accessToken: string, user: typeof authState.user) => {
        authState = { accessToken, user };
        setSession(accessToken, user);
      },
      clearSession: () => {
        authState = { accessToken: null, user: null };
        clearSession();
      }
    }),
    persist: {
      hasHydrated: () => true,
      onFinishHydration: (callback: () => void) => {
        callback();
        return () => undefined;
      }
    }
  }
}));

vi.mock("@/lib/api", () => ({
  api: {
    staffMe: vi.fn(),
    coadminMe: vi.fn(),
    adminMe: vi.fn()
  }
}));

describe("ensureRoleAuthenticated handoff", () => {
  beforeEach(async () => {
    authState = { accessToken: null, user: null };
    setSession.mockClear();
    clearSession.mockClear();
    vi.stubGlobal("fetch", vi.fn());
    vi.resetModules();
    const { clearRoleAuthBootstrap } = await import("./auth-bootstrap");
    clearRoleAuthBootstrap();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves immediately after login marks the role ready (Staff soft-nav handoff)", async () => {
    const user = {
      id: "33333333-3333-4333-8333-333333333333",
      email: "staff@acme.local",
      name: "Acme Staff",
      role: "STAFF" as const,
      workspaceId: "22222222-2222-4222-8222-222222222222"
    };
    authState = { accessToken: "staff-access", user };
    const { markRoleAuthenticated, ensureRoleAuthenticated, isRoleAuthReady } = await import("./auth-bootstrap");
    const { api } = await import("./api");
    markRoleAuthenticated("STAFF");

    const result = await ensureRoleAuthenticated("STAFF");

    expect(isRoleAuthReady("STAFF")).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.user).toEqual(user);
    expect(api.staffMe).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not leave Staff bootstrap ready after clearRoleAuthBootstrap (logout)", async () => {
    const { markRoleAuthenticated, clearRoleAuthBootstrap, isRoleAuthReady } = await import("./auth-bootstrap");
    markRoleAuthenticated("STAFF");
    markRoleAuthenticated("COADMIN");
    clearRoleAuthBootstrap();
    expect(isRoleAuthReady("STAFF")).toBe(false);
    expect(isRoleAuthReady("COADMIN")).toBe(false);
  });

  it("exits loading with failure when cookie refresh and me validation both fail", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as Response);
    const { ensureRoleAuthenticated, isRoleAuthReady } = await import("./auth-bootstrap");

    const result = await ensureRoleAuthenticated("STAFF");

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/session expired/i);
    expect(isRoleAuthReady("STAFF")).toBe(false);
  });
});
